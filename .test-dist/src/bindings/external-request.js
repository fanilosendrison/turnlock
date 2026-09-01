import * as path from "node:path";
import { EXTERNAL_REQUEST_MANIFEST_VERSION } from "../constants.js";
import { isJsonValue } from "../services/json-value.js";
import { writeProtocolBlock } from "../services/protocol.js";
function buildManifest(request, context) {
    return {
        manifestVersion: EXTERNAL_REQUEST_MANIFEST_VERSION,
        kind: "external-request",
        requestId: `${context.runId}/${request.label}`,
        runId: context.runId,
        orchestratorName: context.orchestratorName,
        phase: context.phase,
        resumeAt: context.resumeAt,
        label: request.label,
        requestType: request.requestType,
        payload: request.payload,
        ...(request.metadata !== undefined ? { metadata: request.metadata } : {}),
        emittedAt: context.emittedAt,
        emittedAtEpochMs: context.emittedAtEpochMs,
        resultPath: path.join(context.runDir, "external-results", `${request.label}.json`),
    };
}
export function isExternalRequestManifest(value) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return false;
    }
    const manifest = value;
    return (manifest.manifestVersion === EXTERNAL_REQUEST_MANIFEST_VERSION &&
        manifest.kind === "external-request" &&
        typeof manifest.requestId === "string" &&
        typeof manifest.runId === "string" &&
        typeof manifest.orchestratorName === "string" &&
        typeof manifest.phase === "string" &&
        typeof manifest.resumeAt === "string" &&
        typeof manifest.label === "string" &&
        manifest.requestId === `${manifest.runId}/${manifest.label}` &&
        typeof manifest.requestType === "string" &&
        isJsonValue(manifest.payload) &&
        (manifest.metadata === undefined || isJsonValue(manifest.metadata)) &&
        typeof manifest.emittedAt === "string" &&
        typeof manifest.emittedAtEpochMs === "number" &&
        Number.isFinite(manifest.emittedAtEpochMs) &&
        typeof manifest.resultPath === "string");
}
function buildProtocolBlock(manifest, manifestPath, resumeCmd) {
    return writeProtocolBlock("REQUEST_EXTERNAL", {
        runId: manifest.runId,
        orchestrator: manifest.orchestratorName,
        requestId: manifest.requestId,
        requestType: manifest.requestType,
        manifest: manifestPath,
        result: manifest.resultPath,
        resumeCmd,
    });
}
export const externalRequestBinding = {
    buildManifest,
    buildProtocolBlock,
};
//# sourceMappingURL=external-request.js.map