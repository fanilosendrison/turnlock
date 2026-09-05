import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { nodeSqliteDriver } from "../../src/persistence/sqlite/node-sqlite-driver.js";
import { openRunDatabase } from "../../src/persistence/sqlite/run-database.js";
import { CURRENT_SCHEMA_VERSION } from "../../src/persistence/sqlite/schema.js";
import type {
	SqliteConnection,
	SqliteDriver,
} from "../../src/persistence/sqlite/sqlite-driver.js";
import { cleanupTempDir, makeTempDir } from "../helpers/temp-run-dir.js";

describe("node-sqlite driver", () => {
	test("opens an in-memory database", () => {
		const db = nodeSqliteDriver.open(":memory:");
		try {
			const row = db.prepare("SELECT 1 AS n").get() as
				| {
						n: number;
				  }
				| undefined;
			assert.strictEqual(row?.n, 1);
		} finally {
			db.close();
		}
	});
	test("creates and reads back a file-based database", () => {
		const dir = makeTempDir();
		const dbPath = join(dir, "test.sqlite3");
		try {
			const db = nodeSqliteDriver.open(dbPath);
			db.exec("CREATE TABLE IF NOT EXISTS t (x INTEGER)");
			db.prepare("INSERT INTO t (x) VALUES (?)").run(42);
			const row = db.prepare("SELECT x FROM t").get() as
				| {
						x: number;
				  }
				| undefined;
			assert.strictEqual(row?.x, 42);
			db.close();
			assert.strictEqual(existsSync(dbPath), true);
		} finally {
			cleanupTempDir(dir);
		}
	});
	test("statement.run returns changes count", () => {
		const db = nodeSqliteDriver.open(":memory:");
		try {
			db.exec("CREATE TABLE t (x INTEGER)");
			const stmt = db.prepare("INSERT INTO t (x) VALUES (?)");
			const r1 = stmt.run(1);
			assert.strictEqual(r1.changes, 1);
			const r2 = stmt.run(2);
			assert.strictEqual(r2.changes, 1);
			db.close();
		} finally {
			// fine if already closed
		}
	});
});
describe("run-database", () => {
	test("initializes schema metadata on first open", () => {
		const dir = makeTempDir();
		const dbPath = join(dir, "test-run.sqlite3");
		try {
			const runDb = openRunDatabase({
				driver: nodeSqliteDriver,
				dbPath,
				busyTimeoutMs: 500,
			});
			const row = runDb.connection
				.prepare(
					"SELECT schema_version FROM schema_metadata WHERE singleton = 1",
				)
				.get() as
				| {
						schema_version: number;
				  }
				| undefined;
			assert.strictEqual(row?.schema_version, CURRENT_SCHEMA_VERSION);
			runDb.close();
		} finally {
			cleanupTempDir(dir);
		}
	});
	test("installs busy_timeout before WAL can contend", () => {
		const executed: string[] = [];
		let closed = false;
		const connection: SqliteConnection = {
			exec: (sql) => {
				executed.push(sql);
			},
			prepare: (sql: string) => ({
				run: () => ({ changes: 1 }),
				get: <T>() => {
					if (sql.includes("run_retention")) {
						return {
							retention_status: "ACTIVE",
							retirement_token: null,
							retirement_claimed_at_epoch_ms: null,
						} as T;
					}
					return { schema_version: CURRENT_SCHEMA_VERSION } as T;
				},
				all: <T>() => [] as T[],
			}),
			close: () => {
				closed = true;
			},
		};
		const driver: SqliteDriver = {
			open: () => connection,
			openReadOnly: () => connection,
		};
		const runDb = openRunDatabase({
			driver,
			dbPath: "ignored.sqlite3",
			busyTimeoutMs: 321,
		});
		assert.strictEqual(executed[0], "PRAGMA busy_timeout = 321");
		assert.strictEqual(executed[1], "PRAGMA journal_mode = WAL");
		runDb.close();
		assert.strictEqual(closed, true);
	});
	test("WAL and synchronous pragmas are set", () => {
		const dir = makeTempDir();
		const dbPath = join(dir, "test-pragmas.sqlite3");
		try {
			const runDb = openRunDatabase({
				driver: nodeSqliteDriver,
				dbPath,
				busyTimeoutMs: 500,
			});
			const jm = runDb.connection.prepare("PRAGMA journal_mode").get() as
				| {
						journal_mode: string;
				  }
				| undefined;
			const sync = runDb.connection.prepare("PRAGMA synchronous").get() as
				| {
						synchronous: number;
				  }
				| undefined;
			assert.strictEqual(jm?.journal_mode, "wal");
			assert.strictEqual(sync?.synchronous, 2); // FULL = 2
			runDb.close();
		} finally {
			cleanupTempDir(dir);
		}
	});
});

describe("openReadOnly", () => {
	test("missing database → open fails and the file is never created", () => {
		const dir = makeTempDir();
		const dbPath = join(dir, "missing.sqlite3");
		try {
			assert.strictEqual(existsSync(dbPath), false);
			assert.throws(() => nodeSqliteDriver.openReadOnly(dbPath));
			assert.strictEqual(
				existsSync(dbPath),
				false,
				"read-only open must never create the database file",
			);
		} finally {
			cleanupTempDir(dir);
		}
	});

	test("reads an existing database and refuses mutations", () => {
		const dir = makeTempDir();
		const dbPath = join(dir, "test.sqlite3");
		try {
			const writable = nodeSqliteDriver.open(dbPath);
			writable.exec("CREATE TABLE t (x INTEGER)");
			writable.prepare("INSERT INTO t (x) VALUES (?) ").run(7);
			writable.close();
			const readOnly = nodeSqliteDriver.openReadOnly(dbPath);
			try {
				const row = readOnly.prepare("SELECT x FROM t").get() as
					| {
							x: number;
					  }
					| undefined;
				assert.strictEqual(row?.x, 7);
				assert.throws(() =>
					readOnly.prepare("INSERT INTO t (x) VALUES (8)").run(),
				);
			} finally {
				readOnly.close();
			}
			// The database content is unchanged.
			const probe = nodeSqliteDriver.openReadOnly(dbPath);
			try {
				const count = probe.prepare("SELECT COUNT(*) AS n FROM t").get() as
					| { n: number }
					| undefined;
				assert.strictEqual(count?.n, 1);
			} finally {
				probe.close();
			}
		} finally {
			cleanupTempDir(dir);
		}
	});

	test("journal_mode pragma cannot be mutated through the read-only channel", () => {
		const dir = makeTempDir();
		const dbPath = join(dir, "test.sqlite3");
		try {
			const writable = nodeSqliteDriver.open(dbPath);
			writable.exec("CREATE TABLE t (x INTEGER)");
			writable.close();
			const readOnly = nodeSqliteDriver.openReadOnly(dbPath);
			try {
				assert.throws(() => readOnly.exec("PRAGMA journal_mode = WAL"));
			} finally {
				readOnly.close();
			}
		} finally {
			cleanupTempDir(dir);
		}
	});
});
