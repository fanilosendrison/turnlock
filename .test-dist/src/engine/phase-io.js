import { DelegationMissingResultError, DelegationSchemaError, ExternalResolutionMissingError, ExternalResolutionSchemaError, ProtocolError, } from "../errors/concrete.js";
import { clock } from "../services/clock.js";
import { summarizeZodError, validateResult } from "../services/validator.js";
import { assertExternalRequest } from "./external-request-validation.js";
import { refreshOwnershipFromContext } from "./state-commit.js";
export function buildPhaseIO(args) {
    const { ctx, currentPhase, loadedResults, pendingAtEntry, pendingExternalAtEntry, usedLabelsAtEntry, guards, } = args;
    function errorContext() {
        return {
            runId: ctx.runId,
            orchestratorName: ctx.config.name,
            phase: currentPhase,
        };
    }
    function guardCommitted() {
        if (guards.committed.value) {
            throw new ProtocolError("PhaseResult already committed", errorContext());
        }
    }
    function commit(result) {
        guards.committed.value = true;
        guards.committedResult.value = result;
        return result;
    }
    function assertPendingDelegation() {
        if (!pendingAtEntry) {
            if (pendingExternalAtEntry) {
                throw new ProtocolError("pending external request cannot be consumed as a delegation", errorContext());
            }
            throw new ProtocolError("no pending delegation to consume", errorContext());
        }
        return pendingAtEntry;
    }
    function assertPendingExternal() {
        if (!pendingExternalAtEntry) {
            if (pendingAtEntry) {
                throw new ProtocolError("pending delegation cannot be consumed as an external resolution", errorContext());
            }
            throw new ExternalResolutionMissingError("no pending external resolution to consume", errorContext());
        }
        return pendingExternalAtEntry;
    }
    function guardSingleConsume(label, subject) {
        if (guards.consumedCount.value >= 1) {
            throw new ProtocolError(`multiple consume calls on same ${subject}: ${label}`, errorContext());
        }
    }
    return {
        delegate(request, resumeAt, nextState) {
            guardCommitted();
            return commit({ kind: "delegate", request, resumeAt, nextState });
        },
        delegateBatch(request, resumeAt, nextState) {
            guardCommitted();
            return commit({ kind: "delegate", request, resumeAt, nextState });
        },
        requestExternal(request, resumeAt, nextState) {
            guardCommitted();
            assertExternalRequest(request, errorContext());
            if (!(resumeAt in ctx.config.phases)) {
                throw new ProtocolError(`unknown phase: ${resumeAt}`, errorContext());
            }
            if (usedLabelsAtEntry.includes(request.label)) {
                throw new ProtocolError("duplicate external request label", errorContext());
            }
            return commit({
                kind: "external-request",
                request,
                resumeAt,
                nextState,
            });
        },
        done(output) {
            guardCommitted();
            return commit({ kind: "done", output });
        },
        fail(error) {
            guardCommitted();
            return commit({ kind: "fail", error });
        },
        logger: ctx.logger,
        clock,
        runId: ctx.runId,
        args: process.argv.slice(2),
        runDir: ctx.runDir,
        signal: ctx.abortController.signal,
        consumePendingResult(schema) {
            const pd = assertPendingDelegation();
            if (pd.kind === "batch") {
                throw new ProtocolError("use consumePendingBatchResults for batch delegations", errorContext());
            }
            guardSingleConsume(pd.label, "delegation");
            if (!loadedResults ||
                loadedResults.kind !== "prompt" ||
                loadedResults.label !== pd.label) {
                throw new DelegationMissingResultError(`result file missing for ${pd.label}`, errorContext());
            }
            guards.consumedCount.value++;
            const validation = validateResult(loadedResults.data, schema);
            if (!validation.ok) {
                ctx.logger.emit({
                    eventType: "delegation_validation_failed",
                    runId: ctx.runId,
                    phase: currentPhase,
                    label: pd.label,
                    zodErrorSummary: summarizeZodError(validation.error),
                    timestamp: clock.nowWallIso(),
                });
                throw new DelegationSchemaError(`validation failed for ${pd.label}: ${summarizeZodError(validation.error)}`, { cause: validation.error, ...errorContext() });
            }
            ctx.logger.emit({
                eventType: "delegation_validated",
                runId: ctx.runId,
                phase: currentPhase,
                label: pd.label,
                timestamp: clock.nowWallIso(),
            });
            return validation.data;
        },
        consumePendingBatchResults(schema) {
            const pd = assertPendingDelegation();
            if (pd.kind !== "batch") {
                throw new ProtocolError("use consumePendingResult for single delegations", errorContext());
            }
            guardSingleConsume(pd.label, "delegation");
            if (!loadedResults ||
                loadedResults.kind !== "batch" ||
                loadedResults.label !== pd.label) {
                throw new DelegationMissingResultError(`result files missing for ${pd.label}`, errorContext());
            }
            guards.consumedCount.value++;
            const rawArray = loadedResults.data;
            const validated = [];
            for (const raw of rawArray) {
                const validation = validateResult(raw, schema);
                if (!validation.ok) {
                    ctx.logger.emit({
                        eventType: "delegation_validation_failed",
                        runId: ctx.runId,
                        phase: currentPhase,
                        label: pd.label,
                        zodErrorSummary: summarizeZodError(validation.error),
                        timestamp: clock.nowWallIso(),
                    });
                    throw new DelegationSchemaError(`validation failed for ${pd.label}: ${summarizeZodError(validation.error)}`, { cause: validation.error, ...errorContext() });
                }
                validated.push(validation.data);
            }
            ctx.logger.emit({
                eventType: "delegation_validated",
                runId: ctx.runId,
                phase: currentPhase,
                label: pd.label,
                timestamp: clock.nowWallIso(),
            });
            return validated;
        },
        consumePendingExternalResolution(schema) {
            const pending = assertPendingExternal();
            guardSingleConsume(pending.label, "external resolution");
            if (!loadedResults ||
                loadedResults.kind !== "external-request" ||
                loadedResults.label !== pending.label) {
                throw new ExternalResolutionMissingError("external resolution is not loaded", errorContext());
            }
            guards.consumedCount.value++;
            const validation = validateResult(loadedResults.data, schema);
            if (!validation.ok) {
                ctx.logger.emit({
                    eventType: "external_resolution_validation_failed",
                    runId: ctx.runId,
                    phase: currentPhase,
                    label: pending.label,
                    requestId: pending.requestId,
                    requestType: pending.requestType,
                    reason: "schema_invalid",
                    timestamp: clock.nowWallIso(),
                });
                throw new ExternalResolutionSchemaError("external resolution failed schema validation", { cause: validation.error, ...errorContext() });
            }
            ctx.logger.emit({
                eventType: "external_resolution_validated",
                runId: ctx.runId,
                phase: currentPhase,
                label: pending.label,
                requestId: pending.requestId,
                requestType: pending.requestType,
                timestamp: clock.nowWallIso(),
            });
            return validation.data;
        },
        refreshLock() {
            refreshOwnershipFromContext(ctx);
        },
    };
}
//# sourceMappingURL=phase-io.js.map