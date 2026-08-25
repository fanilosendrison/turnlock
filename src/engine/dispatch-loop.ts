import {
	DelegationSchemaError,
	PhaseError,
	ProtocolError,
} from "../errors/concrete.ts";
import { clock } from "../services/clock.ts";
import { refreshLock } from "../services/lock.ts";
import { resolveRetryDecision } from "../services/retry-resolver.ts";
import type { StateFile } from "../services/state-io.ts";
import type { PhaseResult } from "../types/phase.ts";
import type { DispatchContext, LoadedResults } from "./context.ts";
import { handleDelegate } from "./delegate-handler.ts";
import { reemitDelegationAttempt } from "./delegation-reemit.ts";
import { buildPhaseIO, type PhaseIOGuards } from "./phase-io.ts";
import { emitFatalError, handleDone, handleFail } from "./terminal-handlers.ts";

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
	state: StateFile<S>,
	loadedResults?: LoadedResults,
): Promise<never> {
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
		loadedResults !== undefined &&
		loadedResults.label === pendingAtEntry.label;

	const frozenData = deepFreeze(
		structuredClone(state.data as unknown as Record<string, unknown>),
	) as unknown as S;

	const io = buildPhaseIO<S>({
		ctx,
		currentPhase,
		loadedResults,
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
		const returned = (await phaseFn(frozenData, io)) as PhaseResult<S>;
		if (!guards.committed.value || guards.committedResult.value === null) {
			throw new PhaseError(
				"phase returned without emitting a PhaseResult (must call io.delegate/delegateBatch/done/fail)",
				{
					runId: ctx.runId,
					orchestratorName: ctx.config.name,
					phase: currentPhase,
				},
			);
		}
		result = (guards.committedResult.value ?? returned) as PhaseResult<S>;
	} catch (err) {
		if (err instanceof DelegationSchemaError && pendingAtEntry !== undefined) {
			const decision = resolveRetryDecision(
				err,
				pendingAtEntry.attempt,
				pendingAtEntry.effectiveRetryPolicy,
			);
			if (decision.retry === true) {
				await reemitDelegationAttempt(
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
	ctx.phasesExecuted = state.phasesExecuted + 1;

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

	const resultKind = (result as { readonly kind?: unknown }).kind;
	if (
		resultKind !== "delegate" &&
		resultKind !== "done" &&
		resultKind !== "fail"
	) {
		await emitFatalError(
			ctx,
			state,
			currentPhase,
			new ProtocolError(`unknown PhaseResult kind: ${String(resultKind)}`, {
				runId: ctx.runId,
				orchestratorName: ctx.config.name,
				phase: currentPhase,
			}),
		);
		return undefined as never;
	}

	ctx.logger.emit({
		eventType: "phase_end",
		runId: ctx.runId,
		phase: currentPhase,
		durationMs: phaseDurationMs,
		resultKind,
		timestamp: clock.nowWallIso(),
	});

	switch (resultKind) {
		case "delegate":
			await handleDelegate(
				ctx,
				state,
				result as Extract<PhaseResult<S>, { readonly kind: "delegate" }>,
				newAccumulatedDurationMs,
			);
			return undefined as never;
		case "done":
			await handleDone(
				ctx,
				state,
				result as Extract<PhaseResult<S>, { readonly kind: "done" }>,
				newAccumulatedDurationMs,
			);
			return undefined as never;
		case "fail":
			await handleFail(
				ctx,
				state,
				result as Extract<PhaseResult<S>, { readonly kind: "fail" }>,
				newAccumulatedDurationMs,
			);
			return undefined as never;
	}
}
