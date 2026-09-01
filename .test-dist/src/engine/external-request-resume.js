import * as fs from "node:fs";
import * as path from "node:path";
import { externalRequestBinding, isExternalRequestManifest, } from "../bindings/external-request.js";
import { ExternalResolutionMalformedError, StateCorruptedError, } from "../errors/concrete.js";
import { readAndVerifyArtifact } from "../services/artifact-store.js";
import { clock } from "../services/clock.js";
import { contentDigest } from "../services/content-digest.js";
import { installImmutableFileAtomic, readRegularFileBytes, } from "../services/immutable-file.js";
import { doExit } from "./context.js";
import { runDispatchLoop } from "./dispatch-loop.js";
import { writeProtocolStdout } from "./protocol-stdout.js";
import { commitStateWithProjection, releaseOwnershipFromContext, } from "./state-commit.js";
import { emitFatalError } from "./terminal-handlers.js";
function isMissingFileError(error) {
    return error.code === "ENOENT";
}
function acceptedResolutionPath(ctx, pending) {
    return path.join(ctx.runDir, "accepted-external-resolutions", `${pending.label}.json`);
}
function assertConfinedDirectory(ctx, directoryName) {
    try {
        const realRunDir = fs.realpathSync(ctx.runDir);
        const realDirectory = fs.realpathSync(path.join(ctx.runDir, directoryName));
        if (realDirectory !== path.join(realRunDir, directoryName)) {
            throw new StateCorruptedError("external request directory escapes the run directory");
        }
    }
    catch (error) {
        if (error instanceof StateCorruptedError)
            throw error;
        throw new StateCorruptedError("external request directories are unavailable", { cause: error });
    }
}
function assertConfinedPaths(ctx, pending) {
    const expectedResultPath = path.join(ctx.runDir, "external-results", `${pending.label}.json`);
    const expectedAcceptedResolutionPath = acceptedResolutionPath(ctx, pending);
    if (pending.resultPath !== expectedResultPath ||
        (pending.acceptedResolutionPath !== undefined &&
            pending.acceptedResolutionPath !== expectedAcceptedResolutionPath)) {
        throw new StateCorruptedError("external request paths are invalid");
    }
    assertConfinedDirectory(ctx, "accepted-external-resolutions");
}
function readStoredManifest(ctx, pending, originPhase) {
    if (!pending.manifestArtifact) {
        throw new StateCorruptedError("external request has no manifest artifact", {
            runId: ctx.runId,
            orchestratorName: ctx.config.name,
            phase: pending.resumeAt,
        });
    }
    const raw = readAndVerifyArtifact(ctx.runDir, pending.manifestArtifact);
    let parsed;
    try {
        parsed = JSON.parse(Buffer.from(raw).toString("utf-8"));
    }
    catch (error) {
        throw new StateCorruptedError("external request manifest is malformed", {
            cause: error,
            runId: ctx.runId,
            orchestratorName: ctx.config.name,
            phase: pending.resumeAt,
        });
    }
    if (!isExternalRequestManifest(parsed) ||
        parsed.runId !== ctx.runId ||
        parsed.orchestratorName !== ctx.config.name ||
        parsed.phase !== originPhase ||
        parsed.requestId !== pending.requestId ||
        parsed.label !== pending.label ||
        parsed.requestType !== pending.requestType ||
        parsed.resumeAt !== pending.resumeAt ||
        parsed.resultPath !== pending.resultPath ||
        parsed.emittedAt !== pending.emittedAt ||
        parsed.emittedAtEpochMs !== pending.emittedAtEpochMs) {
        throw new StateCorruptedError("external request manifest does not match pending state", {
            runId: ctx.runId,
            orchestratorName: ctx.config.name,
            phase: pending.resumeAt,
        });
    }
    return parsed;
}
async function failMalformedResolution(ctx, state, pending, reason, cause) {
    ctx.logger.emit({
        eventType: "external_resolution_validation_failed",
        runId: ctx.runId,
        phase: pending.resumeAt,
        label: pending.label,
        requestId: pending.requestId,
        requestType: pending.requestType,
        reason,
        timestamp: clock.nowWallIso(),
    });
    await emitFatalError(ctx, state, pending.resumeAt, new ExternalResolutionMalformedError(reason === "unreadable"
        ? "external resolution is unreadable"
        : "external resolution contains malformed JSON", {
        cause,
        runId: ctx.runId,
        orchestratorName: ctx.config.name,
        phase: pending.resumeAt,
    }));
    return undefined;
}
async function reemitExternalRequest(ctx, state, pending, manifest) {
    const canonicalManifestPath = path.join(ctx.runDir, "external-requests", `${pending.label}.json`);
    let block;
    try {
        block = externalRequestBinding.buildProtocolBlock(manifest, canonicalManifestPath, ctx.config.resumeCommand(ctx.runId));
    }
    catch (error) {
        await emitFatalError(ctx, state, pending.resumeAt, error);
        return undefined;
    }
    ctx.logger.emit({
        eventType: "external_request_reemit",
        runId: ctx.runId,
        phase: state.currentPhase,
        label: pending.label,
        requestId: pending.requestId,
        requestType: pending.requestType,
        timestamp: clock.nowWallIso(),
    });
    writeProtocolStdout(block);
    releaseOwnershipFromContext(ctx);
    doExit(0);
}
function parseAcceptedResolution(raw, context) {
    try {
        return JSON.parse(raw.toString("utf-8"));
    }
    catch (error) {
        throw new StateCorruptedError("accepted external resolution is malformed", {
            cause: error,
            ...context,
        });
    }
}
function readAcceptedResolution(acceptedPath, expectedDigest, context) {
    let raw;
    try {
        raw = readRegularFileBytes(acceptedPath);
    }
    catch (error) {
        throw new StateCorruptedError("accepted external resolution is unavailable", { cause: error, ...context });
    }
    const digest = contentDigest(raw);
    if (expectedDigest !== undefined && digest !== expectedDigest) {
        throw new StateCorruptedError("accepted external resolution digest does not match pending state", context);
    }
    return { raw, digest, data: parseAcceptedResolution(raw, context) };
}
function emitResolutionRead(ctx, pending) {
    ctx.logger.emit({
        eventType: "external_resolution_read",
        runId: ctx.runId,
        phase: pending.resumeAt,
        label: pending.label,
        requestId: pending.requestId,
        requestType: pending.requestType,
        timestamp: clock.nowWallIso(),
    });
}
async function enterDispatchLoopWithAcceptedResolution(ctx, state, pending, resolution) {
    emitResolutionRead(ctx, pending);
    const stateForDispatch = {
        ...state,
        currentPhase: pending.resumeAt,
    };
    await runDispatchLoop(ctx, stateForDispatch, {
        label: pending.label,
        kind: "external-request",
        data: resolution,
    });
    return undefined;
}
export async function runExternalRequestResume(ctx, state, pending) {
    let manifest;
    try {
        assertConfinedPaths(ctx, pending);
        manifest = readStoredManifest(ctx, pending, state.currentPhase);
    }
    catch (error) {
        await emitFatalError(ctx, state, pending.resumeAt, error);
        return undefined;
    }
    const errorContext = {
        runId: ctx.runId,
        orchestratorName: ctx.config.name,
        phase: pending.resumeAt,
    };
    const expectedAcceptedPath = acceptedResolutionPath(ctx, pending);
    if (pending.acceptedResolutionPath !== undefined &&
        pending.acceptedResolutionDigest !== undefined) {
        let accepted;
        try {
            accepted = readAcceptedResolution(pending.acceptedResolutionPath, pending.acceptedResolutionDigest, errorContext);
        }
        catch (error) {
            await emitFatalError(ctx, state, pending.resumeAt, error);
            return undefined;
        }
        await enterDispatchLoopWithAcceptedResolution(ctx, state, pending, accepted.data);
        return undefined;
    }
    let accepted = null;
    try {
        accepted = readAcceptedResolution(expectedAcceptedPath, undefined, errorContext);
    }
    catch (error) {
        if (!(error instanceof StateCorruptedError && isMissingFileError(error.cause))) {
            await emitFatalError(ctx, state, pending.resumeAt, error);
            return undefined;
        }
    }
    if (accepted === null) {
        try {
            assertConfinedDirectory(ctx, "external-results");
        }
        catch (error) {
            await emitFatalError(ctx, state, pending.resumeAt, error);
            return undefined;
        }
        let candidateRaw;
        try {
            candidateRaw = readRegularFileBytes(pending.resultPath);
        }
        catch (error) {
            if (isMissingFileError(error)) {
                await reemitExternalRequest(ctx, state, pending, manifest);
                return undefined;
            }
            await failMalformedResolution(ctx, state, pending, "unreadable", error);
            return undefined;
        }
        try {
            JSON.parse(candidateRaw.toString("utf-8"));
        }
        catch (error) {
            emitResolutionRead(ctx, pending);
            await failMalformedResolution(ctx, state, pending, "malformed_json", error);
            return undefined;
        }
        try {
            installImmutableFileAtomic(expectedAcceptedPath, candidateRaw);
            accepted = readAcceptedResolution(expectedAcceptedPath, undefined, errorContext);
        }
        catch (error) {
            await emitFatalError(ctx, state, pending.resumeAt, error instanceof StateCorruptedError
                ? error
                : new StateCorruptedError("failed to preserve accepted external resolution", { cause: error, ...errorContext }));
            return undefined;
        }
    }
    const acceptedPending = {
        ...pending,
        acceptedResolutionPath: expectedAcceptedPath,
        acceptedResolutionDigest: accepted.digest,
        acceptedAt: clock.nowWallIso(),
    };
    const stateWithAcceptedResolution = {
        ...state,
        pendingExternalRequest: acceptedPending,
    };
    try {
        commitStateWithProjection(ctx, stateWithAcceptedResolution);
    }
    catch (error) {
        await emitFatalError(ctx, state, pending.resumeAt, error);
        return undefined;
    }
    await enterDispatchLoopWithAcceptedResolution(ctx, stateWithAcceptedResolution, acceptedPending, accepted.data);
    return undefined;
}
//# sourceMappingURL=external-request-resume.js.map