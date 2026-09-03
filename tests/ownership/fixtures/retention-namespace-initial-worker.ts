// Retention namespace race worker — spawned by the post-verification
// namespace race test.
//
// Protocol:
//   - waits for the parent's GO file (synchronous bounded poll);
//   - then attempts the COMPLIANT INITIAL bootstrap of a NEW incarnation
//     for the same runId through the production orchestrator entry point;
//   - reports a JSON result to the result file:
//       { kind: "BOOTSTRAPPED", incarnationId, ownershipStatus,
//         leaseUntilEpochMs }
//       { kind: "FAILED", reason }
//   - after a successful bootstrap the worker parks inside the
//     afterBootstrapResult hook so the parent can observe the live HELD
//     ownership and then SIGKILL it (ownership stays HELD with a live
//     lease — exactly the state a crashed runtime leaves behind).
import { existsSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	type RunOrchestratorInternalDependencies,
	runOrchestratorInternal,
} from "../../../src/engine/run-orchestrator.js";
import { nodeSqliteDriver } from "../../../src/persistence/sqlite/node-sqlite-driver.js";
import { openRunDatabase } from "../../../src/persistence/sqlite/run-database.js";
import type { OrchestratorConfig } from "../../../src/types/config.js";

const RUN_ROOT = process.env.TL_RUN_ROOT;
const ORCHESTRATOR_NAME = process.env.TL_ORCH;
const RUN_ID = process.env.TL_RUN_ID;
const GO_FILE = process.env.TL_GO_FILE;
const RESULT_FILE = process.env.TL_RESULT_FILE;

function writeResult(result: unknown): void {
	if (!RESULT_FILE) return;
	const tmpPath = `${RESULT_FILE}.tmp-${process.pid}`;
	writeFileSync(tmpPath, JSON.stringify(result));
	renameSync(tmpPath, RESULT_FILE);
}

function fail(reason: string): never {
	writeResult({ kind: "FAILED", reason });
	process.exit(1);
}

/** Park the process forever so the parent can SIGKILL it while the
 *  bootstrapped ownership is still HELD with a live lease. */
function parkForever(): never {
	const sab = new Int32Array(new SharedArrayBuffer(4));
	for (;;) {
		Atomics.wait(sab, 0, 0, 60_000);
	}
}

if (!RUN_ROOT || !ORCHESTRATOR_NAME || !RUN_ID || !GO_FILE || !RESULT_FILE) {
	writeResult({ kind: "BAD_ENV" });
	process.exit(99);
}

// Wait for the parent's GO signal.
const waitSab = new Int32Array(new SharedArrayBuffer(4));
const goDeadline = Date.now() + 120_000;
while (!existsSync(GO_FILE)) {
	if (Date.now() > goDeadline) {
		fail("GO timeout while waiting for the test barrier");
	}
	Atomics.wait(waitSab, 0, 0, 50);
}

const config: OrchestratorConfig<{ stage: string }> = {
	name: ORCHESTRATOR_NAME,
	initial: "start",
	initialState: { stage: "fresh" },
	resumeCommand: (runId) => `node worker.mjs --run-id ${runId} --resume`,
	retentionDays: 7,
	runDirRoot: RUN_ROOT,
	phases: {
		start: async (_state, io) => io.done({ stage: "done" }),
	},
};

const dependencies: RunOrchestratorInternalDependencies = {
	hooks: {
		afterBootstrapResult: () => {
			// Read the freshly committed authority and report it, then park
			// so the parent kills us while the ownership stays live.
			try {
				const runDb = openRunDatabase({
					driver: nodeSqliteDriver,
					dbPath: join(RUN_ROOT, ORCHESTRATOR_NAME, RUN_ID, "turnlock.sqlite3"),
					busyTimeoutMs: 2000,
				});
				try {
					const incarnation = runDb.connection
						.prepare(
							"SELECT incarnation_id FROM run_incarnation WHERE singleton = 1",
						)
						.get() as
						| {
								incarnation_id: string;
						  }
						| undefined;
					const ownership = runDb.connection
						.prepare(
							"SELECT ownership_status, lease_until_epoch_ms FROM run_ownership WHERE singleton = 1",
						)
						.get() as
						| {
								ownership_status: string;
								lease_until_epoch_ms: number | null;
						  }
						| undefined;
					writeResult({
						kind: "BOOTSTRAPPED",
						incarnationId: incarnation?.incarnation_id ?? null,
						ownershipStatus: ownership?.ownership_status ?? null,
						leaseUntilEpochMs: ownership?.lease_until_epoch_ms ?? null,
					});
				} finally {
					runDb.close();
				}
			} catch (err) {
				fail(
					`after bootstrap inspection failed: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
			parkForever();
		},
	},
};

try {
	await runOrchestratorInternal(
		config,
		{ resume: false, runId: RUN_ID, rest: [] },
		dependencies,
	);
} catch (err) {
	fail(err instanceof Error ? err.message : String(err));
}
// Should never be reached — afterBootstrapResult parks forever.
fail("orchestrator returned without a bootstrap result");
