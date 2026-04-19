import {
	DelegationSchemaError,
	PhaseError,
	ProtocolError,
} from "../errors/concrete";
import { clock } from "../services/clock";
import { refreshLock } from "../services/lock";
import { resolveRetryDecision } from "../services/retry-resolver";
import type { PendingDelegationRecord, StateFile } from "../services/state-io";
import type { PhaseResult } from "../types/phase";
import type { DispatchContext, LoadedResults } from "./context";
import {
	emitFatalError,
	executeRetryBranch,
	handleDelegate,
	handleDone,
	handleFail,
	handleTransition,
} from "./dispatch-handlers";
import { buildPhaseIO, type PhaseIOGuards } from "./phase-io";

// Re-export for consumers that import from dispatch-loop (handle-resume, run-orchestrator).
export { emitFatalError, executeRetryBranch };

function deepFreeze<T>(obj: T): T {
	if (obj === null || typeof obj !== "object") return obj;
	if (Object.isFrozen(obj)) return obj;
	for (const key of Object.getOwnPropertyNames(obj)) {
		const value = (obj as Record<string, unknown>)[key];
		if (
			value !== null &&
			(typeof value === "object" || typeof value === "function")
		) {
			deepFreeze(value);
		}
	}
	return Object.freeze(obj);
}

export async function runDispatchLoop<S extends object>(
	ctx: DispatchContext<S>,
	initialState: StateFile<S>,
	initialInput: unknown,
	loadedResults?: LoadedResults,
): Promise<never> {
	let state = initialState;
	let input: unknown = initialInput;
	let currentLoadedResults = loadedResults;

	while (true) {
		const currentPhase = state.currentPhase;
		ctx.currentPhase = currentPhase;

		const phaseFn = ctx.config.phases[currentPhase];
		if (!phaseFn) {
			throw new ProtocolError(`unknown phase: ${currentPhase}`, {
				runId: ctx.runId,
				orchestratorName: ctx.config.name,
				phase: currentPhase,
			});
		}

		refreshLock(ctx.lockPath, ctx.handle, clock, ctx.logger, ctx.runId);

		const guards: PhaseIOGuards = {
			committed: { value: false },
			committedResult: { value: null },
			consumedCount: { value: 0 },
		};

		const pendingAtEntry = state.pendingDelegation;
		const isResumePhase =
			pendingAtEntry !== undefined &&
			currentLoadedResults !== undefined &&
			currentLoadedResults.label === pendingAtEntry.label;

		const frozenData = deepFreeze(
			structuredClone(state.data as unknown as Record<string, unknown>),
		) as unknown as S;

		const io = buildPhaseIO<S>({
			ctx,
			currentPhase,
			loadedResults: currentLoadedResults,
			pendingAtEntry,
			guards,
		});

		const attemptCount =
			pendingAtEntry?.attempt !== undefined ? pendingAtEntry.attempt + 1 : 1;
		ctx.logger.emit({
			eventType: "phase_start",
			runId: ctx.runId,
			phase: currentPhase,
			attemptCount,
			timestamp: clock.nowWallIso(),
		});

		const phaseStartMono = clock.nowMono();

		let result: PhaseResult<S>;
		try {
			const returned = (await phaseFn(
				frozenData,
				io,
				input as never,
			)) as PhaseResult<S>;
			if (!guards.committed.value || guards.committedResult.value === null) {
				throw new PhaseError(
					"phase returned without emitting a PhaseResult (must call io.transition/delegate*/done/fail)",
					{
						runId: ctx.runId,
						orchestratorName: ctx.config.name,
						phase: currentPhase,
					},
				);
			}
			result = (guards.committedResult.value ?? returned) as PhaseResult<S>;
		} catch (err) {
			if (
				err instanceof DelegationSchemaError &&
				pendingAtEntry !== undefined
			) {
				const decision = resolveRetryDecision(
					err,
					pendingAtEntry.attempt,
					pendingAtEntry.effectiveRetryPolicy,
				);
				if (decision.retry === true) {
					await executeRetryBranch(
						ctx,
						state,
						pendingAtEntry,
						decision,
						currentPhase,
					);
					return undefined as never;
				}
			}
			await emitFatalError(ctx, state, currentPhase, err);
			return undefined as never;
		}

		const phaseDurationMs = Math.round(clock.nowMono() - phaseStartMono);
		const newAccumulatedDurationMs =
			state.accumulatedDurationMs + phaseDurationMs;
		ctx.accumulatedDurationMs = newAccumulatedDurationMs;

		if (isResumePhase && pendingAtEntry !== undefined) {
			if (guards.consumedCount.value !== 1) {
				const msg =
					guards.consumedCount.value === 0
						? `unconsumed delegation: ${pendingAtEntry.label}`
						: `multiple consume calls on same delegation: ${pendingAtEntry.label}`;
				await emitFatalError(
					ctx,
					state,
					currentPhase,
					new ProtocolError(msg, {
						runId: ctx.runId,
						orchestratorName: ctx.config.name,
						phase: currentPhase,
					}),
				);
				return undefined as never;
			}
		}

		ctx.logger.emit({
			eventType: "phase_end",
			runId: ctx.runId,
			phase: currentPhase,
			durationMs: phaseDurationMs,
			resultKind: result.kind,
			timestamp: clock.nowWallIso(),
		});

		switch (result.kind) {
			case "transition": {
				const { pendingDelegation: _omitted, ...stateNoPending } =
					state as StateFile<S> & {
						pendingDelegation?: PendingDelegationRecord;
					};
				void _omitted;
				state = await handleTransition(
					ctx,
					stateNoPending as StateFile<S>,
					result,
					newAccumulatedDurationMs,
				);
				input = (result as { input?: unknown }).input;
				currentLoadedResults = undefined;
				ctx.phasesExecuted = state.phasesExecuted;
				continue;
			}
			case "delegate":
				await handleDelegate(ctx, state, result, newAccumulatedDurationMs);
				return undefined as never;
			case "done":
				await handleDone(ctx, state, result, newAccumulatedDurationMs);
				return undefined as never;
			case "fail":
				await handleFail(ctx, state, result, newAccumulatedDurationMs);
				return undefined as never;
		}
	}
}
