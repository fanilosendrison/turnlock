// TL-F-001 multiprocess contender — spawned by the ownership contention test.
// Uses SQLite-based ownership (acquireOwnership) instead of the old file lock.
import { nodeSqliteDriver } from "../../../src/persistence/sqlite/node-sqlite-driver.js";
import { acquireOwnership } from "../../../src/persistence/sqlite/ownership.js";
import { openRunDatabase } from "../../../src/persistence/sqlite/run-database.js";

const DB_PATH = process.env.TL_DB_PATH;
const ID = process.env.TL_CONTENDER_ID;
if (!DB_PATH || !ID) {
	process.stderr.write("TL_DB_PATH and TL_CONTENDER_ID required\n");
	process.exit(99);
}
// The parent test creates the DB and seeds the incarnation + ownership rows.
// Each contender opens the DB read-write and attempts acquireOwnership.
const runDb = openRunDatabase({
	driver: nodeSqliteDriver,
	dbPath: DB_PATH,
	busyTimeoutMs: 500,
});
let outcome: string;
let ownerToken: string | undefined;
let fenceToken: string | undefined;
try {
	const result = acquireOwnership({
		db: runDb.connection,
		runId: "contention",
		orchestratorName: "contention-test",
		nowEpochMs: 1000000000000,
		nowIso: "2001-09-09T01:46:40.000Z",
		leaseDurationMs: 30 * 60 * 1000,
		contentionDeadlineMs: 5000,
	});
	outcome = result.kind;
	if (result.kind === "ACQUIRED") {
		ownerToken = result.handle.ownerToken;
		fenceToken = String(result.handle.fenceToken);
	}
} catch (err) {
	outcome = `ERROR:${String(err).slice(0, 100)}`;
} finally {
	runDb.close();
}
process.stdout.write(
	`${JSON.stringify({ id: ID, outcome, ownerToken, fenceToken })}\n`,
);
