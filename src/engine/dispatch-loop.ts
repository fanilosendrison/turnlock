import { PhaseError, ProtocolError } from "../errors/concrete";
import { clock } from "../services/clock";
import { refreshLock } from "../services/lock";
import type { StateFile } from "../services/state-io";
import type { PhaseResult } from "../types/phase";
import type { DispatchContext, LoadedResults } from "./context";
import { handleDelegate } from "./delegate-handler";
import { handleExternalRequest } from "./external-request-handler";
import { buildPhaseIO, type PhaseIOGuards } from "./phase-io";
import { emitFatalError, handleDone, handleFail } from "./terminal-handlers";

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

export type PhaseErrorHandler = (error: unknown) => Promise<boolean>;

export async function runDispatchLoop<S extends object>(
	ctx: DispatchContext<S>,
	state: StateFile<S>,
	loadedResults?: LoadedResults,
	phaseErrorHandler?: PhaseErrorHandler,
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
	const pendingExternalAtEntry = state.pendingExternalRequest;
	const pendingLabel = pendingAtEntry?.label ?? pendingExternalAtEntry?.label;
	const isResumePhase =
		pendingLabel !== undefined &&
		loadedResults !== undefined &&
		loadedResults.label === pendingLabel;

	const frozenData = deepFreeze(
		structuredClone(state.data as unknown as Record<string, unknown>),
	) as unknown as S;

	const io = buildPhaseIO<S>({
		ctx,
		currentPhase,
		loadedResults,
		pendingAtEntry,
		pendingExternalAtEntry,
		usedLabelsAtEntry: state.usedLabels,
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
				"phase returned without emitting a PhaseResult (must call io.delegate/delegateBatch/requestExternal/done/fail)",
				{
					runId: ctx.runId,
					orchestratorName: ctx.config.name,
					phase: currentPhase,
				},
			);
		}
		result = (guards.committedResult.value ?? returned) as PhaseResult<S>;
	} catch (err) {
		if (phaseErrorHandler !== undefined && (await phaseErrorHandler(err))) {
			return undefined as never;
		}
		await emitFatalError(ctx, state, currentPhase, err);
		return undefined as never;
	}

	const phaseDurationMs = Math.round(clock.nowMono() - phaseStartMono);
	const newAccumulatedDurationMs =
		state.accumulatedDurationMs + phaseDurationMs;
	ctx.accumulatedDurationMs = newAccumulatedDurationMs;
	ctx.phasesExecuted = state.phasesExecuted + 1;

	if (isResumePhase && pendingLabel !== undefined) {
		if (guards.consumedCount.value !== 1) {
			const subject =
				pendingExternalAtEntry !== undefined
					? "external resolution"
					: "delegation";
			const msg =
				guards.consumedCount.value === 0
					? `unconsumed ${subject}: ${pendingLabel}`
					: `multiple consume calls on same ${subject}: ${pendingLabel}`;
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
		resultKind !== "external-request" &&
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
		case "external-request":
			await handleExternalRequest(
				ctx,
				state,
				result as Extract<
					PhaseResult<S>,
					{ readonly kind: "external-request" }
				>,
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
