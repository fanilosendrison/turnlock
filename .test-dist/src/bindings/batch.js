import * as path from "node:path";
import { InvalidConfigError } from "../errors/concrete.js";
import { writeProtocolBlock } from "../services/protocol.js";
import { MANIFEST_VERSION } from "./types.js";
export const batchBinding = {
    kind: "batch",
    buildManifest(request, context) {
        if (request.jobs.length === 0) {
            throw new InvalidConfigError(`batch delegation '${request.label}' has no jobs`);
        }
        const batchDir = path.join(context.runDir, "results", `${request.label}-${context.attempt}`);
        const jobs = request.jobs.map((job) => ({
            id: job.id,
            prompt: job.prompt,
            resultPath: path.join(batchDir, `${job.id}.json`),
        }));
        return {
            manifestVersion: MANIFEST_VERSION,
            runId: context.runId,
            orchestratorName: context.orchestratorName,
            phase: context.phase,
            resumeAt: context.resumeAt,
            label: request.label,
            kind: "batch",
            emittedAt: context.emittedAt,
            emittedAtEpochMs: context.emittedAtEpochMs,
            timeoutMs: context.timeoutMs,
            deadlineAtEpochMs: context.deadlineAtEpochMs,
            attempt: context.attempt,
            maxAttempts: context.maxAttempts,
            ...(request.worker !== undefined ? { worker: request.worker } : {}),
            jobs,
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
//# sourceMappingURL=batch.js.map