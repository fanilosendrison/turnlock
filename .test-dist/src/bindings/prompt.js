import * as path from "node:path";
import { writeProtocolBlock } from "../services/protocol.js";
import { MANIFEST_VERSION } from "./types.js";
export const promptBinding = {
    kind: "prompt",
    buildManifest(request, context) {
        const resultPath = path.join(context.runDir, "results", `${request.label}-${context.attempt}.json`);
        return {
            manifestVersion: MANIFEST_VERSION,
            runId: context.runId,
            orchestratorName: context.orchestratorName,
            phase: context.phase,
            resumeAt: context.resumeAt,
            label: request.label,
            kind: "prompt",
            emittedAt: context.emittedAt,
            emittedAtEpochMs: context.emittedAtEpochMs,
            timeoutMs: context.timeoutMs,
            deadlineAtEpochMs: context.deadlineAtEpochMs,
            attempt: context.attempt,
            maxAttempts: context.maxAttempts,
            ...(request.worker !== undefined ? { worker: request.worker } : {}),
            prompt: request.prompt,
            resultPath,
        };
    },
    buildProtocolBlock(manifest, manifestPath, resumeCmd) {
        return writeProtocolBlock("DELEGATE", {
            runId: manifest.runId,
            orchestrator: manifest.orchestratorName,
            manifest: manifestPath,
            kind: manifest.kind,
            resumeCmd,
        });
    },
};
//# sourceMappingURL=prompt.js.map