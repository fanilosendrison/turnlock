import * as fs from "node:fs";
import * as path from "node:path";
import { InvalidConfigError } from "../errors/concrete.js";
import type { RunRetentionClaimResult } from "../persistence/sqlite/retention-claim.js";

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
/** Durable deletion authorization for retention candidates.
 *
 *  `cleanupOldRuns` is destructive; it never deletes on a read-only
 *  observation.  A caller must supply a claim delegate that atomically
 *  obtains a durable, irreversible deletion authorization in the same
 *  authority that publishes ownership (see `claimRunForRetentionDeletion`).
 *  Deletion is only performed for CLAIMED / ALREADY_RETIRING; every other
 *  result — or a throwing delegate — keeps the directory (fail-closed). */
export interface RunDirRetentionClaim {
	/**
	 * Atomically claim the candidate RUN_DIR for retention deletion.
	 *
	 * @param runDir absolute path of the candidate directory
	 * @param runId the directory name (the run identifier)
	 */
	readonly claimRunForDeletion: (
		runDir: string,
		runId: string,
	) => RunRetentionClaimResult;
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
	claim: RunDirRetentionClaim,
	runDirRoot?: string,
): number {
	const baseDir = path.join(
		resolveRunDirRoot(cwd, runDirRoot),
		orchestratorName,
	);
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
			// Destructive permission is a durable, atomically-coordinated
			// claim — never a read-then-delete observation.
			let claimResult: RunRetentionClaimResult;
			try {
				claimResult = claim.claimRunForDeletion(runDir, entry.name);
			} catch {
				// A claim failure is an ambiguous state — fail closed and
				// keep the directory rather than delete it.
				continue;
			}
			if (
				claimResult.kind !== "CLAIMED" &&
				claimResult.kind !== "ALREADY_RETIRING"
			) {
				continue;
			}
			try {
				fs.rmSync(runDir, { recursive: true, force: true });
				deleted++;
			} catch {
				// The retirement claim stays committed (irreversible): the
				// run remains non-resumable and a future cleanup retries
				// the deletion.  Never reactivate a partially deleted run.
			}
		}
	}
	return deleted;
}
