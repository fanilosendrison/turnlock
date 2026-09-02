// Durable retention retirement claim.
//
// This is the ONLY mechanism that authorizes the deletion of a
// SQLite-backed RUN_DIR.  Instead of "read liveness, then delete", the
// cleanup must first commit an irreversible ACTIVE → RETIRING claim inside
// the run's own SQLite authority, serialized against every ownership
// acquisition by the same BEGIN IMMEDIATE write lock:
//
//   - cleanup wins  → RETIRING is committed and the stale owner is fenced;
//     every future ownership acquisition is refused; deletion may proceed
//     (now or after a crash).
//   - resume wins    → ownership is HELD with a live lease when the claim
//     re-reads it after BEGIN IMMEDIATE; the claim returns LIVE_OWNER and
//     the cleanup must keep the directory.
//
// There is no interleaving in which an ownership is published AND the
// deletion is authorized: both outcomes are linearized on the claim's
// COMMIT versus the acquisition's COMMIT.
//
// Failure policy for the destructive operation: only CLAIMED and
// ALREADY_RETIRING authorize `rm`.  Every other result (LIVE_OWNER,
// UNKNOWN, DB_CONTENTION_TIMEOUT, DB_FAILURE) keeps the directory.
import * as fs from "node:fs";
import * as path from "node:path";
import { RUN_DB_FILENAME } from "../../constants.js";
import type { RunDirRetentionClaim } from "../../services/run-dir.js";
import { generateRunId } from "../../services/run-id.js";
import {
	beginImmediate,
	commit,
	isOwnershipLive,
	isSqliteBusyError,
	readOwnershipPredecessor,
	rollback,
} from "./ownership.js";
import {
	applyRetirementInTransaction,
	fenceOwnershipForRetirementInTransaction,
	RETENTION_STATUS_ACTIVE,
	RETENTION_STATUS_RETIRING,
	readRetentionStatus,
} from "./retention-state.js";
import { openRunDatabase } from "./run-database.js";
import type { SqliteDriver } from "./sqlite-driver.js";

/** Typed result of attempting the durable retirement claim. */
export type RunRetentionClaimResult =
	| {
			/** The retirement frontier was committed in this attempt.  The
			 *  stale owner (if any) was fenced; the run can never be
			 *  acquired again.  Deletion is authorized. */
			readonly kind: "CLAIMED";
			readonly fenceToken: bigint;
	  }
	| {
			/** A previous cleanup already committed the irreversible
			 *  retirement (it may have crashed before deleting).  Deletion
			 *  is authorized and should be resumed. */
			readonly kind: "ALREADY_RETIRING";
	  }
	| {
			/** Ownership is HELD with a live lease at the time of the claim
			 *  (clock captured after BEGIN IMMEDIATE).  MUST KEEP. */
			readonly kind: "LIVE_OWNER";
			readonly leaseUntilEpochMs: number;
	  }
	| {
			/** Cannot prove safe retirement — MUST KEEP (fail-closed). */
			readonly kind: "UNKNOWN";
			readonly reason: string;
	  }
	| {
			readonly kind: "DB_CONTENTION_TIMEOUT";
	  }
	| {
			readonly kind: "DB_FAILURE";
			readonly cause: unknown;
	  };

export interface ClaimRunForRetentionDeletionParams {
	readonly driver: SqliteDriver;
	readonly dbPath: string;
	readonly runId: string;
	readonly busyTimeoutMs: number;
	readonly contentionDeadlineMs: number;
	/** Optional clock for lease-critical timestamp capture after
	 *  BEGIN IMMEDIATE.  Defaults to `Date.now`. */
	readonly leaseClockEpochMs?: () => number;
}

/** Atomically claim a run for retention deletion.
 *
 *  Protocol (all inside BEGIN IMMEDIATE on the run's own database):
 *    1. Re-read EVERYTHING after the write lock is acquired: schema is
 *       already validated/migrated by `openRunDatabase`; incarnation
 *       identity, retention status, and ownership are re-read here.
 *    2. The lease clock is captured AFTER lock acquisition — the wait for
 *       BEGIN IMMEDIATE must not produce a stale liveness decision.
 *    3. RETIRING  → ALREADY_RETIRING (deletion may proceed/resume).
 *    4. HELD + live lease → LIVE_OWNER (must keep).
 *    5. FREE, or HELD with an expired lease → commit ACTIVE → RETIRING
 *       and fence the stale owner (fence_token incremented, owner
 *       metadata cleared) in the same transaction.
 *    6. Anything unreadable, mismatched, or incoherent → UNKNOWN (keep).
 *
 *  The claim NEVER creates a database file: a RUN_DIR without a SQLite
 *  authority returns UNKNOWN so legacy directories fail closed (kept). */
export function claimRunForRetentionDeletion(
	params: ClaimRunForRetentionDeletionParams,
): RunRetentionClaimResult {
	if (!fs.existsSync(params.dbPath)) {
		return {
			kind: "UNKNOWN",
			reason: "no SQLite authority — legacy RUN_DIR kept (fail-closed)",
		};
	}
	let runDb: ReturnType<typeof openRunDatabase> | undefined;
	try {
		runDb = openRunDatabase({
			driver: params.driver,
			dbPath: params.dbPath,
			busyTimeoutMs: params.busyTimeoutMs,
		});
	} catch (error) {
		return { kind: "DB_FAILURE", cause: error };
	}
	const db = runDb.connection;
	try {
		const deadlineMs = performance.now() + params.contentionDeadlineMs;
		for (;;) {
			try {
				beginImmediate(db);
				break;
			} catch (error) {
				if (isSqliteBusyError(error) && performance.now() < deadlineMs) {
					continue;
				}
				return isSqliteBusyError(error)
					? { kind: "DB_CONTENTION_TIMEOUT" }
					: { kind: "DB_FAILURE", cause: error };
			}
		}
		// Clock AFTER lock acquisition — the wait for BEGIN IMMEDIATE
		// (governed by busy_timeout) must not produce a stale lease
		// comparison.  Same convention as the ownership CAS paths.
		const nowEpochMs = (params.leaseClockEpochMs ?? Date.now)();
		try {
			// 1. Identity — a DB claiming a different run must never be
			//    retired as if it belonged to this directory.
			const incarnationRow = db
				.prepare("SELECT run_id FROM run_incarnation WHERE singleton = 1")
				.get() as
				| {
						run_id: string;
				  }
				| undefined;
			if (incarnationRow === undefined) {
				rollback(db);
				return { kind: "UNKNOWN", reason: "run incarnation row missing" };
			}
			if (incarnationRow.run_id !== params.runId) {
				rollback(db);
				return {
					kind: "UNKNOWN",
					reason: `run identity mismatch: directory ${params.runId}, database ${incarnationRow.run_id}`,
				};
			}
			// 2. Retention state.
			const retentionStatus = readRetentionStatus(db);
			if (retentionStatus === null) {
				rollback(db);
				return { kind: "UNKNOWN", reason: "retention row missing" };
			}
			if (retentionStatus === RETENTION_STATUS_RETIRING) {
				rollback(db);
				return { kind: "ALREADY_RETIRING" };
			}
			if (retentionStatus !== RETENTION_STATUS_ACTIVE) {
				rollback(db);
				return {
					kind: "UNKNOWN",
					reason: `incoherent retention state: ${retentionStatus}`,
				};
			}
			// 3. Ownership liveness — same definition as the CAS acquisition
			//    path (HELD + now < lease_until_epoch_ms).
			const ownership = readOwnershipPredecessor(db);
			if (ownership === null) {
				rollback(db);
				return { kind: "UNKNOWN", reason: "ownership row missing" };
			}
			if (isOwnershipLive(ownership, nowEpochMs)) {
				rollback(db);
				return {
					kind: "LIVE_OWNER",
					leaseUntilEpochMs: ownership.leaseUntilEpochMs,
				};
			}
			const deletable =
				ownership.status === "FREE" ||
				(ownership.status === "HELD" && ownership.leaseUntilEpochMs !== null);
			if (!deletable) {
				rollback(db);
				return {
					kind: "UNKNOWN",
					reason: `incoherent ownership state: status=${ownership.status}, lease=${String(ownership.leaseUntilEpochMs)}`,
				};
			}
			// 4. Irreversible retirement claim: fence the stale owner and
			//    flip ACTIVE → RETIRING in the same transaction.
			const fenceToken = fenceOwnershipForRetirementInTransaction(db);
			applyRetirementInTransaction(db, generateRunId(), nowEpochMs);
			commit(db);
			return { kind: "CLAIMED", fenceToken };
		} catch (error) {
			rollback(db);
			return { kind: "DB_FAILURE", cause: error };
		}
	} finally {
		runDb.close();
	}
}

/** Build the production retention claim delegate for a SQLite driver.
 *
 *  `cleanupOldRuns` may delete a candidate directory only after this
 *  delegate returns CLAIMED or ALREADY_RETIRING. */
export function createRunRetentionClaim(
	driver: SqliteDriver,
): RunDirRetentionClaim {
	return {
		claimRunForDeletion: (runDir: string, runId: string) =>
			claimRunForRetentionDeletion({
				driver,
				dbPath: path.join(runDir, RUN_DB_FILENAME),
				runId,
				busyTimeoutMs: 2000,
				contentionDeadlineMs: 5000,
			}),
	};
}
