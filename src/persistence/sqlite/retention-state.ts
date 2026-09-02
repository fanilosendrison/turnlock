// Durable retention state — low-level transactional helpers.
//
// `run_retention` answers one question: is this run still admissible to a
// future ownership acquisition?  The ACTIVE → RETIRING transition is the
// irreversible retirement frontier: once committed, no ownership may ever
// be published again and only retention deletion may proceed.
//
// These helpers are deliberately transaction-scoped primitives: callers
// must hold BEGIN IMMEDIATE.  Both the ownership acquisition paths
// (ownership.ts) and the retention claim (retention-claim.ts) use them, so
// "admissible to ownership" and "claimed for deletion" are serialized by
// the same SQLite write lock.
import { DbIntegrityError } from "./errors.js";
import type { SqliteConnection } from "./sqlite-driver.js";

export const RETENTION_STATUS_ACTIVE = "ACTIVE" as const;
export const RETENTION_STATUS_RETIRING = "RETIRING" as const;
export type RetentionStatus =
	| typeof RETENTION_STATUS_ACTIVE
	| typeof RETENTION_STATUS_RETIRING;

/** Ensure the retention singleton row exists within an active transaction.
 *
 *  Idempotent: an existing row (including a RETIRING row) is never
 *  replaced.  New databases start ACTIVE. */
export function ensureRetentionRowInTransaction(db: SqliteConnection): void {
	db.prepare(`INSERT OR IGNORE INTO run_retention
		 (singleton, retention_status)
		 VALUES (1, ?)`).run(RETENTION_STATUS_ACTIVE);
}

/** Full retirement singleton row for coherence validation.
 *
 *  Returns null when the row is missing.  Used by the claim path to
 *  validate an already-RETIRING state before authorizing deletion resume. */
export interface RetentionRow {
	readonly retentionStatus: RetentionStatus | null;
	readonly retirementToken: string | null;
	readonly retirementClaimedAtEpochMs: number | null;
}
export function readRetentionRow(db: SqliteConnection): RetentionRow | null {
	const row = db
		.prepare(`SELECT retention_status, retirement_token,
			        retirement_claimed_at_epoch_ms
			 FROM run_retention WHERE singleton = 1`)
		.get() as
		| {
				retention_status: string;
				retirement_token: string | null;
				retirement_claimed_at_epoch_ms: number | null;
		  }
		| undefined;
	if (row === undefined) return null;
	return {
		retentionStatus: readRetentionStatus(db),
		retirementToken: row.retirement_token,
		retirementClaimedAtEpochMs: row.retirement_claimed_at_epoch_ms,
	};
}
/** Read the current retention status within an active transaction.
 *
 *  Strict and fail-closed: returns `ACTIVE`, `RETIRING`, or `null` for a
 *  MISSING row or an UNRECOGNIZED status value.  A corrupted value such as
 *  "BROKEN" is NEVER silently coerced to ACTIVE — callers must treat null
 *  as an integrity failure, especially on destructive paths. */
export function readRetentionStatus(
	db: SqliteConnection,
): RetentionStatus | null {
	const row = db
		.prepare("SELECT retention_status FROM run_retention WHERE singleton = 1")
		.get() as
		| {
				retention_status: string;
		  }
		| undefined;
	if (row === undefined) return null;
	if (row.retention_status === RETENTION_STATUS_ACTIVE) {
		return RETENTION_STATUS_ACTIVE;
	}
	if (row.retention_status === RETENTION_STATUS_RETIRING) {
		return RETENTION_STATUS_RETIRING;
	}
	return null;
}

/** Irreversibly apply the retirement claim within an active transaction.
 *
 *  ACTIVE → RETIRING with a fresh retirement token.  The conditional
 *  `WHERE retention_status = 'ACTIVE'` guards against double claims, and
 *  the affected-row count is PROVEN: a destructive claim is only valid
 *  when the transition mutated exactly one row.  Zero rows (or more than
 *  one — impossible on a singleton) means the claim did not actually take
 *  effect and the caller must roll back and fail closed. */
export function applyRetirementInTransaction(
	db: SqliteConnection,
	retirementToken: string,
	claimedAtEpochMs: number,
): void {
	const result = db
		.prepare(`UPDATE run_retention
		 SET retention_status = ?,
		     retirement_token = ?,
		     retirement_claimed_at_epoch_ms = ?
		 WHERE singleton = 1
		   AND retention_status = ?`)
		.run(
			RETENTION_STATUS_RETIRING,
			retirementToken,
			claimedAtEpochMs,
			RETENTION_STATUS_ACTIVE,
		);
	if (result.changes !== 1) {
		throw new DbIntegrityError(
			`retention claim transition affected ${result.changes} rows — expected exactly 1`,
		);
	}
}

/** Fence any stale owner and release the ownership row within an active
 *  transaction.
 *
 *  The fence token is incremented (never decremented, never reused) so
 *  that every LockHandle published before the retirement becomes
 *  definitively unusable, and the owner metadata is cleared so the row
 *  can no longer represent a live authority.  Returns the new fence. */
export function fenceOwnershipForRetirementInTransaction(
	db: SqliteConnection,
): bigint {
	const row = db
		.prepare(`UPDATE run_ownership
		 SET ownership_status = 'FREE',
		     owner_token = NULL,
		     owner_pid = NULL,
		     acquired_at_epoch_ms = NULL,
		     lease_until_epoch_ms = NULL,
		     fence_token = fence_token + 1
		 WHERE singleton = 1
		 RETURNING fence_token`)
		.get() as
		| {
				fence_token: number | bigint;
		  }
		| undefined;
	if (row === undefined) {
		throw new Error("ownership row missing during retirement fencing");
	}
	if (typeof row.fence_token === "bigint") return row.fence_token;
	return BigInt(row.fence_token);
}
