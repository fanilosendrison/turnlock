// Durable retention retirement claim.
//
// This is the ONLY mechanism that authorizes the deletion of a
// SQLite-backed RUN_DIR.  Instead of "read liveness, then delete", the
// cleanup must first commit an irreversible ACTIVE → RETIRING claim inside
// the run's own SQLite authority, serialized against every ownership
// acquisition by the same BEGIN IMMEDIATE write lock:
//
//   - cleanup wins  → RETIRING is committed and the stale owner is fenced;
//     every future ownership acquisition is refused; the filesystem
//     retirement (rename → delete) may proceed.
//   - resume wins    → ownership is HELD with a live lease when the claim
//     re-reads it after BEGIN IMMEDIATE; the claim returns LIVE_OWNER and
//     the cleanup must keep the directory.
//
// There is no interleaving in which an ownership is published AND the
// deletion is authorized: both outcomes are linearized on the claim's
// COMMIT versus the acquisition's COMMIT.
//
// The claim result also carries the DURABLE retirement identity
// (`retirementToken`) and the filesystem identity (dev/ino) of the
// directory and database observed while the connection was still open —
// the filesystem retirement phase must re-verify both before renaming the
// canonical pathname, so a claim can never authorize rename/delete of a
// different incarnation that later occupies the same pathname.
//
// Failure policy for the destructive operation: only CLAIMED and
// ALREADY_RETIRING authorize the filesystem retirement.  Every other
// result (LIVE_OWNER, UNKNOWN, DB_CONTENTION_TIMEOUT, DB_FAILURE) keeps
// the directory.
import * as fs from "node:fs";
import * as path from "node:path";
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
	RETENTION_STATUS_RETIRING,
	readRetentionRow,
} from "./retention-state.js";
import { openRunDatabase } from "./run-database.js";
import type { SqliteDriver } from "./sqlite-driver.js";

/** Filesystem identity (dev/ino) of the directory and database a claim
 *  referred to.  Captured while the SQLite connection was still open. */
export interface RunDatabaseFilesystemIdentity {
	/** Decimal strings keep filesystem identities exact on platforms where
	 *  inode/device values exceed JavaScript's safe-integer range. */
	readonly dirDev: string;
	readonly dirIno: string;
	readonly dbDev: string;
	readonly dbIno: string;
}

/** Typed result of attempting the durable retirement claim. */
export type RunRetentionClaimResult =
	| {
			/** The retirement frontier was committed in this attempt.  The
			 *  stale owner (if any) was fenced; the run can never be
			 *  acquired again.  Filesystem retirement is authorized for
			 *  the identified directory object. */
			readonly kind: "CLAIMED";
			readonly fenceToken: bigint;
			readonly runId: string;
			readonly incarnationId: string;
			readonly orchestratorName: string;
			readonly retirementToken: string;
			readonly retirementClaimedAtEpochMs: number;
			readonly databaseIdentity: RunDatabaseFilesystemIdentity | null;
	  }
	| {
			/** A previous cleanup already committed the irreversible
			 *  retirement (it may have crashed before the rename/delete).
			 *  Filesystem retirement may be resumed.  The persisted
			 *  retirement token was validated. */
			readonly kind: "ALREADY_RETIRING";
			readonly runId: string;
			readonly incarnationId: string;
			readonly orchestratorName: string;
			readonly retirementToken: string;
			readonly retirementClaimedAtEpochMs: number;
			readonly databaseIdentity: RunDatabaseFilesystemIdentity | null;
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
	/** The namespace that owns the canonical path.  When supplied, the
	 *  database incarnation must prove this exact orchestrator name. */
	readonly expectedOrchestratorName?: string;
	readonly busyTimeoutMs: number;
	readonly contentionDeadlineMs: number;
	/** Optional clock for lease-critical timestamp capture after
	 *  BEGIN IMMEDIATE.  Defaults to `Date.now`. */
	readonly leaseClockEpochMs?: () => number;
}

function captureDatabaseIdentity(
	dbPath: string,
): RunDatabaseFilesystemIdentity | null {
	try {
		const dbStat = fs.lstatSync(dbPath, { bigint: true });
		const dirStat = fs.lstatSync(path.dirname(dbPath), { bigint: true });
		if (dbStat.isSymbolicLink() || dirStat.isSymbolicLink()) return null;
		return {
			dirDev: dirStat.dev.toString(),
			dirIno: dirStat.ino.toString(),
			dbDev: dbStat.dev.toString(),
			dbIno: dbStat.ino.toString(),
		};
	} catch {
		return null;
	}
}

function databaseIdentitiesEqual(
	left: RunDatabaseFilesystemIdentity,
	right: RunDatabaseFilesystemIdentity,
): boolean {
	return (
		left.dirDev === right.dirDev &&
		left.dirIno === right.dirIno &&
		left.dbDev === right.dbDev &&
		left.dbIno === right.dbIno
	);
}

/** Validate an already-RETIRING database before authorizing filesystem
 *  retirement resume.
 *
 *  The persisted retirement state must be coherent: token and claim
 *  timestamp present, ownership released (FREE) with every stale owner
 *  field cleared.  Anything else — including RETIRING + HELD/live — is an
 *  integrity failure: the caller must KEEP, never delete. */
function validateRetiredStateInTransaction(
	db: Parameters<typeof readOwnershipPredecessor>[0],
	expectedIncarnationId: string,
): { token: string; claimedAtEpochMs: number } | null {
	const retention = readRetentionRow(db);
	if (
		retention === null ||
		retention.retentionStatus !== RETENTION_STATUS_RETIRING
	) {
		return null;
	}
	if (
		retention.retirementToken === null ||
		retention.retirementClaimedAtEpochMs === null
	) {
		return null;
	}
	const ownership = readOwnershipPredecessor(db);
	if (ownership === null) return null;
	if (
		ownership.incarnationId !== expectedIncarnationId ||
		ownership.status !== "FREE" ||
		ownership.ownerToken !== null ||
		ownership.ownerPid !== null ||
		ownership.acquiredAtEpochMs !== null ||
		ownership.leaseUntilEpochMs !== null
	) {
		return null;
	}
	return {
		token: retention.retirementToken,
		claimedAtEpochMs: retention.retirementClaimedAtEpochMs,
	};
}

/** Atomically claim a run for retention deletion.
 *
 *  Protocol (all inside BEGIN IMMEDIATE on the run's own database):
 *    1. Re-read EVERYTHING after the write lock is acquired: schema is
 *       already validated/migrated by `openRunDatabase`; incarnation
 *       identity, retention state, and ownership are re-read here.
 *    2. The lease clock is captured AFTER lock acquisition — the wait for
 *       BEGIN IMMEDIATE must not produce a stale liveness decision.
 *    3. RETIRING  → validate the persisted retirement state and return
 *       ALREADY_RETIRING with the persisted token (or UNKNOWN when the
 *       state is incoherent — never authorize deletion on it).
 *    4. HELD + live lease → LIVE_OWNER (must keep).
 *    5. FREE, or HELD with an expired lease → commit ACTIVE → RETIRING
 *       (fresh durable token, fence the stale owner) in one transaction.
 *       The transition must mutate exactly one row or the claim fails.
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
	// Check the canonical database path before opening it.  A symlink or
	// non-regular file could otherwise redirect openRunDatabase() to a
	// different valid authority and let this claim fence that foreign run
	// before the later rename identity check rejects deletion.
	const identityBeforeOpen = captureDatabaseIdentity(params.dbPath);
	if (identityBeforeOpen === null) {
		return {
			kind: "UNKNOWN",
			reason:
				"SQLite authority path is unsafe or has no stable filesystem identity",
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
	// Opening may run the normal schema setup pragmas.  Before entering the
	// retirement transaction, ensure the path still denotes the same regular
	// database and canonical directory observed above.
	const identityAfterOpen = captureDatabaseIdentity(params.dbPath);
	if (
		identityAfterOpen === null ||
		!databaseIdentitiesEqual(identityBeforeOpen, identityAfterOpen)
	) {
		runDb.close();
		return {
			kind: "UNKNOWN",
			reason: "SQLite authority filesystem identity changed before claim",
		};
	}
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
			if (
				params.expectedOrchestratorName !== undefined &&
				incarnationRow.orchestrator_name !== params.expectedOrchestratorName
			) {
				rollback(db);
				return {
					kind: "UNKNOWN",
					reason: `orchestrator identity mismatch: expected ${params.expectedOrchestratorName}, database ${incarnationRow.orchestrator_name}`,
				};
			}
			if (!incarnationRow.incarnation_id || !incarnationRow.orchestrator_name) {
				rollback(db);
				return {
					kind: "UNKNOWN",
					reason: "run incarnation identity incomplete",
				};
			}
			// 2. Retention state.
			const retention = readRetentionRow(db);
			if (retention === null) {
				rollback(db);
				return { kind: "UNKNOWN", reason: "retention row missing" };
			}
			if (retention.retentionStatus === null) {
				rollback(db);
				return {
					kind: "UNKNOWN",
					reason: "retention status unrecognized — integrity failure",
				};
			}
			if (retention.retentionStatus === RETENTION_STATUS_RETIRING) {
				// Already retired — validate the persisted state BEFORE
				// authorizing a filesystem retirement resume.
				const persisted = validateRetiredStateInTransaction(
					db,
					incarnationRow.incarnation_id,
				);
				rollback(db);
				if (persisted === null) {
					return {
						kind: "UNKNOWN",
						reason: "incoherent RETIRING state — deletion not authorized",
					};
				}
				return {
					kind: "ALREADY_RETIRING",
					runId: incarnationRow.run_id,
					incarnationId: incarnationRow.incarnation_id,
					orchestratorName: incarnationRow.orchestrator_name,
					retirementToken: persisted.token,
					retirementClaimedAtEpochMs: persisted.claimedAtEpochMs,
					databaseIdentity: captureDatabaseIdentity(params.dbPath),
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
			const freeIsCoherent =
				ownership.status === "FREE" &&
				ownership.ownerToken === null &&
				ownership.ownerPid === null &&
				ownership.acquiredAtEpochMs === null &&
				ownership.leaseUntilEpochMs === null;
			const expiredHeldOwner =
				ownership.status === "HELD" && ownership.leaseUntilEpochMs !== null;
			if (!freeIsCoherent && !expiredHeldOwner) {
				rollback(db);
				return {
					kind: "UNKNOWN",
					reason: `incoherent ownership state: status=${ownership.status}, lease=${String(ownership.leaseUntilEpochMs)}`,
				};
			}
			// Re-check the path immediately before the irreversible claim.
			// Production callers hold the namespace mutex, while this second
			// identity check also fails closed for direct/adversarial callers.
			const identityBeforeClaim = captureDatabaseIdentity(params.dbPath);
			if (
				identityBeforeClaim === null ||
				!databaseIdentitiesEqual(identityBeforeOpen, identityBeforeClaim)
			) {
				rollback(db);
				return {
					kind: "UNKNOWN",
					reason: "SQLite authority filesystem identity changed before claim",
				};
			}
			// 4. Irreversible retirement claim: fence the stale owner and
			//    flip ACTIVE → RETIRING in the same transaction.  The
			//    transition must mutate exactly one row (proven inside
			//    applyRetirementInTransaction) or this fails closed.
			const retirementToken = generateRunId();
			const fenceToken = fenceOwnershipForRetirementInTransaction(db);
			applyRetirementInTransaction(db, retirementToken, nowEpochMs);
			commit(db);
			return {
				kind: "CLAIMED",
				fenceToken,
				runId: incarnationRow.run_id,
				incarnationId: incarnationRow.incarnation_id,
				orchestratorName: incarnationRow.orchestrator_name,
				retirementToken,
				retirementClaimedAtEpochMs: nowEpochMs,
				// Captured while the connection is still open, after the
				// COMMIT that made RETIRING durable.
				databaseIdentity: captureDatabaseIdentity(params.dbPath),
			};
		} catch (error) {
			rollback(db);
			return { kind: "DB_FAILURE", cause: error };
		}
	} finally {
		runDb.close();
	}
}
