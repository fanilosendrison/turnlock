import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
export function makeTempDir(prefix = "turnlock-test-") {
    return mkdtempSync(join(tmpdir(), prefix));
}
export function cleanupTempDir(path) {
    try {
        rmSync(path, { recursive: true, force: true });
    }
    catch {
        // best-effort
    }
}
export async function withTempRunDir(orchestratorName, runId, fn) {
    const base = makeTempDir();
    const runDir = join(base, ".turnlock", "runs", orchestratorName, runId);
    try {
        await fn(runDir);
    }
    finally {
        cleanupTempDir(base);
    }
}
//# sourceMappingURL=temp-run-dir.js.map