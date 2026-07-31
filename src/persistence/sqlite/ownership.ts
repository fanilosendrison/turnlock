// Authoritative ownership — replaces the file-based lock.
//
// Every acquisition is a CAS (compare-and-swap) transaction:
//  1. Observe the predecessor row.
//  2. BEGIN IMMEDIATE.
//  3. Conditional UPDATE that matches EXACTLY the observed predecessor.
//  4. COMMIT.
//
// The fence_token is monotonic and never decremented.  A handle is only
// returned after a successful COMMIT.

import { generateRunId } from "../../services/run-id";
import { DbIntegrityError } from "./errors";
import type { SqliteConnection } from "./sqlite-driver";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LockHandle {
	readonly ownerToken: string;
	readonly incarnationId: string;
	readonly fenceToken: bigint;
	readonly leaseUntilEpochMs: number;
}

export interface OwnershipPredecessor {
	readonly incarnationId: string;
	readonly status: "FREE" | "HELD";
	readonly ownerToken: string | null;
	readonly fenceToken: bigint;
	readonly leaseUntilEpochMs: number | null;
}

export type AcquireResult =
	| { readonly kind: "ACQUIRED"; readonly handle: LockHandle }
	| {
			readonly kind: "ACTIVE_CONFLICT";
			readonly ownerPid: number;
			readonly leaseUntilEpochMs: number;
	  }
	| { readonly kind: "PREDECESSOR_CAS_MISS" }
	| { readonly kind: "DB_CONTENTION_TIMEOUT" }
	| { readonly kind: "DB_FAILURE"; readonly cause: unknown };

export interface AcquireParams {
	readonly db: SqliteConnection;
	readonly runId: string;
	readonly orchestratorName: string;
	readonly nowEpochMs: number;
	readonly nowIso: string;
	readonly leaseDurationMs: number;
	readonly contentionDeadlineMs: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function bigintFromRow(value: unknown): bigint {
	if (typeof value === "bigint") return value;
	if (typeof value === "number") return BigInt(value);
	throw new DbIntegrityError(`expected bigint, got ${typeof value}`);
}

function readPredecessor(db: SqliteConnection): OwnershipPredecessor | null {
	const row = db
		.prepare(
			`SELECT incarnation_id, ownership_status, owner_token,
			        fence_token, lease_until_epoch_ms
			 FROM run_ownership
			 WHERE singleton = 1`,
		)
		.get() as
		| {
				incarnation_id: string;
				ownership_status: string;
				owner_token: string | null;
				fence_token: number | bigint;
				lease_until_epoch_ms: number | null;
		  }
		| undefined;

	if (row === undefined) return null;

	return {
		incarnationId: row.incarnation_id,
		status: row.ownership_status as "FREE" | "HELD",
		ownerToken: row.owner_token,
		fenceToken: bigintFromRow(row.fence_token),
		leaseUntilEpochMs: row.lease_until_epoch_ms,
	};
}

function ensureIncarnation(
	db: SqliteConnection,
	runId: string,
	orchestratorName: string,
	nowEpochMs: number,
	nowIso: string,
): string {
	const existing = db
		.prepare("SELECT incarnation_id FROM run_incarnation WHERE singleton = 1")
		.get() as { incarnation_id?: string } | undefined;

	if (existing?.incarnation_id !== undefined) {
		return existing.incarnation_id;
	}

	const incarnationId = generateRunId();
	db.prepare(
		`INSERT OR IGNORE INTO run_incarnation
		 (singleton, run_id, incarnation_id, orchestrator_name,
		  created_at_epoch_ms, created_at_iso)
		 VALUES (1, ?, ?, ?, ?, ?)`,
	).run(runId, incarnationId, orchestratorName, nowEpochMs, nowIso);

	// Re-read in case another process inserted first.
	const inserted = db
		.prepare("SELECT incarnation_id FROM run_incarnation WHERE singleton = 1")
		.get() as { incarnation_id: string } | undefined;
	return inserted?.incarnation_id ?? incarnationId;
}

function ensureOwnershipRow(db: SqliteConnection, incarnationId: string): void {
	db.prepare(
		`INSERT OR IGNORE INTO run_ownership
		 (singleton, incarnation_id, ownership_status,
		  fence_token)
		 VALUES (1, ?, 'FREE', 0)`,
	).run(incarnationId);
}

// ---------------------------------------------------------------------------
// CAS acquisition
// ---------------------------------------------------------------------------

const CAS_SQL = `
UPDATE run_ownership
SET
    ownership_status    = 'HELD',
    owner_token         = :new_owner_token,
    owner_pid           = :new_owner_pid,
    fence_token         = fence_token + 1,
    acquired_at_epoch_ms = :now_epoch,
    lease_until_epoch_ms = :lease_until
WHERE singleton = 1
  AND incarnation_id     = :incarnation_id
  AND ownership_status   = :prev_status
  AND fence_token        = :prev_fence
  AND owner_token        IS :prev_owner_token
  AND lease_until_epoch_ms IS :prev_lease
RETURNING incarnation_id, owner_token, fence_token, lease_until_epoch_ms
`;

interface CasRow {
	incarnation_id: string;
	owner_token: string;
	fence_token: number | bigint;
	lease_until_epoch_ms: number;
}

function attemptCas(
	db: SqliteConnection,
	incarnationId: string,
	predecessor: OwnershipPredecessor,
	ownerToken: string,
	ownerPid: number,
	nowEpochMs: number,
	leaseDurationMs: number,
): CasRow | null {
	const stmt = db.prepare(CAS_SQL);
	const row = stmt.get({
		":new_owner_token": ownerToken,
		":new_owner_pid": ownerPid,
		":now_epoch": nowEpochMs,
		":lease_until": nowEpochMs + leaseDurationMs,
		":incarnation_id": incarnationId,
		":prev_status": predecessor.status,
		":prev_fence": predecessor.fenceToken,
		":prev_owner_token": predecessor.ownerToken,
		":prev_lease": predecessor.leaseUntilEpochMs,
	}) as CasRow | undefined;

	return row ?? null;
}

// ---------------------------------------------------------------------------
// Transaction helpers
// ---------------------------------------------------------------------------

export function beginImmediate(db: SqliteConnection): void {
	db.exec("BEGIN IMMEDIATE");
}

export function commit(db: SqliteConnection): void {
	db.exec("COMMIT");
}

export function rollback(db: SqliteConnection): void {
	try {
		db.exec("ROLLBACK");
	} catch {
		// Best-effort — the transaction may already be closed.
	}
}

function isBusy(error: unknown): boolean {
	const msg = String(error);
	return msg.includes("SQLITE_BUSY") || msg.includes("database is locked");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Acquire ownership with CAS semantics. */
export function acquireOwnership(params: AcquireParams): AcquireResult {
	const {
		db,
		runId,
		orchestratorName,
		nowEpochMs,
		nowIso,
		leaseDurationMs,
		contentionDeadlineMs,
	} = params;

	const deadlineMs = performance.now() + contentionDeadlineMs;

	// Ensure incarnation and ownership row exist (idempotent).
	const incarnationId = ensureIncarnation(
		db,
		runId,
		orchestratorName,
		nowEpochMs,
		nowIso,
	);
	ensureOwnershipRow(db, incarnationId);

	// Observe predecessor (outside transaction — observation is not authority).
	const predecessor = readPredecessor(db);
	if (predecessor === null) {
		return {
			kind: "DB_FAILURE",
			cause: new DbIntegrityError("ownership row missing"),
		};
	}

	// Active owner check.
	if (predecessor.status === "HELD" && predecessor.leaseUntilEpochMs !== null) {
		if (nowEpochMs <= predecessor.leaseUntilEpochMs) {
			const ownerRow = db
				.prepare("SELECT owner_pid FROM run_ownership WHERE singleton = 1")
				.get() as { owner_pid: number } | undefined;
			return {
				kind: "ACTIVE_CONFLICT",
				ownerPid: ownerRow?.owner_pid ?? 0,
				leaseUntilEpochMs: predecessor.leaseUntilEpochMs,
			};
		}
	}

	const ownerToken = generateRunId();
	const ownerPid = process.pid;

	// Retry loop for SQLITE_BUSY and CAS misses.
	const maxAttempts = 10;
	for (let attempt = 0; attempt < maxAttempts; attempt++) {
		if (performance.now() > deadlineMs) break;

		const currentPredecessor = readPredecessor(db);
		if (currentPredecessor === null) {
			return {
				kind: "DB_FAILURE",
				cause: new DbIntegrityError("ownership row missing during retry"),
			};
		}

		// Re-check active owner (another contender may have won).
		if (
			currentPredecessor.status === "HELD" &&
			currentPredecessor.leaseUntilEpochMs !== null &&
			nowEpochMs <= currentPredecessor.leaseUntilEpochMs
		) {
			const ownerRow = db
				.prepare("SELECT owner_pid FROM run_ownership WHERE singleton = 1")
				.get() as { owner_pid: number } | undefined;
			return {
				kind: "ACTIVE_CONFLICT",
				ownerPid: ownerRow?.owner_pid ?? 0,
				leaseUntilEpochMs: currentPredecessor.leaseUntilEpochMs,
			};
		}

		try {
			beginImmediate(db);
		} catch (error) {
			if (isBusy(error)) continue;
			rollback(db);
			return { kind: "DB_FAILURE", cause: error };
		}

		let casRow: CasRow | null;
		try {
			casRow = attemptCas(
				db,
				incarnationId,
				currentPredecessor,
				ownerToken,
				ownerPid,
				nowEpochMs,
				leaseDurationMs,
			);
		} catch (error) {
			rollback(db);
			if (isBusy(error)) continue;
			return { kind: "DB_FAILURE", cause: error };
		}

		if (casRow === null) {
			rollback(db);
			continue;
		}

		try {
			commit(db);
		} catch (error) {
			rollback(db);
			if (isBusy(error)) continue;
			return { kind: "DB_FAILURE", cause: error };
		}

		return {
			kind: "ACQUIRED",
			handle: {
				ownerToken: casRow.owner_token,
				incarnationId: casRow.incarnation_id,
				fenceToken: bigintFromRow(casRow.fence_token),
				leaseUntilEpochMs: casRow.lease_until_epoch_ms,
			},
		};
	}

	// Deadline exhausted.  Distinguish CAS miss from busy timeout.
	const finalPredecessor = readPredecessor(db);
	if (
		finalPredecessor !== null &&
		finalPredecessor.fenceToken !== predecessor.fenceToken
	) {
		return { kind: "PREDECESSOR_CAS_MISS" };
	}
	return { kind: "DB_CONTENTION_TIMEOUT" };
}

// ---------------------------------------------------------------------------
// Operation result (shared across refresh, release, state commit)
// ---------------------------------------------------------------------------

export type OwnershipOperationResult =
	| { readonly kind: "SUCCESS"; readonly handle: LockHandle }
	| { readonly kind: "STALE_HANDLE" }
	| { readonly kind: "EXPIRED_HANDLE" }
	| { readonly kind: "DB_FAILURE"; readonly cause: unknown };

// ---------------------------------------------------------------------------
// Refresh
// ---------------------------------------------------------------------------

const REFRESH_SQL = `
UPDATE run_ownership
SET lease_until_epoch_ms = :new_lease
WHERE singleton = 1
  AND ownership_status = 'HELD'
  AND incarnation_id = :incarnation_id
  AND owner_token = :owner_token
  AND fence_token = :fence_token
  AND lease_until_epoch_ms > :now_epoch
RETURNING incarnation_id, owner_token, fence_token, lease_until_epoch_ms
`;

export interface RefreshParams {
	readonly db: SqliteConnection;
	readonly handle: LockHandle;
	readonly nowEpochMs: number;
	readonly leaseDurationMs: number;
}

export function refreshOwnership(
	params: RefreshParams,
): OwnershipOperationResult {
	const { db, handle, nowEpochMs, leaseDurationMs } = params;

	try {
		beginImmediate(db);
	} catch (error) {
		return { kind: "DB_FAILURE", cause: error };
	}

	try {
		const row = db.prepare(REFRESH_SQL).get({
			":new_lease": nowEpochMs + leaseDurationMs,
			":incarnation_id": handle.incarnationId,
			":owner_token": handle.ownerToken,
			":fence_token": handle.fenceToken,
			":now_epoch": nowEpochMs,
		}) as CasRow | undefined;

		if (row === undefined) {
			rollback(db);
			// Distinguish stale from expired.
			const current = readPredecessor(db);
			if (current === null) {
				return {
					kind: "DB_FAILURE",
					cause: new DbIntegrityError("ownership row missing"),
				};
			}
			if (
				current.status === "HELD" &&
				current.incarnationId === handle.incarnationId &&
				current.ownerToken === handle.ownerToken &&
				current.fenceToken === handle.fenceToken &&
				current.leaseUntilEpochMs !== null &&
				nowEpochMs > current.leaseUntilEpochMs
			) {
				return { kind: "EXPIRED_HANDLE" };
			}
			return { kind: "STALE_HANDLE" };
		}

		try {
			commit(db);
		} catch (error) {
			rollback(db);
			return { kind: "DB_FAILURE", cause: error };
		}

		return {
			kind: "SUCCESS",
			handle: {
				ownerToken: row.owner_token,
				incarnationId: row.incarnation_id,
				fenceToken: bigintFromRow(row.fence_token),
				leaseUntilEpochMs: row.lease_until_epoch_ms,
			},
		};
	} catch (error) {
		rollback(db);
		return { kind: "DB_FAILURE", cause: error };
	}
}

// ---------------------------------------------------------------------------
// Release
// ---------------------------------------------------------------------------

const RELEASE_SQL = `
UPDATE run_ownership
SET
    ownership_status = 'FREE',
    owner_token = NULL,
    owner_pid = NULL,
    acquired_at_epoch_ms = NULL,
    lease_until_epoch_ms = NULL
WHERE singleton = 1
  AND ownership_status = 'HELD'
  AND incarnation_id = :incarnation_id
  AND owner_token = :owner_token
  AND fence_token = :fence_token
RETURNING fence_token
`;

export interface ReleaseParams {
	readonly db: SqliteConnection;
	readonly handle: LockHandle;
}

export function releaseOwnership(
	params: ReleaseParams,
): OwnershipOperationResult {
	const { db, handle } = params;

	try {
		beginImmediate(db);
	} catch (error) {
		return { kind: "DB_FAILURE", cause: error };
	}

	try {
		const row = db.prepare(RELEASE_SQL).get({
			":incarnation_id": handle.incarnationId,
			":owner_token": handle.ownerToken,
			":fence_token": handle.fenceToken,
		}) as { fence_token: number | bigint } | undefined;

		if (row === undefined) {
			rollback(db);
			return { kind: "STALE_HANDLE" };
		}

		try {
			commit(db);
		} catch (error) {
			rollback(db);
			return { kind: "DB_FAILURE", cause: error };
		}

		return {
			kind: "SUCCESS",
			handle: {
				...handle,
				fenceToken: bigintFromRow(row.fence_token),
			},
		};
	} catch (error) {
		rollback(db);
		return { kind: "DB_FAILURE", cause: error };
	}
}
