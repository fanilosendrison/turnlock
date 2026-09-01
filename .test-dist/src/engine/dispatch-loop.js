import { PhaseError, ProtocolError } from "../errors/concrete.js";
import { clock } from "../services/clock.js";
import { handleDelegate } from "./delegate-handler.js";
import { handleExternalRequest } from "./external-request-handler.js";
import { buildPhaseIO } from "./phase-io.js";
import { refreshOwnershipFromContext } from "./state-commit.js";
import { emitFatalError, handleDone, handleFail } from "./terminal-handlers.js";
function deepFreeze(obj) {
    if (obj === null || typeof obj !== "object")
        return obj;
    if (Object.isFrozen(obj))
        return obj;
    for (const key of Object.getOwnPropertyNames(obj)) {
        const value = obj[key];
        if (value !== null &&
            (typeof value === "object" || typeof value === "function")) {
            deepFreeze(value);
        }
    }
    return Object.freeze(obj);
}
export async function runDispatchLoop(ctx, state, loadedResults, phaseErrorHandler) {
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
    refreshOwnershipFromContext(ctx);
    const guards = {
        committed: { value: false },
        committedResult: { value: null },
        consumedCount: { value: 0 },
    };
    const pendingAtEntry = state.pendingDelegation;
    const pendingExternalAtEntry = state.pendingExternalRequest;
    const pendingLabel = pendingAtEntry?.label ?? pendingExternalAtEntry?.label;
    const isResumePhase = pendingLabel !== undefined &&
        loadedResults !== undefined &&
        loadedResults.label === pendingLabel;
    const frozenData = deepFreeze(structuredClone(state.data));
    const io = buildPhaseIO({
        ctx,
        currentPhase,
        loadedResults,
        pendingAtEntry,
        pendingExternalAtEntry,
        usedLabelsAtEntry: state.usedLabels,
        guards,
    });
    const attemptCount = pendingAtEntry?.attempt !== undefined ? pendingAtEntry.attempt + 1 : 1;
    ctx.logger.emit({
        eventType: "phase_start",
        runId: ctx.runId,
        phase: currentPhase,
        attemptCount,
        timestamp: clock.nowWallIso(),
    });
    const phaseStartMono = clock.nowMono();
    let result;
    try {
        const returned = (await phaseFn(frozenData, io));
        if (!guards.committed.value || guards.committedResult.value === null) {
            throw new PhaseError("phase returned without emitting a PhaseResult (must call io.delegate/delegateBatch/requestExternal/done/fail)", {
                runId: ctx.runId,
                orchestratorName: ctx.config.name,
                phase: currentPhase,
            });
        }
        result = (guards.committedResult.value ?? returned);
    }
    catch (err) {
        if (phaseErrorHandler !== undefined && (await phaseErrorHandler(err))) {
            return undefined;
        }
        await emitFatalError(ctx, state, currentPhase, err);
        return undefined;
    }
    const phaseDurationMs = Math.round(clock.nowMono() - phaseStartMono);
    const newAccumulatedDurationMs = state.accumulatedDurationMs + phaseDurationMs;
    ctx.accumulatedDurationMs = newAccumulatedDurationMs;
    ctx.phasesExecuted = state.phasesExecuted + 1;
    if (isResumePhase && pendingLabel !== undefined) {
        if (guards.consumedCount.value !== 1) {
            const subject = pendingExternalAtEntry !== undefined
                ? "external resolution"
                : "delegation";
            const msg = guards.consumedCount.value === 0
                ? `unconsumed ${subject}: ${pendingLabel}`
                : `multiple consume calls on same ${subject}: ${pendingLabel}`;
            await emitFatalError(ctx, state, currentPhase, new ProtocolError(msg, {
                runId: ctx.runId,
                orchestratorName: ctx.config.name,
                phase: currentPhase,
            }));
            return undefined;
        }
    }
    const resultKind = result.kind;
    if (resultKind !== "delegate" &&
        resultKind !== "external-request" &&
        resultKind !== "done" &&
        resultKind !== "fail") {
        await emitFatalError(ctx, state, currentPhase, new ProtocolError(`unknown PhaseResult kind: ${String(resultKind)}`, {
            runId: ctx.runId,
            orchestratorName: ctx.config.name,
            phase: currentPhase,
        }));
        return undefined;
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
            await handleDelegate(ctx, state, result, newAccumulatedDurationMs);
            return undefined;
        case "external-request":
            await handleExternalRequest(ctx, state, result, newAccumulatedDurationMs);
            return undefined;
        case "done":
            await handleDone(ctx, state, result, newAccumulatedDurationMs);
            return undefined;
        case "fail":
            await handleFail(ctx, state, result, newAccumulatedDurationMs);
            return undefined;
    }
}
//# sourceMappingURL=dispatch-loop.js.map