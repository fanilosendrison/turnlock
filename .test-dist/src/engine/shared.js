import * as path from "node:path";
import { batchBinding } from "../bindings/batch.js";
import { promptBinding } from "../bindings/prompt.js";
/**
 * Shared engine utilities extracted from dispatch-loop.ts and handle-resume.ts
 * to eliminate cross-file duplication.
 */
export function selectBinding(kind) {
    switch (kind) {
        case "prompt":
            return promptBinding;
        case "batch":
            return batchBinding;
    }
}
export function reconstructManifest(old, updates) {
    const base = {
        ...old,
        attempt: updates.attempt,
        emittedAt: updates.emittedAt,
        emittedAtEpochMs: updates.emittedAtEpochMs,
        deadlineAtEpochMs: updates.deadlineAtEpochMs,
    };
    if (old.kind === "prompt") {
        return {
            ...base,
            resultPath: path.join(updates.runDir, "results", `${updates.label}-${updates.attempt}.json`),
        };
    }
    return {
        ...base,
        jobs: (old.jobs ?? []).map((j) => ({
            ...j,
            resultPath: path.join(updates.runDir, "results", `${updates.label}-${updates.attempt}`, `${j.id}.json`),
        })),
    };
}
//# sourceMappingURL=shared.js.map