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
import { generateRunId } from "../../services/run-id.js";
import { DbIntegrityError } from "./errors.js";
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function bigintFromRow(value) {
    if (typeof value === "bigint")
        return value;
    if (typeof value === "number")
        return BigInt(value);
    throw new DbIntegrityError(`expected bigint, got ${typeof value}`);
}
function readPredecessor(db) {
    const row = db
        .prepare(`SELECT incarnation_id, ownership_status, owner_token,
			        fence_token, lease_until_epoch_ms
			 FROM run_ownership
			 WHERE singleton = 1`)
        .get();
    if (row === undefined)
        return null;
    return {
        incarnationId: row.incarnation_id,
        status: row.ownership_status,
        ownerToken: row.owner_token,
        fenceToken: bigintFromRow(row.fence_token),
        leaseUntilEpochMs: row.lease_until_epoch_ms,
    };
}
function ensureIncarnation(db, runId, orchestratorName, nowEpochMs, nowIso) {
    // Read the full identity row — not just incarnation_id.
    // An existing incarnation whose run_id or orchestrator_name
    // does not match means the DB was placed in the wrong RUN_DIR.
    const existing = db
        .prepare("SELECT run_id, incarnation_id, orchestrator_name FROM run_incarnation WHERE singleton = 1")
        .get();
    if (existing !== undefined) {
        if (existing.run_id !== runId) {
            throw new DbIntegrityError(`run_incarnation run_id mismatch: expected ${runId}, got ${existing.run_id}`);
        }
        if (existing.orchestrator_name !== orchestratorName) {
            throw new DbIntegrityError(`run_incarnation orchestrator_name mismatch: expected ${orchestratorName}, got ${existing.orchestrator_name}`);
        }
        return existing.incarnation_id;
    }
    const incarnationId = generateRunId();
    db.prepare(`INSERT OR IGNORE INTO run_incarnation
		 (singleton, run_id, incarnation_id, orchestrator_name,
		  created_at_epoch_ms, created_at_iso)
		 VALUES (1, ?, ?, ?, ?, ?)`).run(runId, incarnationId, orchestratorName, nowEpochMs, nowIso);
    // Re-read in case another process inserted first — and validate.
    const inserted = db
        .prepare("SELECT run_id, incarnation_id, orchestrator_name FROM run_incarnation WHERE singleton = 1")
        .get();
    if (inserted !== undefined) {
        if (inserted.run_id !== runId) {
            throw new DbIntegrityError(`run_incarnation run_id mismatch after race: expected ${runId}, got ${inserted.run_id}`);
        }
        if (inserted.orchestrator_name !== orchestratorName) {
            throw new DbIntegrityError(`run_incarnation orchestrator_name mismatch after race: expected ${orchestratorName}, got ${inserted.orchestrator_name}`);
        }
        return inserted.incarnation_id;
    }
    return incarnationId;
}
function ensureOwnershipRow(db, incarnationId) {
    db.prepare(`INSERT OR IGNORE INTO run_ownership
		 (singleton, incarnation_id, ownership_status,
		  fence_token)
		 VALUES (1, ?, 'FREE', 0)`).run(incarnationId);
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
function attemptCas(db, incarnationId, predecessor, ownerToken, ownerPid, nowEpochMs, leaseDurationMs) {
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
    });
    return row ?? null;
}
// ---------------------------------------------------------------------------
// Transaction helpers
// ---------------------------------------------------------------------------
export function beginImmediate(db) {
    db.exec("BEGIN IMMEDIATE");
}
export function commit(db) {
    db.exec("COMMIT");
}
export function rollback(db) {
    try {
        db.exec("ROLLBACK");
    }
    catch {
        // Best-effort — the transaction may already be closed.
    }
}
// ---------------------------------------------------------------------------
// In-transaction helpers (no BEGIN/COMMIT/ROLLBACK)
// ---------------------------------------------------------------------------
// These primitives must be called inside an existing transaction.  They
// never publish LockHandle — only the top-level transactional scope does.
/** Ensure the incarnation row exists within an active transaction.
 *
 *  If no row exists, the supplied `incarnationCandidate` is inserted.
 *  If a row already exists, its identity is validated and its
 *  `incarnation_id` is returned — the candidate is discarded.
 *
 *  Idempotent; never replaces an existing incarnation identity. */
export function ensureIncarnationInTransaction(db, runId, incarnationCandidate, orchestratorName, nowEpochMs, nowIso) {
    const existing = db
        .prepare("SELECT run_id, incarnation_id, orchestrator_name FROM run_incarnation WHERE singleton = 1")
        .get();
    if (existing !== undefined) {
        if (existing.run_id !== runId) {
            throw new DbIntegrityError(`run_incarnation run_id mismatch: expected ${runId}, got ${existing.run_id}`);
        }
        if (existing.orchestrator_name !== orchestratorName) {
            throw new DbIntegrityError(`run_incarnation orchestrator_name mismatch: expected ${orchestratorName}, got ${existing.orchestrator_name}`);
        }
        return existing.incarnation_id;
    }
    db.prepare(`INSERT OR IGNORE INTO run_incarnation
		 (singleton, run_id, incarnation_id, orchestrator_name,
		  created_at_epoch_ms, created_at_iso)
		 VALUES (1, ?, ?, ?, ?, ?)`).run(runId, incarnationCandidate, orchestratorName, nowEpochMs, nowIso);
    // Re-read — the INSERT OR IGNORE may have been a no-op if another
    // connection raced (unlikely under BEGIN IMMEDIATE but safe).
    const inserted = db
        .prepare("SELECT run_id, incarnation_id, orchestrator_name FROM run_incarnation WHERE singleton = 1")
        .get();
    if (inserted !== undefined) {
        if (inserted.run_id !== runId) {
            throw new DbIntegrityError(`run_incarnation run_id mismatch after race: expected ${runId}, got ${inserted.run_id}`);
        }
        if (inserted.orchestrator_name !== orchestratorName) {
            throw new DbIntegrityError(`run_incarnation orchestrator_name mismatch after race: expected ${orchestratorName}, got ${inserted.orchestrator_name}`);
        }
        return inserted.incarnation_id;
    }
    return incarnationCandidate;
}
/** Ensure the ownership singleton row exists (FREE, fence_token = 0)
 *  within an active transaction.  Idempotent.
 *
 *  If a row already exists, validates that it references the expected
 *  incarnation.  Throws DbIntegrityError on mismatch. */
export function ensureOwnershipRowInTransaction(db, incarnationId) {
    db.prepare(`INSERT OR IGNORE INTO run_ownership
		 (singleton, incarnation_id, ownership_status,
		  fence_token)
		 VALUES (1, ?, 'FREE', 0)`).run(incarnationId);
    // Re-read to validate — a pre-existing row with a different
    // incarnation_id must be detected and rejected.
    const existing = db
        .prepare("SELECT incarnation_id FROM run_ownership WHERE singleton = 1")
        .get();
    if (existing !== undefined && existing.incarnation_id !== incarnationId) {
        throw new DbIntegrityError(`run_ownership incarnation_id mismatch: expected ${incarnationId}, got ${existing.incarnation_id}`);
    }
}
/** Directly set ownership to HELD within an active transaction.
 *
 *  No CAS retry loop — the caller holds BEGIN IMMEDIATE and is the only
 *  writer.  The fence token is read from the current row and incremented.
 *
 *  Returns null if the ownership is actively held by another owner
 *  (lease not yet expired).  The caller must ROLLBACK and report
 *  ACTIVE_CONFLICT. */
export function acquireOwnershipDirectInTransaction(db, incarnationId, ownerToken, ownerPid, nowEpochMs, leaseDurationMs) {
    // Read current ownership state.
    const row = db
        .prepare("SELECT ownership_status, fence_token, lease_until_epoch_ms FROM run_ownership WHERE singleton = 1 AND incarnation_id = ?")
        .get(incarnationId);
    if (row === undefined) {
        throw new DbIntegrityError("ownership row missing in transaction");
    }
    // Active owner check.
    if (row.ownership_status === "HELD" &&
        row.lease_until_epoch_ms !== null &&
        nowEpochMs < row.lease_until_epoch_ms) {
        return null; // ACTIVE_CONFLICT
    }
    const newFence = bigintFromRow(row.fence_token) + 1n;
    const leaseUntil = nowEpochMs + leaseDurationMs;
    db.prepare(`UPDATE run_ownership
		 SET ownership_status = 'HELD',
		     owner_token = ?,
		     owner_pid = ?,
		     fence_token = ?,
		     acquired_at_epoch_ms = ?,
		     lease_until_epoch_ms = ?
		 WHERE singleton = 1
		   AND incarnation_id = ?`).run(ownerToken, ownerPid, newFence, nowEpochMs, leaseUntil, incarnationId);
    return { fenceToken: newFence, leaseUntilEpochMs: leaseUntil };
}
/** Read the current incarnation_id from the ownership row (within a
 *  transaction or outside).  Returns null if no ownership row exists. */
export function readOwnershipIncarnationId(db) {
    const row = db
        .prepare("SELECT incarnation_id FROM run_ownership WHERE singleton = 1")
        .get();
    return row?.incarnation_id ?? null;
}
function isBusy(error) {
    const msg = String(error);
    return msg.includes("SQLITE_BUSY") || msg.includes("database is locked");
}
// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
/** Acquire ownership with CAS semantics. */
export function acquireOwnership(params) {
    const { db, runId, orchestratorName, nowEpochMs, nowIso, leaseDurationMs, contentionDeadlineMs, } = params;
    const deadlineMs = performance.now() + contentionDeadlineMs;
    // Ensure incarnation and ownership row exist (idempotent).
    const incarnationId = ensureIncarnation(db, runId, orchestratorName, nowEpochMs, nowIso);
    ensureOwnershipRow(db, incarnationId);
    // Observe predecessor (outside transaction — observation is not authority).
    const predecessor = readPredecessor(db);
    if (predecessor === null) {
        return {
            kind: "DB_FAILURE",
            cause: new DbIntegrityError("ownership row missing"),
        };
    }
    // Active owner check — advisory heuristic only.  Uses the real clock,
    // not the caller-supplied timestamp, to avoid false ACTIVE_CONFLICT
    // when the caller's clock was captured before a potential wait.
    if (predecessor.status === "HELD" && predecessor.leaseUntilEpochMs !== null) {
        if (Date.now() < predecessor.leaseUntilEpochMs) {
            const ownerRow = db
                .prepare("SELECT owner_pid FROM run_ownership WHERE singleton = 1")
                .get();
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
        if (performance.now() > deadlineMs)
            break;
        const currentPredecessor = readPredecessor(db);
        if (currentPredecessor === null) {
            return {
                kind: "DB_FAILURE",
                cause: new DbIntegrityError("ownership row missing during retry"),
            };
        }
        try {
            beginImmediate(db);
        }
        catch (error) {
            if (isBusy(error))
                continue;
            rollback(db);
            return { kind: "DB_FAILURE", cause: error };
        }
        // Capture clock AFTER lock acquisition — the wait for
        // BEGIN IMMEDIATE (governed by busy_timeout) must not
        // produce a stale lease computation.  Use the provided
        // lease clock if available, otherwise the real clock.
        const lockEpochMs = (params.leaseClockEpochMs ?? Date.now)();
        // Active-owner check AFTER lock acquisition with fresh clock.
        // The pre-lock predecessor observation may be stale; the
        // authoritative decision uses lockEpochMs captured above.
        if (currentPredecessor.status === "HELD" &&
            currentPredecessor.leaseUntilEpochMs !== null &&
            lockEpochMs < currentPredecessor.leaseUntilEpochMs) {
            rollback(db);
            const ownerRow = db
                .prepare("SELECT owner_pid FROM run_ownership WHERE singleton = 1")
                .get();
            return {
                kind: "ACTIVE_CONFLICT",
                ownerPid: ownerRow?.owner_pid ?? 0,
                leaseUntilEpochMs: currentPredecessor.leaseUntilEpochMs,
            };
        }
        let casRow;
        try {
            casRow = attemptCas(db, incarnationId, currentPredecessor, ownerToken, ownerPid, lockEpochMs, leaseDurationMs);
        }
        catch (error) {
            rollback(db);
            if (isBusy(error))
                continue;
            return { kind: "DB_FAILURE", cause: error };
        }
        if (casRow === null) {
            rollback(db);
            continue;
        }
        try {
            commit(db);
        }
        catch (error) {
            rollback(db);
            if (isBusy(error))
                continue;
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
    if (finalPredecessor !== null &&
        finalPredecessor.fenceToken !== predecessor.fenceToken) {
        return { kind: "PREDECESSOR_CAS_MISS" };
    }
    return { kind: "DB_CONTENTION_TIMEOUT" };
}
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
export function refreshOwnership(params) {
    const { db, handle, nowEpochMs: _nowEpochMs, leaseDurationMs } = params;
    try {
        beginImmediate(db);
    }
    catch (error) {
        return { kind: "DB_FAILURE", cause: error };
    }
    // Capture clock AFTER lock acquisition — the wait for
    // BEGIN IMMEDIATE (governed by busy_timeout) must not
    // produce a stale lease check.  Use the provided lease
    // clock if available, otherwise the real clock.
    const lockEpochMs = (params.leaseClockEpochMs ?? Date.now)();
    try {
        const row = db.prepare(REFRESH_SQL).get({
            ":new_lease": lockEpochMs + leaseDurationMs,
            ":incarnation_id": handle.incarnationId,
            ":owner_token": handle.ownerToken,
            ":fence_token": handle.fenceToken,
            ":now_epoch": lockEpochMs,
        });
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
            if (current.status === "HELD" &&
                current.incarnationId === handle.incarnationId &&
                current.ownerToken === handle.ownerToken &&
                current.fenceToken === handle.fenceToken &&
                current.leaseUntilEpochMs !== null &&
                lockEpochMs >= current.leaseUntilEpochMs) {
                return { kind: "EXPIRED_HANDLE" };
            }
            return { kind: "STALE_HANDLE" };
        }
        try {
            commit(db);
        }
        catch (error) {
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
    }
    catch (error) {
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
export function releaseOwnership(params) {
    const { db, handle } = params;
    try {
        beginImmediate(db);
    }
    catch (error) {
        return { kind: "DB_FAILURE", cause: error };
    }
    try {
        const row = db.prepare(RELEASE_SQL).get({
            ":incarnation_id": handle.incarnationId,
            ":owner_token": handle.ownerToken,
            ":fence_token": handle.fenceToken,
        });
        if (row === undefined) {
            rollback(db);
            return { kind: "STALE_HANDLE" };
        }
        try {
            commit(db);
        }
        catch (error) {
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
    }
    catch (error) {
        rollback(db);
        return { kind: "DB_FAILURE", cause: error };
    }
}
//# sourceMappingURL=ownership.js.map