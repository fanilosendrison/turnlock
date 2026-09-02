// Retention race multiprocess worker — spawned by the retention cleanup
// race test.  Two modes:
//   --cleanup : run the full filesystem retirement flow (claim → verify →
//               rename → delete).
//   --resume  : attempt a real ownership takeover on the canonical DB.
// Prints a single JSON report line per process.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { nodeSqliteDriver } from "../../../src/persistence/sqlite/node-sqlite-driver.js";
import { acquireOwnership } from "../../../src/persistence/sqlite/ownership.js";
import { openRunDatabase } from "../../../src/persistence/sqlite/run-database.js";
import { retireRunDirectory } from "../../../src/services/run-retirement.js";

const DB_PATH = process.env.TL_DB_PATH;
const RUN_ID = process.env.TL_RUN_ID;
const ORCHESTRATOR_NAME = process.env.TL_ORCH;
const RUN_DIR = process.env.TL_RUN_DIR;
const MODE = process.argv.includes("--cleanup") ? "cleanup" : "resume";

function out(report: unknown): void {
	process.stdout.write(`${JSON.stringify(report)}\n`);
}

if (!DB_PATH || !RUN_ID || !ORCHESTRATOR_NAME || !RUN_DIR) {
	out({ mode: MODE, result: "BAD_ENV" });
	process.exit(99);
}

if (MODE === "cleanup") {
	const outcome = retireRunDirectory({
		driver: nodeSqliteDriver,
		runDir: RUN_DIR,
		runId: RUN_ID,
	});
	out({
		mode: MODE,
		outcome: outcome.kind,
		reason: outcome.kind === "KEPT" ? outcome.reason : undefined,
		canonicalExists: existsSync(RUN_DIR),
		retiredExists: existsSync(join(join(RUN_DIR, ".."), ".retired")),
	});
} else {
	try {
		const runDb = openRunDatabase({
			driver: nodeSqliteDriver,
			dbPath: DB_PATH,
			busyTimeoutMs: 500,
		});
		const now = Date.now();
		const result = acquireOwnership({
			db: runDb.connection,
			runId: RUN_ID,
			orchestratorName: ORCHESTRATOR_NAME,
			nowEpochMs: now,
			nowIso: new Date(now).toISOString(),
			leaseDurationMs: 30 * 60 * 1000,
			contentionDeadlineMs: 10000,
		});
		runDb.close();
		out({ mode: MODE, result: result.kind });
	} catch (error) {
		out({
			mode: MODE,
			result: "MISSING",
			reason: error instanceof Error ? error.message : String(error),
		});
	}
}
