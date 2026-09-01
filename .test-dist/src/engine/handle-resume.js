import * as fs from "node:fs";
import * as path from "node:path";
import { DelegationMissingResultError, DelegationSchemaError, DelegationTimeoutError, IndeterminatePhaseExecutionError, InitialDispatchAlreadyClaimedError, ProtocolError, } from "../errors/concrete.js";
import { readAndVerifyArtifact } from "../services/artifact-store.js";
import { clock } from "../services/clock.js";
import { writeProtocolBlock } from "../services/protocol.js";
import { resolveRetryDecision } from "../services/retry-resolver.js";
import { doExit } from "./context.js";
import { reemitDelegationAttempt } from "./delegation-reemit.js";
import { runDispatchLoop } from "./dispatch-loop.js";
import { runExternalRequestResume } from "./external-request-resume.js";
import { writeProtocolStdout } from "./protocol-stdout.js";
import { claimInitialDispatchWithProjection, projectCanonicalArtifactFenced, releaseOwnershipFromContext, } from "./state-commit.js";
import { emitFatalError } from "./terminal-handlers.js";
function buildExpectedResultPaths(runDir, pd) {
    if (pd.kind === "prompt") {
        return [path.join(runDir, "results", `${pd.label}-${pd.attempt}.json`)];
    }
    const batchDir = path.join(runDir, "results", `${pd.label}-${pd.attempt}`);
    return (pd.jobIds ?? []).map((id) => path.join(batchDir, `${id}.json`));
}
function classifyResultFiles(runDir, pd) {
    const paths = buildExpectedResultPaths(runDir, pd);
    let allPresent = true;
    let anyMalformed = false;
    const parsedValues = [];
    for (const p of paths) {
        if (!fs.existsSync(p)) {
            allPresent = false;
            continue;
        }
        let raw;
        try {
            raw = fs.readFileSync(p, "utf-8");
        }
        catch {
            anyMalformed = true;
            continue;
        }
        try {
            parsedValues.push(JSON.parse(raw));
        }
        catch {
            anyMalformed = true;
        }
    }
    const allParseable = allPresent && !anyMalformed && parsedValues.length === paths.length;
    return {
        allPresent,
        allParseable,
        anyMalformed,
        loadedData: allParseable
            ? pd.kind === "batch"
                ? parsedValues
                : (parsedValues[0] ?? null)
            : null,
    };
}
function findFirstMalformedPath(runDir, pd) {
    const paths = buildExpectedResultPaths(runDir, pd);
    for (const p of paths) {
        if (!fs.existsSync(p))
            continue;
        try {
            JSON.parse(fs.readFileSync(p, "utf-8"));
        }
        catch {
            return p;
        }
    }
    return null;
}
function safeFileSize(p) {
    try {
        return fs.statSync(p).size;
    }
    catch {
        return -1;
    }
}
async function recoverTerminalState(ctx, state, terminalResult) {
    const outputPath = path.join(ctx.runDir, "output.json");
    // Reconstruct output.json from the immutable blob if missing or invalid.
    let needReconstruct = false;
    try {
        const existing = fs.readFileSync(outputPath);
        const authoritativeBytes = readAndVerifyArtifact(ctx.runDir, terminalResult.outputArtifact);
        // Compare full content, not just size — same-size but different
        // content must be treated as corruption.
        if (!Buffer.from(authoritativeBytes).equals(existing)) {
            needReconstruct = true;
        }
    }
    catch {
        needReconstruct = true;
    }
    if (needReconstruct) {
        try {
            projectCanonicalArtifactFenced(ctx, {
                pointer: "/terminalResult/outputArtifact",
                artifact: terminalResult.outputArtifact,
            }, outputPath);
        }
        catch (err) {
            await emitFatalError(ctx, state, state.currentPhase, err);
            return undefined;
        }
    }
    // Re-emit the DONE protocol block (idempotent — the parent may have
    // already seen it, but we re-emit for safety).
    ctx.logger.emit({
        eventType: "orchestrator_end",
        runId: ctx.runId,
        orchestratorName: ctx.config.name,
        success: true,
        durationMs: state.accumulatedDurationMs,
        phasesExecuted: state.phasesExecuted,
        timestamp: clock.nowWallIso(),
    });
    const block = writeProtocolBlock("DONE", {
        runId: ctx.runId,
        orchestrator: ctx.config.name,
        output: outputPath,
        success: true,
        phasesExecuted: state.phasesExecuted,
        durationMs: state.accumulatedDurationMs,
    });
    writeProtocolStdout(block);
    releaseOwnershipFromContext(ctx);
    doExit(0);
}
async function handleDelegationError(ctx, state, pd, kind, message) {
    const ErrClass = kind === "delegation_timeout"
        ? DelegationTimeoutError
        : DelegationSchemaError;
    const err = new ErrClass(message, {
        runId: ctx.runId,
        orchestratorName: ctx.config.name,
        phase: pd.resumeAt,
    });
    if (kind === "delegation_schema") {
        const malformedPath = findFirstMalformedPath(ctx.runDir, pd);
        if (malformedPath) {
            const sizeBytes = safeFileSize(malformedPath);
            ctx.logger.emit({
                eventType: "delegation_validation_failed",
                runId: ctx.runId,
                phase: pd.resumeAt,
                label: pd.label,
                zodErrorSummary: `malformed JSON (path=${malformedPath}, fileSizeBytes=${sizeBytes})`.slice(0, 200),
                timestamp: clock.nowWallIso(),
            });
        }
    }
    const decision = resolveRetryDecision(err, pd.attempt, pd.effectiveRetryPolicy);
    if (decision.retry === true) {
        await reemitDelegationAttempt(ctx, state, pd, decision, pd.resumeAt, "aborted during resume retry sleep");
        return undefined;
    }
    await emitFatalError(ctx, state, state.currentPhase, err);
    return undefined;
}
async function enterDispatchLoopWithResults(ctx, state, pd, loadedData) {
    const jobCount = pd.jobIds?.length ?? 1;
    const filesLoaded = Array.isArray(loadedData) ? loadedData.length : 1;
    ctx.logger.emit({
        eventType: "delegation_result_read",
        runId: ctx.runId,
        phase: pd.resumeAt,
        label: pd.label,
        jobCount,
        filesLoaded,
        timestamp: clock.nowWallIso(),
    });
    const stateForDispatch = {
        ...state,
        currentPhase: pd.resumeAt,
    };
    await runDispatchLoop(ctx, stateForDispatch, {
        label: pd.label,
        kind: pd.kind,
        data: loadedData,
    }, async (error) => {
        if (!(error instanceof DelegationSchemaError))
            return false;
        const decision = resolveRetryDecision(error, pd.attempt, pd.effectiveRetryPolicy);
        if (decision.retry !== true)
            return false;
        await reemitDelegationAttempt(ctx, stateForDispatch, pd, decision, pd.resumeAt);
        return true;
    });
    return undefined;
}
export async function runHandleResume(ctx, state, pendingInitialDispatch = false) {
    // Terminal recovery: if the previous run committed a terminal result but
    // crashed before projecting output.json or emitting the protocol block,
    // reconstruct from the immutable blob now.
    if (state.terminalResult !== undefined) {
        await recoverTerminalState(ctx, state, state.terminalResult);
        return undefined;
    }
    const pendingExternalRequest = state.pendingExternalRequest;
    if (pendingExternalRequest) {
        await runExternalRequestResume(ctx, state, pendingExternalRequest);
        return undefined;
    }
    const pd = state.pendingDelegation;
    if (!pd) {
        const isPristineBootstrap = pendingInitialDispatch &&
            ctx.stateRevision === "0" &&
            state.phasesExecuted === 0 &&
            state.accumulatedDurationMs === 0 &&
            state.usedLabels.length === 0 &&
            state.pendingExternalRequest === undefined &&
            state.terminalResult === undefined;
        if (isPristineBootstrap) {
            // Claim the one-time bootstrap authorization before invoking the
            // phase. A crash after this durable transition is intentionally
            // fail-closed rather than replaying an indeterminate direct effect.
            claimInitialDispatchWithProjection(ctx);
            await runDispatchLoop(ctx, state);
            return undefined;
        }
        if (!pendingInitialDispatch && state.phasesExecuted === 0) {
            throw new InitialDispatchAlreadyClaimedError("Initial dispatch was already claimed but the phase crashed before producing a delegation or terminal result — replay is intentionally forbidden", {
                runId: ctx.runId,
                orchestratorName: ctx.config.name,
                phase: state.currentPhase,
            });
        }
        throw new IndeterminatePhaseExecutionError("Resume found no pending delegation and the state cannot be deterministically resumed — the phase may have partially executed", {
            runId: ctx.runId,
            orchestratorName: ctx.config.name,
            phase: state.currentPhase,
        });
    }
    const classification = classifyResultFiles(ctx.runDir, pd);
    const nowEpoch = clock.nowEpochMs();
    const deadlinePassed = nowEpoch > pd.deadlineAtEpochMs;
    if (classification.allParseable) {
        await enterDispatchLoopWithResults(ctx, state, pd, classification.loadedData);
        return undefined;
    }
    if (classification.anyMalformed) {
        await handleDelegationError(ctx, state, pd, "delegation_schema", "malformed JSON in result file");
        return undefined;
    }
    if (!classification.allPresent && deadlinePassed) {
        await handleDelegationError(ctx, state, pd, "delegation_timeout", `deadline passed for ${pd.label}`);
        return undefined;
    }
    if (!classification.allPresent && !deadlinePassed) {
        await emitFatalError(ctx, state, pd.resumeAt, new DelegationMissingResultError(`result file missing for ${pd.label} (deadline not passed)`, {
            runId: ctx.runId,
            orchestratorName: ctx.config.name,
            phase: pd.resumeAt,
        }));
        return undefined;
    }
    throw new ProtocolError("classification inconsistent", {
        runId: ctx.runId,
        orchestratorName: ctx.config.name,
        phase: pd.resumeAt,
    });
}
//# sourceMappingURL=handle-resume.js.map