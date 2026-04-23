import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function makeTempDir(prefix = "turnlock-test-"): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

export function cleanupTempDir(path: string): void {
	try {
		rmSync(path, { recursive: true, force: true });
	} catch {
		// best-effort
	}
}

export async function withTempRunDir(
	orchestratorName: string,
	runId: string,
	fn: (runDir: string) => Promise<void>,
): Promise<void> {
	const base = makeTempDir();
	const runDir = join(base, ".turnlock", "runs", orchestratorName, runId);
	try {
		await fn(runDir);
	} finally {
		cleanupTempDir(base);
	}
}
