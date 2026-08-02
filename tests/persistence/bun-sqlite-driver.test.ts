import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { bunSqliteDriver } from "../../src/persistence/sqlite/bun-sqlite-driver";
import { openRunDatabase } from "../../src/persistence/sqlite/run-database";
import { CURRENT_SCHEMA_VERSION } from "../../src/persistence/sqlite/schema";
import type {
	SqliteConnection,
	SqliteDriver,
} from "../../src/persistence/sqlite/sqlite-driver";
import { cleanupTempDir, makeTempDir } from "../helpers/temp-run-dir";

describe("bun-sqlite driver", () => {
	test("opens an in-memory database", () => {
		const db = bunSqliteDriver.open(":memory:");
		try {
			const row = db.prepare("SELECT 1 AS n").get() as
				| { n: number }
				| undefined;
			expect(row?.n).toBe(1);
		} finally {
			db.close();
		}
	});

	test("creates and reads back a file-based database", () => {
		const dir = makeTempDir();
		const dbPath = join(dir, "test.sqlite3");
		try {
			const db = bunSqliteDriver.open(dbPath);
			db.exec("CREATE TABLE IF NOT EXISTS t (x INTEGER)");
			db.prepare("INSERT INTO t (x) VALUES (?)").run(42);
			const row = db.prepare("SELECT x FROM t").get() as
				| { x: number }
				| undefined;
			expect(row?.x).toBe(42);
			db.close();
			expect(existsSync(dbPath)).toBe(true);
		} finally {
			cleanupTempDir(dir);
		}
	});

	test("statement.run returns changes count", () => {
		const db = bunSqliteDriver.open(":memory:");
		try {
			db.exec("CREATE TABLE t (x INTEGER)");
			const stmt = db.prepare("INSERT INTO t (x) VALUES (?)");
			const r1 = stmt.run(1);
			expect(r1.changes).toBe(1);
			const r2 = stmt.run(2);
			expect(r2.changes).toBe(1);
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
				driver: bunSqliteDriver,
				dbPath,
				busyTimeoutMs: 500,
			});
			const row = runDb.connection
				.prepare(
					"SELECT schema_version FROM schema_metadata WHERE singleton = 1",
				)
				.get() as { schema_version: number } | undefined;
			expect(row?.schema_version).toBe(CURRENT_SCHEMA_VERSION);
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
			prepare: () => ({
				run: () => ({ changes: 1 }),
				get: <T>() => ({ schema_version: CURRENT_SCHEMA_VERSION }) as T,
				all: <T>() => [] as T[],
			}),
			close: () => {
				closed = true;
			},
		};
		const driver: SqliteDriver = {
			open: () => connection,
		};

		const runDb = openRunDatabase({
			driver,
			dbPath: "ignored.sqlite3",
			busyTimeoutMs: 321,
		});

		expect(executed[0]).toBe("PRAGMA busy_timeout = 321");
		expect(executed[1]).toBe("PRAGMA journal_mode = WAL");
		runDb.close();
		expect(closed).toBe(true);
	});

	test("WAL and synchronous pragmas are set", () => {
		const dir = makeTempDir();
		const dbPath = join(dir, "test-pragmas.sqlite3");
		try {
			const runDb = openRunDatabase({
				driver: bunSqliteDriver,
				dbPath,
				busyTimeoutMs: 500,
			});
			const jm = runDb.connection.prepare("PRAGMA journal_mode").get() as
				| { journal_mode: string }
				| undefined;
			const sync = runDb.connection.prepare("PRAGMA synchronous").get() as
				| { synchronous: number }
				| undefined;
			expect(jm?.journal_mode).toBe("wal");
			expect(sync?.synchronous).toBe(2); // FULL = 2
			runDb.close();
		} finally {
			cleanupTempDir(dir);
		}
	});
});
