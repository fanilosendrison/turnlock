import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { nodeSqliteDriver } from "../../src/persistence/sqlite/node-sqlite-driver.js";
import { openRunDatabase } from "../../src/persistence/sqlite/run-database.js";
import { CURRENT_SCHEMA_VERSION } from "../../src/persistence/sqlite/schema.js";
import type {
	SqliteConnection,
	SqliteDriver,
} from "../../src/persistence/sqlite/sqlite-driver.js";
import { spawnNode } from "../helpers/node-subprocess.js";
import { cleanupTempDir, makeTempDir } from "../helpers/temp-run-dir.js";

const WORKER_COUNT = 8;

function schemaTableCount(dbPath: string): number {
	const connection = nodeSqliteDriver.open(dbPath);
	try {
		const row = connection
			.prepare(
				"SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
			)
			.get<{ readonly count: number }>();
		return row?.count ?? 0;
	} finally {
		connection.close();
	}
}

function driverThatFailsAfterSchemaDdl(): SqliteDriver {
	return {
		openReadOnly: (path: string) => nodeSqliteDriver.openReadOnly(path),
		open(path: string): SqliteConnection {
			const connection = nodeSqliteDriver.open(path);
			return {
				exec(sql: string): void {
					connection.exec(sql);
					if (sql.includes("CREATE TABLE IF NOT EXISTS schema_metadata")) {
						throw new Error("injected failure after schema DDL");
					}
				},
				prepare: (sql: string) => connection.prepare(sql),
				close: () => connection.close(),
			};
		},
	};
}

describe("atomic cold-start schema initialization", () => {
	test("rolls back every schema table when initialization fails after DDL", () => {
		const directory = makeTempDir();
		const dbPath = join(directory, "faulted.sqlite3");
		try {
			assert.throws(
				() =>
					openRunDatabase({
						driver: driverThatFailsAfterSchemaDdl(),
						dbPath,
						busyTimeoutMs: 1_000,
					}),
				/injected failure after schema DDL/u,
			);
			assert.strictEqual(schemaTableCount(dbPath), 0);

			const reopened = openRunDatabase({
				driver: nodeSqliteDriver,
				dbPath,
				busyTimeoutMs: 1_000,
			});
			reopened.close();
			assert.ok(schemaTableCount(dbPath) > 0);
		} finally {
			cleanupTempDir(directory);
		}
	});

	test("concurrent processes initialize one complete schema on a nonexistent database", async () => {
		const directory = makeTempDir();
		const dbPath = join(directory, "concurrent.sqlite3");
		const startSignalPath = join(directory, "start");
		const workerPath = join(
			import.meta.dirname,
			"fixtures",
			"cold-start-worker.js",
		);
		try {
			assert.strictEqual(existsSync(dbPath), false);
			const workers = Array.from({ length: WORKER_COUNT }, () =>
				spawnNode(workerPath, [dbPath, startSignalPath]),
			);
			writeFileSync(startSignalPath, "start", { flag: "wx" });
			const results = await Promise.all(
				workers.map(async (worker) => ({
					exitCode: await worker.exited,
					stdout: await worker.stdout,
					stderr: await worker.stderr,
				})),
			);
			assert.deepStrictEqual(
				results.map(({ exitCode }) => exitCode),
				Array.from({ length: WORKER_COUNT }, () => 0),
				JSON.stringify(results),
			);

			const database = openRunDatabase({
				driver: nodeSqliteDriver,
				dbPath,
				busyTimeoutMs: 1_000,
			});
			try {
				const integrity = database.connection
					.prepare("PRAGMA integrity_check")
					.get<{ readonly integrity_check: string }>();
				const metadataRows = database.connection
					.prepare(
						"SELECT schema_version FROM schema_metadata WHERE singleton = 1",
					)
					.all<{ readonly schema_version: number }>();
				const retentionRows = database.connection
					.prepare(
						"SELECT retention_status FROM run_retention WHERE singleton = 1",
					)
					.all<{ readonly retention_status: string }>();
				const lifecycleRows = database.connection
					.prepare("SELECT lifecycle_status FROM run_workflow_lifecycle")
					.all<{ readonly lifecycle_status: string }>();
				assert.strictEqual(integrity?.integrity_check, "ok");
				assert.deepStrictEqual(
					metadataRows.map(({ schema_version }) => schema_version),
					[CURRENT_SCHEMA_VERSION],
				);
				assert.deepStrictEqual(
					retentionRows.map(({ retention_status }) => retention_status),
					["ACTIVE"],
				);
				assert.deepStrictEqual(lifecycleRows, []);
			} finally {
				database.close();
			}
		} finally {
			cleanupTempDir(directory);
		}
	});
});
