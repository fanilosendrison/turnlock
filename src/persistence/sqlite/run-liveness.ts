// Read-only liveness inspection for the retention cleanup.
//
// Answers one question for a candidate RUN_DIR: does this run still hold a
// live SQLite ownership authority?  The inspection is strictly read-only —
// it never creates a database file, never runs DDL, and never mutates
// pragmas — because the inspected database may still be the live authority
// of a concurrent process.
//
// Failure policy (destructive operation → fail closed): the cleanup may only
// delete a RUN_DIR when the liveness result is DELETABLE.  Every other
// outcome (live lease, unreadable DB, schema mismatch, identity mismatch,
// incoherent ownership row) means the directory is KEPT.
import * as fs from "node:fs";
import * as path from "node:path";
import { RUN_DB_FILENAME } from "../../constants.js";
import type { RunDirRetentionProtection } from "../../services/run-dir.js";
import { isOwnershipLive, readOwnershipPredecessor } from "./ownership.js";
import { openRunDatabaseReadOnly } from "./run-database.js";
import { CURRENT_SCHEMA_VERSION } from "./schema.js";
import type { SqliteDriver } from "./sqlite-driver.js";

/** Outcome of inspecting a candidate RUN_DIR for live SQLite authority. */
export type RunRetentionLiveness =
	| {
			/** A live HELD ownership lease exists — MUST NOT delete. */
			readonly kind: "PROTECTED";
			readonly reason: "LIVE_LEASE";
	  }
	| {
			/** No live authority — retention deletion is allowed. */
			readonly kind: "DELETABLE";
			readonly reason: "NO_DATABASE" | "FREE" | "EXPIRED_LEASE";
	  }
	| {
			/** Ambiguous state — destructive deletion must fail closed. */
			readonly kind: "UNKNOWN";
			readonly reason: string;
	  };

export interface RunRetentionLivenessParams {
	readonly driver: SqliteDriver;
	readonly runDir: string;
	/** Directory name of the candidate — must match the DB's run_id. */
	readonly runId: string;
	/** The single time boundary of the cleanup pass. */
	readonly nowEpochMs: number;
}

export function readRunRetentionLiveness(
	params: RunRetentionLivenessParams,
): RunRetentionLiveness {
	const { driver, runDir, runId, nowEpochMs } = params;
	const dbPath = path.join(runDir, RUN_DB_FILENAME);
	if (!fs.existsSync(dbPath)) {
		// No SQLite authority can exist without a database.  Legacy RUN_DIRs
		// (state.json era) remain governed by the retention threshold alone.
		return { kind: "DELETABLE", reason: "NO_DATABASE" };
	}
	let runDb: ReturnType<typeof openRunDatabaseReadOnly> | undefined;
	try {
		runDb = openRunDatabaseReadOnly({
			driver,
			dbPath,
			busyTimeoutMs: 2000,
		});
		// Schema compatibility — the tables must exist and match the version
		// this build understands before any row can be trusted.
		const schemaRow = runDb.connection
			.prepare("SELECT schema_version FROM schema_metadata WHERE singleton = 1")
			.get() as
			| {
					schema_version: number;
			  }
			| undefined;
		if (schemaRow === undefined) {
			return {
				kind: "UNKNOWN",
				reason:
					"schema metadata row missing — not a readable Turnlock database",
			};
		}
		if (schemaRow.schema_version !== CURRENT_SCHEMA_VERSION) {
			return {
				kind: "UNKNOWN",
				reason: `schema version mismatch: expected ${CURRENT_SCHEMA_VERSION}, got ${schemaRow.schema_version}`,
			};
		}
		// Identity — a DB claiming a different run must never be deleted as
		// if it belonged to the directory it was found in.
		const incarnationRow = runDb.connection
			.prepare("SELECT run_id FROM run_incarnation WHERE singleton = 1")
			.get() as
			| {
					run_id: string;
			  }
			| undefined;
		if (incarnationRow === undefined) {
			return { kind: "UNKNOWN", reason: "run incarnation row missing" };
		}
		if (incarnationRow.run_id !== runId) {
			return {
				kind: "UNKNOWN",
				reason: `run identity mismatch: directory ${runId}, database ${incarnationRow.run_id}`,
			};
		}
		// Ownership liveness — the same definition the CAS acquisition path
		// uses (HELD + lease strictly after the time boundary).
		const ownership = readOwnershipPredecessor(runDb.connection);
		if (ownership === null) {
			return { kind: "UNKNOWN", reason: "ownership row missing" };
		}
		if (isOwnershipLive(ownership, nowEpochMs)) {
			return { kind: "PROTECTED", reason: "LIVE_LEASE" };
		}
		if (ownership.status === "FREE") {
			return { kind: "DELETABLE", reason: "FREE" };
		}
		if (ownership.status === "HELD" && ownership.leaseUntilEpochMs !== null) {
			return { kind: "DELETABLE", reason: "EXPIRED_LEASE" };
		}
		return {
			kind: "UNKNOWN",
			reason: `incoherent ownership state: status=${ownership.status}, lease=${String(ownership.leaseUntilEpochMs)}`,
		};
	} catch (error) {
		return {
			kind: "UNKNOWN",
			reason: error instanceof Error ? error.message : String(error),
		};
	} finally {
		runDb?.close();
	}
}

/** Build the production retention protection policy for a SQLite driver.
 *
 *  The policy keeps a candidate RUN_DIR unless its liveness is DELETABLE;
 *  every ambiguous state therefore fails closed (kept). */
export function createRunRetentionProtection(
	driver: SqliteDriver,
): RunDirRetentionProtection {
	return {
		isRunProtected: (runDir, runId, nowEpochMs) =>
			readRunRetentionLiveness({ driver, runDir, runId, nowEpochMs }).kind !==
			"DELETABLE",
	};
}
