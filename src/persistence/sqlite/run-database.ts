// Run-level SQLite database — one per RUN_DIR.
//
// Owns the lifecycle of the concrete SqliteConnection and provides the
// authoritative persistence operations that replace the file-based lock and
// state.json direct writes (once TL-F-001 is fully implemented).

import { DbIntegrityError } from "./errors.js";
import { beginImmediate, commit, rollback } from "./ownership.js";
import {
	RETENTION_STATUS_RETIRING,
	readRetentionRow,
} from "./retention-state.js";
import { CURRENT_SCHEMA_VERSION, SCHEMA_DDL } from "./schema.js";
import type { SqliteConnection, SqliteDriver } from "./sqlite-driver.js";
export interface RunDatabaseConfig {
	readonly driver: SqliteDriver;
	readonly dbPath: string;
	readonly busyTimeoutMs: number;
}
export interface RunDatabase {
	readonly connection: SqliteConnection;
	close(): void;
}
function configurePragmas(db: SqliteConnection, busyTimeoutMs: number): void {
	// journal_mode may need an exclusive lock while another process is opening
	// the same run DB. Install the busy handler first so that startup races are
	// bounded retries rather than immediate SQLITE_BUSY failures.
	db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
	db.exec(`PRAGMA journal_mode = WAL`);
	db.exec(`PRAGMA synchronous = FULL`);
	db.exec(`PRAGMA foreign_keys = ON`);
}
/** Schema metadata check and v1 → v2 migration.
 *
 *  The idempotent `SCHEMA_DDL` (CREATE TABLE IF NOT EXISTS) runs first —
 *  the atomicity of the very first concurrent schema initialization on a
 *  nonexistent database is a separate open backlog item.  The version
 *  check/migration itself runs inside its own BEGIN IMMEDIATE ... COMMIT:
 *    - no metadata row        → fresh database: insert version 2 + ACTIVE
 *      retention row;
 *    - version 1              → v1→v2 migration: create the retention row
 *      as ACTIVE (v1 databases could not be RETIRING) and bump the version;
 *    - version 2              → VALIDATE the existing retention row: it
 *      must exist with a recognized status, and a RETIRING row must carry
 *      a retirement token and claim timestamp.  A v2 database with a
 *      missing or incoherent security row is an integrity failure — the
 *      open fails closed, never silently recreating ACTIVE;
 *    - anything else          → fail closed.
 *
 *  Every existing v1 database therefore migrates safely to ACTIVE
 *  retention eligibility; a run can only ever be RETIRING through the
 *  transactional retirement claim. */
function initializeSchema(db: SqliteConnection): void {
	db.exec(SCHEMA_DDL);
	beginImmediate(db);
	try {
		const existing = db
			.prepare("SELECT schema_version FROM schema_metadata WHERE singleton = 1")
			.get() as
			| {
					schema_version: number;
			  }
			| undefined;
		if (existing === undefined) {
			db.prepare(
				"INSERT INTO schema_metadata (singleton, schema_version) VALUES (1, ?)",
			).run(CURRENT_SCHEMA_VERSION);
			db.prepare(`INSERT OR IGNORE INTO run_retention
				 (singleton, retention_status)
				 VALUES (1, 'ACTIVE')`).run();
		} else if (existing.schema_version === 1) {
			// v1 → v2 migration: establish retention eligibility as ACTIVE.
			db.prepare(`INSERT OR IGNORE INTO run_retention
				 (singleton, retention_status)
				 VALUES (1, 'ACTIVE')`).run();
			db.prepare(
				"UPDATE schema_metadata SET schema_version = ? WHERE singleton = 1",
			).run(CURRENT_SCHEMA_VERSION);
		} else if (existing.schema_version === CURRENT_SCHEMA_VERSION) {
			// v2: the retention security row is part of the schema contract.
			// A missing row must never be silently rebuilt as ACTIVE — that
			// would resurrect deletion eligibility in the permissive
			// direction.
			const retention = readRetentionRow(db);
			if (retention === null) {
				rollback(db);
				throw new DbIntegrityError(
					"schema v2 run_retention row missing — database integrity failure",
				);
			}
			if (retention.retentionStatus === null) {
				rollback(db);
				throw new DbIntegrityError(
					"schema v2 run_retention status unrecognized — database integrity failure",
				);
			}
			if (
				retention.retentionStatus === RETENTION_STATUS_RETIRING &&
				(retention.retirementToken === null ||
					retention.retirementClaimedAtEpochMs === null)
			) {
				rollback(db);
				throw new DbIntegrityError(
					"schema v2 RETIRING row lacks retirement token/timestamp — database integrity failure",
				);
			}
		} else {
			rollback(db);
			throw new Error(
				`SQLite schema version mismatch: expected ${CURRENT_SCHEMA_VERSION}, got ${existing.schema_version}`,
			);
		}
		commit(db);
	} catch (error) {
		rollback(db);
		throw error;
	}
}
export function openRunDatabase(config: RunDatabaseConfig): RunDatabase {
	const db = config.driver.open(config.dbPath);
	try {
		configurePragmas(db, config.busyTimeoutMs);
		initializeSchema(db);
	} catch (error) {
		db.close();
		throw error;
	}
	return {
		connection: db,
		close: () => db.close(),
	};
}
