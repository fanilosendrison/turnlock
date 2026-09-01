import * as path from "node:path";
import { DEFAULT_BACKOFF_BASE_MS, DEFAULT_MAX_ATTEMPTS, DEFAULT_MAX_BACKOFF_MS, DEFAULT_TIMEOUT_MS, } from "../constants.js";
import { InvalidConfigError, ProtocolError } from "../errors/concrete.js";
import { installPreparedArtifact, prepareJsonArtifact, } from "../services/artifact-store.js";
import { clock } from "../services/clock.js";
import { doExit } from "./context.js";
import { clearPendingYield } from "./pending-yield.js";
import { writeProtocolStdout } from "./protocol-stdout.js";
import { selectBinding } from "./shared.js";
import { commitStateWithProjection, projectCanonicalArtifactFenced, releaseOwnershipFromContext, } from "./state-commit.js";
export async function handleDelegate(ctx, state, result, accumulatedDurationMs) {
    const request = result.request;
    const { label, kind } = request;
    const { resumeAt } = result;
    if (!(resumeAt in ctx.config.phases)) {
        throw new ProtocolError(`unknown phase: ${resumeAt}`, {
            runId: ctx.runId,
            orchestratorName: ctx.config.name,
            phase: state.currentPhase,
        });
    }
    if (!/^[a-z][a-z0-9-]*$/.test(label)) {
        throw new ProtocolError(`invalid label format: ${label}`, {
            runId: ctx.runId,
            orchestratorName: ctx.config.name,
            phase: state.currentPhase,
        });
    }
    if (state.usedLabels.includes(label)) {
        throw new ProtocolError(`duplicate label: ${label}`, {
            runId: ctx.runId,
            orchestratorName: ctx.config.name,
            phase: state.currentPhase,
        });
    }
    if (kind === "batch") {
        const req = request;
        if (req.jobs.length === 0) {
            throw new InvalidConfigError(`batch delegation '${label}' has no jobs`);
        }
        const ids = new Set();
        for (const job of req.jobs) {
            if (ids.has(job.id)) {
                throw new ProtocolError(`duplicate job id in batch: ${job.id}`, {
                    runId: ctx.runId,
                    orchestratorName: ctx.config.name,
                    phase: state.currentPhase,
                });
            }
            ids.add(job.id);
        }
    }
    const effectiveRetryPolicy = {
        maxAttempts: request.retry?.maxAttempts ??
            ctx.config.retry?.maxAttempts ??
            DEFAULT_MAX_ATTEMPTS,
        backoffBaseMs: request.retry?.backoffBaseMs ??
            ctx.config.retry?.backoffBaseMs ??
            DEFAULT_BACKOFF_BASE_MS,
        maxBackoffMs: request.retry?.maxBackoffMs ??
            ctx.config.retry?.maxBackoffMs ??
            DEFAULT_MAX_BACKOFF_MS,
    };
    const timeoutMs = request.timeout?.perDelegationMs ??
        ctx.config.timeout?.perDelegationMs ??
        DEFAULT_TIMEOUT_MS;
    const emittedAtEpochMs = clock.nowEpochMs();
    const emittedAt = clock.nowWallIso();
    const deadlineAtEpochMs = emittedAtEpochMs + timeoutMs;
    const attempt = 0;
    const binding = selectBinding(kind);
    const manifestContext = {
        runId: ctx.runId,
        orchestratorName: ctx.config.name,
        phase: state.currentPhase,
        resumeAt,
        attempt,
        maxAttempts: effectiveRetryPolicy.maxAttempts,
        emittedAt,
        emittedAtEpochMs,
        timeoutMs,
        deadlineAtEpochMs,
        runDir: ctx.runDir,
    };
    const manifest = binding.buildManifest(request, manifestContext);
    // 1. Prepare immutable artifact.
    const prepared = prepareJsonArtifact(ctx.runDir, "delegation-manifest", manifest);
    // 2. Install immutable blob (may be orphaned if commit fails — acceptable).
    installPreparedArtifact(ctx.runDir, prepared);
    // 3. Build pending delegation record with ArtifactRef.
    const pendingDelegation = {
        label,
        kind,
        resumeAt,
        manifestArtifact: prepared.ref,
        emittedAtEpochMs,
        deadlineAtEpochMs,
        attempt,
        effectiveRetryPolicy,
        ...(kind === "batch"
            ? {
                jobIds: request.jobs.map((j) => j.id),
            }
            : {}),
    };
    const newState = {
        ...clearPendingYield(state),
        data: result.nextState,
        phasesExecuted: state.phasesExecuted + 1,
        lastTransitionAt: emittedAt,
        lastTransitionAtEpochMs: emittedAtEpochMs,
        accumulatedDurationMs,
        pendingDelegation,
        usedLabels: [...state.usedLabels, label],
    };
    // 4. Commit fenced.
    commitStateWithProjection(ctx, newState);
    // 5. Project canonical manifest (fenced).  Must happen before events
    //    so a crash after commit but before projection is recoverable.
    const canonicalManifestPath = path.join(ctx.runDir, "delegations", `${label}-${attempt}.json`);
    projectCanonicalArtifactFenced(ctx, {
        pointer: "/pendingDelegation/manifestArtifact",
        artifact: prepared.ref,
    }, canonicalManifestPath);
    // 6. Events + protocol only after successful commit AND projection.
    ctx.logger.emit({
        eventType: "delegation_emit",
        runId: ctx.runId,
        phase: state.currentPhase,
        label,
        kind,
        jobCount: kind === "batch" ? request.jobs.length : 1,
        timestamp: emittedAt,
    });
    const resumeCmd = ctx.config.resumeCommand(ctx.runId);
    const block = binding.buildProtocolBlock(manifest, canonicalManifestPath, resumeCmd);
    writeProtocolStdout(block);
    releaseOwnershipFromContext(ctx);
    doExit(0);
}
//# sourceMappingURL=delegate-handler.js.map