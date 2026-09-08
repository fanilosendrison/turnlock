import { existsSync } from "node:fs";
import { nodeSqliteDriver } from "../../../src/persistence/sqlite/node-sqlite-driver.js";
import { openRunDatabase } from "../../../src/persistence/sqlite/run-database.js";
import { CURRENT_SCHEMA_VERSION } from "../../../src/persistence/sqlite/schema.js";

function requiredArgument(index: number, label: string): string {
	const value = process.argv[index];
	if (value === undefined || value.length === 0) {
		throw new Error(`missing ${label}`);
	}
	return value;
}

const dbPath = requiredArgument(2, "database path");
const startSignalPath = requiredArgument(3, "start signal path");
const waitCell = new Int32Array(new SharedArrayBuffer(4));

while (!existsSync(startSignalPath)) {
	Atomics.wait(waitCell, 0, 0, 10);
}

const database = openRunDatabase({
	driver: nodeSqliteDriver,
	dbPath,
	busyTimeoutMs: 10_000,
});
try {
	const metadata = database.connection
		.prepare("SELECT schema_version FROM schema_metadata WHERE singleton = 1")
		.get<{ readonly schema_version: number }>();
	const retention = database.connection
		.prepare("SELECT retention_status FROM run_retention WHERE singleton = 1")
		.get<{ readonly retention_status: string }>();
	if (
		metadata?.schema_version !== CURRENT_SCHEMA_VERSION ||
		retention?.retention_status !== "ACTIVE"
	) {
		throw new Error("cold-start worker observed an incomplete schema");
	}
} finally {
	database.close();
}
