// Run-level SQLite database — one per RUN_DIR.
//
// Owns the lifecycle of the concrete SqliteConnection and provides the
// authoritative persistence operations that replace the file-based lock and
// state.json direct writes (once TL-F-001 is fully implemented).

import { DbIntegrityError } from "./errors.js";
import { beginImmediate, commit, rollback } from "./ownership.js";
import {
	ensureRetentionRowInTransaction,
	RETENTION_STATUS_ACTIVE,
	RETENTION_STATUS_RETIRING,
	readRetentionRow,
} from "./retention-state.js";
import { CURRENT_SCHEMA_VERSION, SCHEMA_DDL } from "./schema.js";
import type { SqliteConnection, SqliteDriver } from "./sqlite-driver.js";
import {
	migrateWorkflowLifecycleInTransaction,
	validateWorkflowLifecycleSchemaInTransaction,
} from "./workflow-lifecycle-migration.js";
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
function assertRetiringOwnershipIsCoherent(db: SqliteConnection): void {
	const ownership = db
		.prepare(`SELECT incarnation_id, ownership_status, owner_token, owner_pid,
		        acquired_at_epoch_ms, lease_until_epoch_ms
		 FROM run_ownership WHERE singleton = 1`)
		.get() as
		| {
				readonly incarnation_id: string;
				readonly ownership_status: string;
				readonly owner_token: string | null;
				readonly owner_pid: number | null;
				readonly acquired_at_epoch_ms: number | null;
				readonly lease_until_epoch_ms: number | null;
		  }
		| undefined;
	const incarnation = db
		.prepare("SELECT incarnation_id FROM run_incarnation WHERE singleton = 1")
		.get<{ readonly incarnation_id: string }>();
	const state = db
		.prepare("SELECT incarnation_id FROM run_state WHERE singleton = 1")
		.get<{ readonly incarnation_id: string }>();
	if (
		ownership === undefined ||
		incarnation === undefined ||
		state === undefined ||
		ownership.incarnation_id !== incarnation.incarnation_id ||
		state.incarnation_id !== incarnation.incarnation_id ||
		ownership.ownership_status !== "FREE" ||
		ownership.owner_token !== null ||
		ownership.owner_pid !== null ||
		ownership.acquired_at_epoch_ms !== null ||
		ownership.lease_until_epoch_ms !== null
	) {
		throw new DbIntegrityError(
			"RETIRING authority lacks coherent released ownership and state",
		);
	}
}

/** Validate the retention singleton without ever rebuilding current state. */
function validateRetentionSchemaState(db: SqliteConnection): number | null {
	const retention = readRetentionRow(db);
	if (retention === null || retention.retentionStatus === null) {
		throw new DbIntegrityError(
			"run_retention row missing or unrecognized — database integrity failure",
		);
	}
	if (retention.retentionStatus === RETENTION_STATUS_ACTIVE) {
		if (
			retention.retirementToken !== null ||
			retention.retirementClaimedAtEpochMs !== null
		) {
			throw new DbIntegrityError(
				"ACTIVE retention row carries retirement metadata",
			);
		}
		return null;
	}
	if (
		retention.retentionStatus !== RETENTION_STATUS_RETIRING ||
		retention.retirementToken === null ||
		retention.retirementClaimedAtEpochMs === null ||
		!Number.isSafeInteger(retention.retirementClaimedAtEpochMs) ||
		retention.retirementClaimedAtEpochMs < 0
	) {
		throw new DbIntegrityError(
			"RETIRING row lacks coherent retirement metadata",
		);
	}
	assertRetiringOwnershipIsCoherent(db);
	return retention.retirementClaimedAtEpochMs;
}

/** Atomically initialize or migrate the SQLite authority through schema v3. */
function initializeSchema(db: SqliteConnection): void {
	beginImmediate(db);
	try {
		db.exec(SCHEMA_DDL);
		const existing = db
			.prepare("SELECT schema_version FROM schema_metadata WHERE singleton = 1")
			.get() as { readonly schema_version: number } | undefined;
		if (existing === undefined) {
			db.prepare(
				"INSERT INTO schema_metadata (singleton, schema_version) VALUES (1, ?)",
			).run(CURRENT_SCHEMA_VERSION);
			ensureRetentionRowInTransaction(db);
			validateWorkflowLifecycleSchemaInTransaction(db);
		} else if (existing.schema_version === 1 || existing.schema_version === 2) {
			if (existing.schema_version === 1) {
				ensureRetentionRowInTransaction(db);
			}
			const legacyRetirementClaimedAtEpochMs = validateRetentionSchemaState(db);
			if (
				existing.schema_version === 1 &&
				legacyRetirementClaimedAtEpochMs !== null
			) {
				throw new DbIntegrityError(
					"schema-v1 authority cannot carry a RETIRING claim",
				);
			}
			migrateWorkflowLifecycleInTransaction(
				db,
				legacyRetirementClaimedAtEpochMs,
			);
			db.prepare(
				"UPDATE schema_metadata SET schema_version = ? WHERE singleton = 1",
			).run(CURRENT_SCHEMA_VERSION);
			validateWorkflowLifecycleSchemaInTransaction(db);
		} else if (existing.schema_version === CURRENT_SCHEMA_VERSION) {
			validateRetentionSchemaState(db);
			validateWorkflowLifecycleSchemaInTransaction(db);
		} else {
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
