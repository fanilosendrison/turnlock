// Authoritative state store — state mutations committed under the fence token.
//
// Every commit CAS on (incarnation_id, owner_token, fence_token, lease,
// state_revision).  The `state.json` file is a projection, not the authority.
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { LEGACY_PENDING_INITIAL_DISPATCH_STATE_FIELD, LEGACY_PENDING_INITIAL_DISPATCH_VERSION_STATE_FIELD, PENDING_INITIAL_DISPATCH_STATE_FIELD, PENDING_INITIAL_DISPATCH_VERSION, PENDING_INITIAL_DISPATCH_VERSION_STATE_FIELD, STATE_SCHEMA_VERSION, } from "../../constants.js";
import { AuthorityLostError, PersistenceFailureError, } from "../../errors/concrete.js";
import { DbIntegrityError } from "./errors.js";
import { beginImmediate, commit, rollback, } from "./ownership.js";
const productionProjectionDependencies = {};
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
function computeDigest(jsonStr) {
    return `sha256:${createHash("sha256").update(jsonStr).digest("hex")}`;
}
/**
 * Recognise a pending initial-dispatch marker written by either the current
 * build (new field names) or a v0.10.0 build (legacy field names).
 *
 * Both pairs must be present and version-matched; an unversioned legacy
 * boolean alone is not sufficient (fail-closed against pre-claim builds
 * that only wrote the boolean).
 */
function isPendingInitialDispatchV1(parsed) {
    const newMarker = parsed[PENDING_INITIAL_DISPATCH_STATE_FIELD] === true &&
        parsed[PENDING_INITIAL_DISPATCH_VERSION_STATE_FIELD] ===
            PENDING_INITIAL_DISPATCH_VERSION;
    const legacyMarker = parsed[LEGACY_PENDING_INITIAL_DISPATCH_STATE_FIELD] === true &&
        parsed[LEGACY_PENDING_INITIAL_DISPATCH_VERSION_STATE_FIELD] ===
            PENDING_INITIAL_DISPATCH_VERSION;
    return newMarker || legacyMarker;
}
/** True when any recognised marker pair (new or legacy) is present. */
function hasAnyPendingInitialDispatchMarker(parsed) {
    return isPendingInitialDispatchV1(parsed);
}
/**
 * Remove every known form of the pending-dispatch marker from the state
 * object so the committed row is clean regardless of which build created it.
 */
function stripAllPendingInitialDispatchMarkers(state) {
    delete state[PENDING_INITIAL_DISPATCH_STATE_FIELD];
    delete state[PENDING_INITIAL_DISPATCH_VERSION_STATE_FIELD];
    delete state[LEGACY_PENDING_INITIAL_DISPATCH_STATE_FIELD];
    delete state[LEGACY_PENDING_INITIAL_DISPATCH_VERSION_STATE_FIELD];
}
// ---------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------
const COMMIT_STATE_SQL = `
UPDATE run_state
SET
    state_revision = state_revision + 1,
    state_schema_version = :schema_version,
    state_json = :state_json,
    state_digest = :state_digest,
    committed_by_owner_token = :owner_token,
    committed_by_fence_token = :fence_token,
    committed_at_epoch_ms = :now_epoch,
    committed_at_iso = :now_iso
WHERE singleton = 1
  AND incarnation_id = :incarnation_id
  AND state_revision = :expected_revision
  AND EXISTS (
      SELECT 1
      FROM run_ownership
      WHERE run_ownership.singleton = 1
        AND run_ownership.incarnation_id = :incarnation_id
        AND run_ownership.ownership_status = 'HELD'
        AND run_ownership.owner_token = :owner_token
        AND run_ownership.fence_token = :fence_token
        AND run_ownership.lease_until_epoch_ms > :now_epoch
  )
RETURNING
    state_revision,
    state_json,
    state_digest,
    committed_by_fence_token
`;
const READ_STATE_SQL = `
SELECT
    rs.state_schema_version,
    rs.state_json,
    rs.state_digest,
    rs.state_revision,
    rs.committed_by_fence_token,
    ri.run_id,
    ri.orchestrator_name,
    ri.incarnation_id,
    ri.created_at_iso AS started_at,
    ri.created_at_epoch_ms AS started_at_epoch_ms
FROM run_state rs
JOIN run_incarnation ri ON ri.incarnation_id = rs.incarnation_id
WHERE rs.singleton = 1
`;
const READ_RAW_STATE_JSON_SQL = `
SELECT state_json
FROM run_state
WHERE singleton = 1
`;
// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
const INITIALIZE_STATE_SQL = `
INSERT INTO run_state (
    singleton,
    incarnation_id,
    state_revision,
    state_schema_version,
    state_json,
    state_digest,
    committed_by_owner_token,
    committed_by_fence_token,
    committed_at_epoch_ms,
    committed_at_iso
)
SELECT
    1,
    :incarnation_id,
    0,
    :schema_version,
    :state_json,
    :state_digest,
    :owner_token,
    :fence_token,
    :now_epoch,
    :now_iso
WHERE EXISTS (
    SELECT 1
    FROM run_ownership
    WHERE singleton = 1
      AND incarnation_id = :incarnation_id
      AND ownership_status = 'HELD'
      AND owner_token = :owner_token
      AND fence_token = :fence_token
      AND lease_until_epoch_ms > :now_epoch
)
  AND NOT EXISTS (
    SELECT 1 FROM run_state WHERE singleton = 1
  )
RETURNING
    state_revision,
    state_json,
    state_digest,
    committed_by_fence_token
`;
/** Establish the initial authoritative state row under the current fence.
 *
 *  Unlike the legacy `ensureInitialStateRow` (which used a blind
 *  INSERT OR IGNORE with fake metadata), this primitive gates the
 *  insertion on the caller still holding a valid ownership lease.  A
 *  stale or expired handle cannot establish initial authority.
 *
 *  Returns `INITIALIZED` with the authoritative `CommittedState`
 *  (containing the real `owner_token`, `fence_token`, and digest),
 *  or `ALREADY_INITIALIZED` if a state row already exists (the
 *  existing row is re-read and returned so the caller can distinguish
 *  this from a fencing failure). */
export function initializeStateUnderFence(params) {
    const { db, handle, initialState, nowEpochMs: _nowEpochMs, nowIso: _nowIso, } = params;
    const schemaVersion = initialState.schemaVersion ?? STATE_SCHEMA_VERSION;
    const jsonStr = JSON.stringify(initialState);
    const digest = computeDigest(jsonStr);
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
    const lockIso = new Date(lockEpochMs).toISOString();
    try {
        const row = db.prepare(INITIALIZE_STATE_SQL).get({
            ":incarnation_id": handle.incarnationId,
            ":schema_version": schemaVersion,
            ":state_json": jsonStr,
            ":state_digest": digest,
            ":owner_token": handle.ownerToken,
            ":fence_token": handle.fenceToken,
            ":now_epoch": lockEpochMs,
            ":now_iso": lockIso,
        });
        if (row !== undefined) {
            // Insert succeeded — commit and return the authoritative state.
            try {
                commit(db);
            }
            catch (error) {
                rollback(db);
                return { kind: "DB_FAILURE", cause: error };
            }
            const revision = String(bigintFromRow(row.state_revision));
            return {
                kind: "INITIALIZED",
                committed: {
                    state: {
                        ...initialState,
                        runIncarnationId: handle.incarnationId,
                        stateRevision: revision,
                        committedFenceToken: String(bigintFromRow(row.committed_by_fence_token)),
                    },
                    stateDigest: row.state_digest,
                },
            };
        }
        // Insert returned no row.  Diagnose why.
        //
        // CRITICAL: check ownership BEFORE checking whether run_state
        // exists.  A stale or expired handle must not be reported as
        // ALREADY_INITIALIZED — the caller would continue with a handle
        // it no longer owns.
        rollback(db);
        // Read ownership first.
        const ownershipRow = db
            .prepare(`SELECT ownership_status, owner_token, fence_token,
				        lease_until_epoch_ms
				 FROM run_ownership WHERE singleton = 1`)
            .get();
        if (ownershipRow === undefined) {
            return {
                kind: "DB_FAILURE",
                cause: new DbIntegrityError("ownership row missing during initialization"),
            };
        }
        if (ownershipRow.ownership_status !== "HELD") {
            return { kind: "STALE_HANDLE" };
        }
        if (ownershipRow.owner_token !== handle.ownerToken) {
            return { kind: "STALE_HANDLE" };
        }
        if (bigintFromRow(ownershipRow.fence_token) !== handle.fenceToken) {
            return { kind: "STALE_HANDLE" };
        }
        if (ownershipRow.lease_until_epoch_ms !== null &&
            lockEpochMs >= ownershipRow.lease_until_epoch_ms) {
            return { kind: "EXPIRED_HANDLE" };
        }
        // Ownership is still valid.  Now check whether run_state exists.
        const existing = db
            .prepare("SELECT 1 FROM run_state WHERE singleton = 1")
            .get();
        if (existing !== undefined) {
            const read = readAuthoritativeState(db);
            if (read.state !== null) {
                return {
                    kind: "ALREADY_INITIALIZED",
                    state: read.state,
                    digest: read.digest ?? "",
                };
            }
            return {
                kind: "DB_FAILURE",
                cause: new DbIntegrityError("run_state row exists but could not be read"),
            };
        }
        // Ownership valid, no state row — the INSERT condition failed
        // for an unknown reason (should not happen since ownership matches).
        return {
            kind: "DB_FAILURE",
            cause: new DbIntegrityError("initialize state failed for unknown reason"),
        };
    }
    catch (error) {
        rollback(db);
        return { kind: "DB_FAILURE", cause: error };
    }
}
export function commitState(params) {
    const { db, handle, expectedRevision, nextState, nowEpochMs: _nowEpochMs, nowIso: _nowIso, } = params;
    const expectedRevisionBigInt = BigInt(expectedRevision);
    const jsonStr = JSON.stringify(nextState);
    const digest = computeDigest(jsonStr);
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
    const lockIso = new Date(lockEpochMs).toISOString();
    try {
        const row = db.prepare(COMMIT_STATE_SQL).get({
            ":schema_version": nextState.schemaVersion,
            ":state_json": jsonStr,
            ":state_digest": digest,
            ":owner_token": handle.ownerToken,
            ":fence_token": handle.fenceToken,
            ":now_epoch": lockEpochMs,
            ":now_iso": lockIso,
            ":incarnation_id": handle.incarnationId,
            ":expected_revision": expectedRevisionBigInt,
        });
        if (row === undefined) {
            rollback(db);
            // Diagnose why the CAS failed.
            const ownershipRow = db
                .prepare(`SELECT ownership_status, owner_token, fence_token,
					        lease_until_epoch_ms
					 FROM run_ownership WHERE singleton = 1`)
                .get();
            if (ownershipRow === undefined) {
                return {
                    kind: "DB_FAILURE",
                    cause: new DbIntegrityError("ownership row missing during commit"),
                };
            }
            if (ownershipRow.ownership_status !== "HELD") {
                return { kind: "STALE_HANDLE" };
            }
            if (ownershipRow.owner_token !== handle.ownerToken) {
                return { kind: "STALE_HANDLE" };
            }
            if (bigintFromRow(ownershipRow.fence_token) !== handle.fenceToken) {
                return { kind: "STALE_HANDLE" };
            }
            if (lockEpochMs >= ownershipRow.lease_until_epoch_ms) {
                return { kind: "EXPIRED_HANDLE" };
            }
            // Ownership matches but revision doesn't.
            const stateRow = db
                .prepare("SELECT state_revision FROM run_state WHERE singleton = 1")
                .get();
            if (stateRow !== undefined &&
                bigintFromRow(stateRow.state_revision) !== expectedRevisionBigInt) {
                return { kind: "REVISION_CONFLICT" };
            }
            return {
                kind: "DB_FAILURE",
                cause: new DbIntegrityError("state commit failed for unknown reason"),
            };
        }
        try {
            commit(db);
        }
        catch (error) {
            rollback(db);
            return { kind: "DB_FAILURE", cause: error };
        }
        return {
            kind: "COMMITTED",
            committed: {
                state: {
                    ...nextState,
                    runIncarnationId: handle.incarnationId,
                    stateRevision: String(bigintFromRow(row.state_revision)),
                    committedFenceToken: String(bigintFromRow(row.committed_by_fence_token)),
                },
                stateDigest: row.state_digest,
            },
        };
    }
    catch (error) {
        rollback(db);
        return { kind: "DB_FAILURE", cause: error };
    }
}
function diagnoseClaimInitialDispatchUpdateFailure(db, handle, lockEpochMs) {
    const ownershipRow = db
        .prepare(`SELECT ownership_status, owner_token, fence_token, lease_until_epoch_ms
			 FROM run_ownership WHERE singleton = 1`)
        .get();
    if (ownershipRow === undefined) {
        return {
            kind: "DB_FAILURE",
            cause: new DbIntegrityError("ownership row missing during initial dispatch claim"),
        };
    }
    if (ownershipRow.ownership_status !== "HELD") {
        return { kind: "STALE_HANDLE" };
    }
    if (ownershipRow.owner_token !== handle.ownerToken) {
        return { kind: "STALE_HANDLE" };
    }
    if (bigintFromRow(ownershipRow.fence_token) !== handle.fenceToken) {
        return { kind: "STALE_HANDLE" };
    }
    if (ownershipRow.lease_until_epoch_ms === null ||
        lockEpochMs >= ownershipRow.lease_until_epoch_ms) {
        return { kind: "EXPIRED_HANDLE" };
    }
    const stateRow = db
        .prepare("SELECT state_revision FROM run_state WHERE singleton = 1")
        .get();
    if (stateRow === undefined) {
        return {
            kind: "DB_FAILURE",
            cause: new DbIntegrityError("state row missing during initial dispatch claim"),
        };
    }
    if (bigintFromRow(stateRow.state_revision) !== 0n) {
        return { kind: "REVISION_CONFLICT" };
    }
    return {
        kind: "DB_FAILURE",
        cause: new DbIntegrityError("initial dispatch claim failed for unknown reason"),
    };
}
/**
 * Atomically consume the one-time authorization to invoke a run's initial
 * phase. A crash after this commit is deliberately fail-closed: no successor
 * may infer that invoking the phase is safe.
 */
export function claimInitialDispatchUnderFence(params) {
    const { db, handle } = params;
    try {
        beginImmediate(db);
    }
    catch (error) {
        return { kind: "DB_FAILURE", cause: error };
    }
    const lockEpochMs = (params.leaseClockEpochMs ?? Date.now)();
    const lockIso = new Date(lockEpochMs).toISOString();
    try {
        const current = readAuthoritativeState(db);
        if (current.state === null) {
            rollback(db);
            return {
                kind: "DB_FAILURE",
                cause: new DbIntegrityError("state row missing during initial dispatch claim"),
            };
        }
        if (current.state.stateRevision !== "0") {
            rollback(db);
            return { kind: "REVISION_CONFLICT" };
        }
        if (!current.pendingInitialDispatch) {
            rollback(db);
            return { kind: "INITIAL_DISPATCH_NOT_PENDING" };
        }
        const rawStateRow = db.prepare(READ_RAW_STATE_JSON_SQL).get();
        if (rawStateRow === undefined) {
            rollback(db);
            return {
                kind: "DB_FAILURE",
                cause: new DbIntegrityError("raw state row missing during initial dispatch claim"),
            };
        }
        const parsedState = JSON.parse(rawStateRow.state_json);
        if (typeof parsedState !== "object" ||
            parsedState === null ||
            Array.isArray(parsedState)) {
            throw new DbIntegrityError("state_json must be an object during initial dispatch claim");
        }
        const stateWithoutPendingInitialDispatch = parsedState;
        if (!hasAnyPendingInitialDispatchMarker(stateWithoutPendingInitialDispatch)) {
            rollback(db);
            return { kind: "INITIAL_DISPATCH_NOT_PENDING" };
        }
        stripAllPendingInitialDispatchMarkers(stateWithoutPendingInitialDispatch);
        const nextStateJson = JSON.stringify(stateWithoutPendingInitialDispatch);
        const nextStateDigest = computeDigest(nextStateJson);
        const claimedRow = db.prepare(COMMIT_STATE_SQL).get({
            ":schema_version": current.state.schemaVersion,
            ":state_json": nextStateJson,
            ":state_digest": nextStateDigest,
            ":owner_token": handle.ownerToken,
            ":fence_token": handle.fenceToken,
            ":now_epoch": lockEpochMs,
            ":now_iso": lockIso,
            ":incarnation_id": handle.incarnationId,
            ":expected_revision": 0n,
        });
        if (claimedRow === undefined) {
            rollback(db);
            return diagnoseClaimInitialDispatchUpdateFailure(db, handle, lockEpochMs);
        }
        const claimed = readAuthoritativeState(db);
        if (claimed.state === null || claimed.digest === null) {
            throw new DbIntegrityError("claimed initial dispatch state could not be re-read");
        }
        if (claimed.state.stateRevision !== "1" || claimed.pendingInitialDispatch) {
            throw new DbIntegrityError("initial dispatch claim did not produce revision 1 without its marker");
        }
        try {
            commit(db);
        }
        catch (error) {
            rollback(db);
            return { kind: "DB_FAILURE", cause: error };
        }
        return {
            kind: "CLAIMED",
            committed: {
                state: claimed.state,
                stateDigest: claimed.digest,
            },
        };
    }
    catch (error) {
        rollback(db);
        return { kind: "DB_FAILURE", cause: error };
    }
}
export function readAuthoritativeState(db) {
    const row = db.prepare(READ_STATE_SQL).get();
    if (row === undefined) {
        return { state: null, digest: null, pendingInitialDispatch: false };
    }
    // Verify the stored digest matches the stored JSON.
    // A corrupt state_json with a stale digest must not be
    // silently accepted.
    const actualDigest = computeDigest(row.state_json);
    if (actualDigest !== row.state_digest) {
        throw new DbIntegrityError(`run_state digest mismatch: stored=${row.state_digest}, actual=${actualDigest}`);
    }
    const parsed = JSON.parse(row.state_json);
    const state = {
        schemaVersion: row.state_schema_version,
        runId: row.run_id,
        orchestratorName: row.orchestrator_name,
        startedAt: row.started_at,
        startedAtEpochMs: row.started_at_epoch_ms,
        lastTransitionAt: parsed.lastTransitionAt ?? "",
        lastTransitionAtEpochMs: parsed.lastTransitionAtEpochMs ?? 0,
        currentPhase: parsed.currentPhase ?? "",
        phasesExecuted: parsed.phasesExecuted ?? 0,
        accumulatedDurationMs: parsed.accumulatedDurationMs ?? 0,
        data: parsed.data ?? {},
        pendingDelegation: parsed.pendingDelegation,
        pendingExternalRequest: parsed.pendingExternalRequest,
        usedLabels: parsed.usedLabels ?? [],
        runIncarnationId: row.incarnation_id,
        stateRevision: String(bigintFromRow(row.state_revision)),
        committedFenceToken: String(bigintFromRow(row.committed_by_fence_token)),
        ...(parsed.terminalResult !== undefined
            ? { terminalResult: parsed.terminalResult }
            : {}),
    };
    return {
        state,
        digest: row.state_digest,
        pendingInitialDispatch: isPendingInitialDispatchV1(parsed),
    };
}
// ---------------------------------------------------------------------------
// state.json projection (private writer — only projectAuthoritativeStateFenced
// may call this, after verifying ownership and re-reading the authoritative
// record from SQLite inside a transaction).
// ---------------------------------------------------------------------------
function writeStateJsonProjection(runDir, state, digest, dependencies) {
    const projection = {
        schemaVersion: state.schemaVersion,
        runId: state.runId,
        orchestratorName: state.orchestratorName,
        startedAt: state.startedAt,
        startedAtEpochMs: state.startedAtEpochMs,
        lastTransitionAt: state.lastTransitionAt,
        lastTransitionAtEpochMs: state.lastTransitionAtEpochMs,
        currentPhase: state.currentPhase,
        phasesExecuted: state.phasesExecuted,
        accumulatedDurationMs: state.accumulatedDurationMs,
        data: state.data,
        usedLabels: state.usedLabels,
        // Authority metadata embedded in projection for integrity checks.
        runIncarnationId: state.runIncarnationId,
        stateRevision: String(state.stateRevision),
        committedFenceToken: String(state.committedFenceToken),
        stateDigest: digest,
    };
    if (state.pendingDelegation !== undefined) {
        projection.pendingDelegation = state.pendingDelegation;
    }
    if (state.pendingExternalRequest !== undefined) {
        projection.pendingExternalRequest = state.pendingExternalRequest;
    }
    if (state.terminalResult !== undefined) {
        projection.terminalResult = state.terminalResult;
    }
    const json = JSON.stringify(projection);
    const tmpPath = path.join(runDir, "state.json.tmp");
    const statePath = path.join(runDir, "state.json");
    const temporaryFile = fs.openSync(tmpPath, "w", 0o600);
    try {
        fs.writeFileSync(temporaryFile, json, { encoding: "utf-8" });
        dependencies.onFaultPoint?.("AFTER_TEMP_FILE_WRITE");
        fs.fsyncSync(temporaryFile);
        dependencies.onFaultPoint?.("AFTER_TEMP_FILE_FSYNC");
    }
    finally {
        fs.closeSync(temporaryFile);
    }
    fs.renameSync(tmpPath, statePath);
    dependencies.onFaultPoint?.("AFTER_RENAME");
    const directory = fs.openSync(runDir, fs.constants.O_RDONLY);
    try {
        dependencies.onFaultPoint?.("BEFORE_DIRECTORY_FSYNC");
        fs.fsyncSync(directory);
    }
    finally {
        fs.closeSync(directory);
    }
}
// ---------------------------------------------------------------------------
// Fenced canonical projection — the ONLY public projection API
// ---------------------------------------------------------------------------
/** Project the authoritative `state.json` under fence.
 *
 *  Protocol (all inside BEGIN IMMEDIATE):
 *    1. Verify ownership: status=HELD, matching incarnation/owner/fence,
 *       AND lease_until_epoch_ms > now (clock captured *after* the lock
 *       is acquired).
 *    2. Re-read the full authoritative state from `run_state` inside the
 *       transaction — the projected content ALWAYS comes from SQLite, never
 *       from a caller-supplied object.
 *    3. Verify the re-read revision and digest match the expected values.
 *    4. Write and fsync state.json.tmp using the re-read state.
 *    5. Rename state.json.tmp to state.json and fsync the run directory.
 *    6. COMMIT.
 *
 *  Guarantees:
 *    - A stale owner whose lease expired is rejected (EXPIRED_HANDLE).
 *    - A successor with a higher fence token is rejected (STALE_HANDLE).
 *    - A projection superseded by a later revision is rejected.
 *    - The projected content is *exactly* what SQLite holds — a caller
 *      cannot pass a fabricated StateRecord.
 *
 *  Parameters:
 *    - `db` + `handle` — the active SQLite connection and lock handle.
 *    - `runDir` — the run directory where `state.json` is written.
 *    - `expectedRevision` — the revision the caller believes is current.
 *    - `expectedDigest` — the digest the caller believes is current.
 *
 *  Throws:
 *    - AuthorityLostError  on ownership or revision mismatch
 *    - PersistenceFailureError on DB corruption or I/O failure */
export function projectAuthoritativeStateFenced(db, handle, runDir, expectedRevision, expectedDigest, leaseClockEpochMs, dependencies = productionProjectionDependencies) {
    try {
        beginImmediate(db);
    }
    catch (error) {
        throw new PersistenceFailureError("fenced state.json projection: BEGIN IMMEDIATE failed", { operation: "state_commit", cause: error });
    }
    // Clock captured AFTER lock acquisition — the wait for BEGIN IMMEDIATE
    // (governed by busy_timeout) must not produce a stale clock reading.
    // Use the provided lease clock if available, otherwise the real clock.
    const nowEpochMs = (leaseClockEpochMs ?? Date.now)();
    try {
        // Step 1 — Verify ownership including lease expiration.
        const ownershipRow = db
            .prepare(`SELECT ownership_status, incarnation_id, owner_token,
				        fence_token, lease_until_epoch_ms
				 FROM run_ownership WHERE singleton = 1`)
            .get();
        if (ownershipRow === undefined) {
            rollback(db);
            throw new AuthorityLostError("Fenced state.json projection rejected: ownership row missing", {
                operation: "state_commit",
                reason: "STALE_HANDLE",
            });
        }
        if (ownershipRow.ownership_status !== "HELD") {
            rollback(db);
            throw new AuthorityLostError("Fenced state.json projection rejected: ownership not held", {
                operation: "state_commit",
                reason: "STALE_HANDLE",
            });
        }
        if (ownershipRow.incarnation_id !== handle.incarnationId) {
            rollback(db);
            throw new AuthorityLostError("Fenced state.json projection rejected: incarnation mismatch", {
                operation: "state_commit",
                reason: "STALE_HANDLE",
            });
        }
        if (ownershipRow.owner_token !== handle.ownerToken) {
            rollback(db);
            throw new AuthorityLostError("Fenced state.json projection rejected: owner token mismatch", {
                operation: "state_commit",
                reason: "STALE_HANDLE",
            });
        }
        const rowFence = typeof ownershipRow.fence_token === "bigint"
            ? ownershipRow.fence_token
            : BigInt(ownershipRow.fence_token);
        if (rowFence !== handle.fenceToken) {
            rollback(db);
            throw new AuthorityLostError("Fenced state.json projection rejected: fence token mismatch", {
                operation: "state_commit",
                reason: "STALE_HANDLE",
            });
        }
        // Lease check — lease is expired at the exact instant now >= leaseUntil.
        if (ownershipRow.lease_until_epoch_ms === null ||
            nowEpochMs >= ownershipRow.lease_until_epoch_ms) {
            rollback(db);
            throw new AuthorityLostError("Fenced state.json projection rejected: lease expired", {
                operation: "state_commit",
                reason: "EXPIRED_HANDLE",
            });
        }
        // Step 2 — Re-read the FULL authoritative state from SQLite.
        // This is the content-authenticity guarantee: we never project a
        // caller-supplied object; we project what SQLite actually holds.
        const readResult = readAuthoritativeState(db);
        if (readResult.state === null) {
            rollback(db);
            throw new PersistenceFailureError("fenced state.json projection: state row missing", { operation: "state_commit" });
        }
        // Step 3 — Verify expected revision and digest against the re-read state.
        if (readResult.state.stateRevision !== expectedRevision) {
            rollback(db);
            throw new AuthorityLostError(`Fenced state.json projection rejected: revision mismatch (expected ${expectedRevision}, got ${readResult.state.stateRevision})`, {
                operation: "state_commit",
                reason: "STALE_HANDLE",
            });
        }
        if ((readResult.digest ?? "") !== expectedDigest) {
            rollback(db);
            throw new PersistenceFailureError("fenced state.json projection: digest mismatch", { operation: "state_commit" });
        }
        // Step 4 — Write projection atomically using the re-read state.
        writeStateJsonProjection(runDir, readResult.state, readResult.digest ?? expectedDigest, dependencies);
        // Step 6 — COMMIT.
        commit(db);
    }
    catch (error) {
        rollback(db);
        if (error instanceof AuthorityLostError ||
            error instanceof PersistenceFailureError) {
            throw error;
        }
        throw new PersistenceFailureError(`fenced state.json projection failed: ${error instanceof Error ? error.message : String(error)}`, { operation: "state_commit", cause: error });
    }
}
//# sourceMappingURL=run-state-store.js.map