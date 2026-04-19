import * as fs from "node:fs";
import * as path from "node:path";
import { InvalidConfigError } from "../errors/concrete";

export function resolveRunDir(
	cwd: string,
	orchestratorName: string,
	runId: string,
): string {
	if (cwd === "") throw new InvalidConfigError("cwd cannot be empty");
	return path.join(cwd, ".claude", "run", "cc-orch", orchestratorName, runId);
}

export function cleanupOldRuns(
	cwd: string,
	orchestratorName: string,
	retentionDays: number,
	currentRunId: string,
): number {
	const baseDir = path.join(cwd, ".claude", "run", "cc-orch", orchestratorName);
	if (!fs.existsSync(baseDir)) return 0;

	const retentionMs = retentionDays * 24 * 60 * 60 * 1000;
	const thresholdEpoch = Date.now() - retentionMs;

	let deleted = 0;
	const entries = fs.readdirSync(baseDir, { withFileTypes: true });
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		if (entry.name === currentRunId) continue;

		const runDir = path.join(baseDir, entry.name);
		let stat: fs.Stats;
		try {
			stat = fs.statSync(runDir);
		} catch {
			continue;
		}

		if (stat.mtimeMs < thresholdEpoch) {
			try {
				fs.rmSync(runDir, { recursive: true, force: true });
				deleted++;
			} catch {
				// best-effort
			}
		}
	}
	return deleted;
}
