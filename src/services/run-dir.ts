import * as fs from "node:fs";
import * as path from "node:path";
import { InvalidConfigError } from "../errors/concrete.js";

const DEFAULT_RUN_DIR_ROOT = path.join(".turnlock", "runs");
const RUN_DIR_ROOT_ENV_VAR = "TURNLOCK_RUN_DIR_ROOT";
function resolveRunDirRoot(cwd: string, configRoot?: string): string {
	const envRoot = process.env[RUN_DIR_ROOT_ENV_VAR];
	const root =
		envRoot !== undefined && envRoot !== ""
			? envRoot
			: configRoot !== undefined && configRoot !== ""
				? configRoot
				: DEFAULT_RUN_DIR_ROOT;
	return path.isAbsolute(root) ? root : path.join(cwd, root);
}
/** Protection decision for a retention deletion candidate.
 *
 *  `cleanupOldRuns` is destructive; it requires an explicit protection
 *  policy so that a RUN_DIR cannot be deleted without a caller-supplied
 *  decision about what keeps a run alive (e.g. a live SQLite ownership
 *  lease).  Policies must fail closed: returning `true` (or throwing) for
 *  any ambiguous state keeps the directory. */
export interface RunDirRetentionProtection {
	/**
	 * Decide whether a candidate RUN_DIR must be kept.
	 *
	 * @param runDir absolute path of the candidate directory
	 * @param runId the directory name (the run identifier)
	 * @param nowEpochMs the single cleanup-pass time boundary — the same
	 * value the retention threshold was computed from.  Lease liveness
	 * decisions must use this boundary, not an independent clock reading.
	 */
	readonly isRunProtected: (
		runDir: string,
		runId: string,
		nowEpochMs: number,
	) => boolean;
}
export function resolveRunDir(
	cwd: string,
	orchestratorName: string,
	runId: string,
	runDirRoot?: string,
): string {
	if (cwd === "") throw new InvalidConfigError("cwd cannot be empty");
	return path.join(resolveRunDirRoot(cwd, runDirRoot), orchestratorName, runId);
}
export function cleanupOldRuns(
	cwd: string,
	orchestratorName: string,
	retentionDays: number,
	currentRunId: string,
	protection: RunDirRetentionProtection,
	runDirRoot?: string,
): number {
	const baseDir = path.join(
		resolveRunDirRoot(cwd, runDirRoot),
		orchestratorName,
	);
	if (!fs.existsSync(baseDir)) return 0;
	const retentionMs = retentionDays * 24 * 60 * 60 * 1000;
	// Single time boundary for the whole pass: the retention threshold and
	// every protection decision share this one clock reading.
	const nowEpochMs = Date.now();
	const thresholdEpoch = nowEpochMs - retentionMs;
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
				if (protection.isRunProtected(runDir, entry.name, nowEpochMs)) {
					continue;
				}
			} catch {
				// A protection failure is an ambiguous state — fail closed
				// and keep the directory rather than delete it.
				continue;
			}
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
