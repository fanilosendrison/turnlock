// Retention namespace cleanup worker — spawned by the 3-process and
// two-cleanup namespace tests.
//
// Protocol:
//   - waits for the parent's GO file (synchronous bounded poll);
//   - then runs the PRODUCTION retirement flow (retireRunDirectory) for
//     the target canonical RUN_DIR;
//   - writes a JSON result to the result file:
//       { kind: "DELETED" | "KEPT", reason?, canonicalExists }
import { existsSync, renameSync, writeFileSync } from "node:fs";
import { nodeSqliteDriver } from "../../../src/persistence/sqlite/node-sqlite-driver.js";
import { retireRunDirectory } from "../../../src/services/run-retirement.js";

const RUN_DIR = process.env.TL_RUN_DIR;
const RUN_ID = process.env.TL_RUN_ID;
const ORCHESTRATOR_NAME = process.env.TL_ORCH;
const GO_FILE = process.env.TL_GO_FILE;
const RESULT_FILE = process.env.TL_RESULT_FILE;

function writeResult(result: unknown): void {
	if (!RESULT_FILE) return;
	const tmpPath = `${RESULT_FILE}.tmp-${process.pid}`;
	writeFileSync(tmpPath, JSON.stringify(result));
	renameSync(tmpPath, RESULT_FILE);
}

if (!RUN_DIR || !RUN_ID || !ORCHESTRATOR_NAME || !GO_FILE || !RESULT_FILE) {
	writeResult({ kind: "BAD_ENV" });
	process.exit(99);
}

// Wait for the parent's GO signal.
const waitSab = new Int32Array(new SharedArrayBuffer(4));
const goDeadline = Date.now() + 120_000;
while (!existsSync(GO_FILE)) {
	if (Date.now() > goDeadline) {
		writeResult({ kind: "FAILED", reason: "GO timeout" });
		process.exit(1);
	}
	Atomics.wait(waitSab, 0, 0, 50);
}

const outcome = retireRunDirectory({
	driver: nodeSqliteDriver,
	runDir: RUN_DIR,
	runId: RUN_ID,
	orchestratorName: ORCHESTRATOR_NAME,
});
writeResult({
	kind: outcome.kind,
	reason: outcome.kind === "KEPT" ? outcome.reason : undefined,
	canonicalExists: existsSync(RUN_DIR),
});
