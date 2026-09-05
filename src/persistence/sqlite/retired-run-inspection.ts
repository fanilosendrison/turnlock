// Strict read-only inspection of a RETIRED payload's internal authority.
//
// The retired/recovery phase must NEVER open a retired payload database
// through `openRunDatabase()` — that path can create, migrate, and
// initialize.  This module opens the database through the driver's
// strictly read-only channel (`openReadOnly`): a missing database makes
// the open FAIL and is never created; no SCHEMA_DDL, no migrations, no
// pragma mutations ever run.
//
// The inspection answers one destructive question: does this database
// prove that its run was durably, irreversibly claimed for retention
// deletion, with the matching retirement token?  Anything else —
// mismatched identity, wrong token, ACTIVE retention, HELD/owned state,
// unreadable file — fails closed.
import * as fs from "node:fs";
import { CURRENT_SCHEMA_VERSION } from "./schema.js";
import type { SqliteDriver } from "./sqlite-driver.js";

export interface InspectRetiredRunAuthorityParams {
	readonly driver: SqliteDriver;
	/** Absolute path of the retired payload's turnlock.sqlite3. */
	readonly dbPath: string;
	readonly expectedRunId: string;
	/** Optional — when provided, the persisted namespace must match. */
	readonly expectedOrchestratorName?: string;
	readonly expectedRetirementToken: string;
	/** Optional — when provided, the persisted incarnation id must match. */
	readonly expectedIncarnationId?: string;
}

export type RetiredRunInspection =
	| {
			/** The database durably proves a valid RETIRING retirement:
			 *  schema version expected, matching run identity, matching
			 *  retirement token with claim timestamp, ownership FREE with
			 *  every stale-owner field cleared. */
			readonly kind: "VALID_RETIRING";
			readonly runId: string;
			readonly orchestratorName: string;
			readonly incarnationId: string;
			readonly retirementToken: string;
			readonly retirementClaimedAtEpochMs: number;
	  }
	| {
			/** Readable but does NOT authorize destruction — KEEP. */
			readonly kind: "INVALID";
			readonly reason: string;
	  }
	| {
			/** Unreadable (missing/corrupt database) — KEEP.  The file is
			 *  never created and the filesystem is never modified. */
			readonly kind: "UNREADABLE";
			readonly cause: unknown;
	  };

/** Inspect a retired payload database strictly read-only.
 *
 *  Mutates nothing — not the database, not the filesystem. */
export function inspectRetiredRunAuthority(
	params: InspectRetiredRunAuthorityParams,
): RetiredRunInspection {
	let databaseStat: fs.Stats;
	try {
		databaseStat = fs.lstatSync(params.dbPath);
	} catch (error) {
		return {
			kind: "UNREADABLE",
			cause: error,
		};
	}
	if (databaseStat.isSymbolicLink() || !databaseStat.isFile()) {
		return {
			kind: "UNREADABLE",
			cause: new Error("retired payload database is not a regular file"),
		};
	}
	let connection: ReturnType<SqliteDriver["openReadOnly"]>;
	try {
		connection = params.driver.openReadOnly(params.dbPath);
	} catch (error) {
		return { kind: "UNREADABLE", cause: error };
	}
	try {
		// 1. Schema version — a foreign or future database must never be
		//    treated as a retired payload.
		const metadata = connection
			.prepare("SELECT schema_version FROM schema_metadata WHERE singleton = 1")
			.get() as
			| {
					schema_version: number;
			  }
			| undefined;
		if (metadata === undefined) {
			return { kind: "INVALID", reason: "schema_metadata row missing" };
		}
		if (metadata.schema_version !== CURRENT_SCHEMA_VERSION) {
			return {
				kind: "INVALID",
				reason: `schema version mismatch: expected ${CURRENT_SCHEMA_VERSION}, got ${metadata.schema_version}`,
			};
		}
		// 2. Run identity — run_id matches, incarnation id present,
		//    orchestrator name present.
		const incarnation = connection
			.prepare(
				"SELECT run_id, incarnation_id, orchestrator_name FROM run_incarnation WHERE singleton = 1",
			)
			.get() as
			| {
					run_id: string;
					incarnation_id: string;
					orchestrator_name: string;
			  }
			| undefined;
		if (incarnation === undefined) {
			return { kind: "INVALID", reason: "run_incarnation row missing" };
		}
		if (incarnation.run_id !== params.expectedRunId) {
			return {
				kind: "INVALID",
				reason: `run identity mismatch: expected ${params.expectedRunId}, got ${incarnation.run_id}`,
			};
		}
		if (
			params.expectedOrchestratorName !== undefined &&
			incarnation.orchestrator_name !== params.expectedOrchestratorName
		) {
			return {
				kind: "INVALID",
				reason: `orchestrator mismatch: expected ${params.expectedOrchestratorName}, got ${incarnation.orchestrator_name}`,
			};
		}
		if (params.expectedIncarnationId !== undefined) {
			if (incarnation.incarnation_id !== params.expectedIncarnationId) {
				return {
					kind: "INVALID",
					reason: `incarnation mismatch: expected ${params.expectedIncarnationId}, got ${incarnation.incarnation_id}`,
				};
			}
		}
		// 3. Retention state — RETIRING with matching token and a claim
		//    timestamp.
		const retention = connection
			.prepare(
				`SELECT retention_status, retirement_token,
				        retirement_claimed_at_epoch_ms
				 FROM run_retention WHERE singleton = 1`,
			)
			.get() as
			| {
					retention_status: string;
					retirement_token: string | null;
					retirement_claimed_at_epoch_ms: number | null;
			  }
			| undefined;
		if (retention === undefined) {
			return { kind: "INVALID", reason: "run_retention row missing" };
		}
		if (retention.retention_status !== "RETIRING") {
			return {
				kind: "INVALID",
				reason: `retention status is ${retention.retention_status}, not RETIRING`,
			};
		}
		if (
			retention.retirement_token === null ||
			retention.retirement_token !== params.expectedRetirementToken
		) {
			return {
				kind: "INVALID",
				reason: "retirement token mismatch",
			};
		}
		if (retention.retirement_claimed_at_epoch_ms === null) {
			return { kind: "INVALID", reason: "retirement claim timestamp missing" };
		}
		// 4. Ownership — must be FREE with every stale-owner field cleared:
		//    the retirement claim fenced the owner.
		const ownership = connection
			.prepare(
				`SELECT incarnation_id, ownership_status, owner_token, owner_pid,
				        acquired_at_epoch_ms, lease_until_epoch_ms
				 FROM run_ownership WHERE singleton = 1`,
			)
			.get() as
			| {
					incarnation_id: string;
					ownership_status: string;
					owner_token: string | null;
					owner_pid: number | null;
					acquired_at_epoch_ms: number | null;
					lease_until_epoch_ms: number | null;
			  }
			| undefined;
		if (ownership === undefined) {
			return { kind: "INVALID", reason: "run_ownership row missing" };
		}
		if (
			ownership.incarnation_id !== incarnation.incarnation_id ||
			ownership.ownership_status !== "FREE" ||
			ownership.owner_token !== null ||
			ownership.owner_pid !== null ||
			ownership.acquired_at_epoch_ms !== null ||
			ownership.lease_until_epoch_ms !== null
		) {
			return {
				kind: "INVALID",
				reason: "ownership not released — retirement fencing incoherent",
			};
		}
		return {
			kind: "VALID_RETIRING",
			runId: incarnation.run_id,
			orchestratorName: incarnation.orchestrator_name,
			incarnationId: incarnation.incarnation_id,
			retirementToken: retention.retirement_token,
			retirementClaimedAtEpochMs: retention.retirement_claimed_at_epoch_ms,
		};
	} catch (error) {
		return { kind: "UNREADABLE", cause: error };
	} finally {
		try {
			connection.close();
		} catch {
			// already closed
		}
	}
}
