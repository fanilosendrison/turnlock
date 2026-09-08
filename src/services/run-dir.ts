import * as fs from "node:fs";
import * as path from "node:path";
import { InvalidConfigError } from "../errors/concrete.js";
import { RUN_NAMESPACE_DIR_NAME } from "./run-namespace-mutex.js";
import type {
	RunDirRetirement,
	RunRetirementOutcome,
} from "./run-retirement-contracts.js";
import { RETIRED_DIR_NAME } from "./run-retirement-layout.js";

export type { RunDirRetirement } from "./run-retirement-contracts.js";

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
	retirement: RunDirRetirement,
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
		// The retirement area and namespace-mutex sidecars are never run
		// candidates.  Sidecars are intentionally retained: unlinking a
		// mutex while another process has an open handle would let a new
		// inode bypass that handle and break serialization.
		if (entry.name === RETIRED_DIR_NAME) continue;
		if (entry.name === RUN_NAMESPACE_DIR_NAME) continue;
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
			let outcome: RunRetirementOutcome;
			try {
				outcome = retirement.retireRunDirectory(
					runDir,
					entry.name,
					orchestratorName,
				);
			} catch {
				// A retirement failure is an ambiguous state — fail closed
				// and keep the directory rather than delete it.
				continue;
			}
			if (outcome.kind === "DELETED") deleted++;
		}
	}
	// Crash recovery: finish deletions of incarnations that already
	// crossed the irreversible retirement frontier (renamed but not yet
	// deleted, or partially deleted).
	const retiredRoot = path.join(baseDir, RETIRED_DIR_NAME);
	try {
		deleted += retirement.sweepRetiredDirectories(
			retiredRoot,
			orchestratorName,
		);
	} catch {
		// best-effort — the sweep retries on the next cleanup
	}
	return deleted;
}
