// Core bootstrap algorithm — incarnation + ownership + state in a single
// transaction.
//
// This module contains the unique implementation of the atomic bootstrap and
// legacy migration algorithms.  Both production callers (via run-bootstrap.ts)
// and tests inject their own identity generator through RunBootstrapDependencies.
//
// The production value is `productionDependencies`, which wraps `generateRunId`.
//
// Fault injection is supported through BootstrapInternalDependencies for
// testing atomicity guarantees.  The public API (run-bootstrap.ts) never
// exposes these hooks.
import { createHash } from "node:crypto";
import { LEGACY_PENDING_INITIAL_DISPATCH_STATE_FIELD, LEGACY_PENDING_INITIAL_DISPATCH_VERSION_STATE_FIELD, PENDING_INITIAL_DISPATCH_STATE_FIELD, PENDING_INITIAL_DISPATCH_VERSION_STATE_FIELD, } from "../../constants.js";
import { generateRunId } from "../../services/run-id.js";
import { DbIntegrityError } from "./errors.js";
import { acquireOwnershipDirectInTransaction, beginImmediate, commit, ensureIncarnationInTransaction, ensureOwnershipRowInTransaction, rollback, } from "./ownership.js";
/** Sentinel error for fault injection tests.
 *
 *  Tests throw this from `onFaultPoint` when a target frontier is reached.
 *  The error carries the fault point for assertion purposes. */
export class InjectedBootstrapFailure extends Error {
    point;
    constructor(point) {
        super(`Injected bootstrap failure at ${point}`);
        this.point = point;
        this.name = "InjectedBootstrapFailure";
    }
}
/** Production dependencies — always uses `generateRunId`. */
export const productionDependencies = {
    generateId: generateRunId,
};
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
/** @internal — exported for use by bootstrap-atomicity.test.ts (tests only). */
export function computeDigest(jsonStr) {
    return `sha256:${createHash("sha256").update(jsonStr).digest("hex")}`;
}
/** @internal — exported for use by bootstrap-atomicity.test.ts (tests only). */
export function isBusy(error) {
    const msg = String(error);
    return msg.includes("SQLITE_BUSY") || msg.includes("database is locked");
}
function readDbSnapshot(db) {
    const incRow = db
        .prepare("SELECT 1 FROM run_incarnation WHERE singleton = 1")
        .get();
    const ownRow = db
        .prepare("SELECT ownership_status, fence_token, lease_until_epoch_ms FROM run_ownership WHERE singleton = 1")
        .get();
    const stateRow = db
        .prepare("SELECT 1 FROM run_state WHERE singleton = 1")
        .get();
    return {
        hasIncarnation: incRow !== undefined,
        hasOwnership: ownRow !== undefined,
        hasState: stateRow !== undefined,
        ownershipStatus: ownRow?.ownership_status ?? null,
        fenceToken: ownRow ? bigintFromRow(ownRow.fence_token) : null,
        leaseUntilEpochMs: ownRow?.lease_until_epoch_ms ?? null,
    };
}
/** @internal — exported for use by bootstrap-atomicity.test.ts (tests only). */
export function establishRunInTransaction(db, params) {
    const { runId, orchestratorName, nowEpochMs, nowIso, leaseDurationMs, ownerToken, ownerPid, initialStateJson: rawInitialStateJson, stateSchemaVersion, partialRecovery, } = params;
    // Normalize timestamps: for a new run, use the post-lock clock;
    // for legacy migration, preserve the legacy timestamps independently.
    const effectiveStartedAtEpochMs = params.legacyStartedAtEpochMs ?? nowEpochMs;
    const effectiveStartedAt = params.legacyStartedAt ?? nowIso;
    const effectiveLastTransitionAtEpochMs = params.legacyLastTransitionAtEpochMs ?? nowEpochMs;
    const effectiveLastTransitionAt = params.legacyLastTransitionAt ?? nowIso;
    const initialStateObj = JSON.parse(rawInitialStateJson);
    initialStateObj.startedAt = effectiveStartedAt;
    initialStateObj.startedAtEpochMs = effectiveStartedAtEpochMs;
    initialStateObj.lastTransitionAt = effectiveLastTransitionAt;
    initialStateObj.lastTransitionAtEpochMs = effectiveLastTransitionAtEpochMs;
    const initialStateJson = JSON.stringify(initialStateObj);
    // 1. Check current state.
    const snapshot = readDbSnapshot(db);
    // Already fully established?
    if (snapshot.hasIncarnation && snapshot.hasOwnership && snapshot.hasState) {
        // If ownership is actively held by another process, report conflict.
        if (snapshot.ownershipStatus === "HELD" &&
            snapshot.leaseUntilEpochMs !== null &&
            nowEpochMs < snapshot.leaseUntilEpochMs) {
            throw new DbIntegrityError("ACTIVE_CONFLICT: ownership held by another process");
        }
        // Ownership is FREE or expired — the run is established but
        // unowned.  This is a valid state for --resume, not for --initial.
        return null; // ALREADY_ESTABLISHED
    }
    // Partial state detection — policy-dependent.
    const hasAnyRow = snapshot.hasIncarnation || snapshot.hasOwnership || snapshot.hasState;
    const isComplete = snapshot.hasIncarnation && snapshot.hasOwnership && snapshot.hasState;
    if (hasAnyRow && !isComplete) {
        // Incomplete bootstrap: at least one table has rows but not all three.
        if (partialRecovery === "FORBIDDEN") {
            // bootstrapNewRunAtomic: never recover a partial DB with
            // config.initialState.  The original state is lost and
            // the current config may differ from the interrupted attempt.
            throw new DbIntegrityError("INCOMPLETE_BOOTSTRAP: partial DB detected — recovery forbidden without validated legacy state");
        }
        // FROM_VALIDATED_LEGACY_STATE: recovery allowed only with a
        // validated state.json as the authoritative source.
        //
        // Check specific partial states:
        if (snapshot.hasOwnership && !snapshot.hasState) {
            if (snapshot.ownershipStatus === "HELD" &&
                snapshot.leaseUntilEpochMs !== null &&
                nowEpochMs < snapshot.leaseUntilEpochMs) {
                throw new DbIntegrityError("INCOMPLETE_BOOTSTRAP: ownership held but no state row — no recovery source");
            }
            // Ownership is FREE or expired — proceed to recovery.
        }
        if (snapshot.hasState && !snapshot.hasOwnership) {
            throw new DbIntegrityError("INCOMPLETE_BOOTSTRAP: state exists but no ownership row");
        }
        // Incarnation-only or incarnation+ownership(FREE) — proceed.
    }
    // 2. Ensure incarnation — use the caller-supplied candidate.
    //    If a row already exists the candidate is discarded and the
    //    persisted identity is returned.
    const incarnationId = ensureIncarnationInTransaction(db, runId, params.incarnationCandidate, orchestratorName, params.legacyStartedAtEpochMs ?? nowEpochMs, params.legacyStartedAt ?? nowIso);
    params.onFaultPoint?.("AFTER_INCARNATION_WRITE");
    // 3. Ensure ownership row.
    ensureOwnershipRowInTransaction(db, incarnationId);
    // 4. Acquire ownership directly.
    const acquireResult = acquireOwnershipDirectInTransaction(db, incarnationId, ownerToken, ownerPid, nowEpochMs, leaseDurationMs);
    if (acquireResult === null) {
        throw new DbIntegrityError("ACTIVE_CONFLICT: ownership held by another process");
    }
    params.onFaultPoint?.("AFTER_OWNERSHIP_WRITE");
    // 5. Insert initial state.
    const digest = computeDigest(initialStateJson);
    const insertResult = db
        .prepare(`INSERT INTO run_state (
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
			WHERE NOT EXISTS (
			    SELECT 1 FROM run_state WHERE singleton = 1
			)
			RETURNING state_revision, state_digest, committed_by_fence_token`)
        .get({
        ":incarnation_id": incarnationId,
        ":schema_version": stateSchemaVersion,
        ":state_json": initialStateJson,
        ":state_digest": digest,
        ":owner_token": ownerToken,
        ":fence_token": acquireResult.fenceToken,
        ":now_epoch": nowEpochMs,
        ":now_iso": nowIso,
    });
    if (insertResult === undefined) {
        // State row already exists — this means another caller raced us
        // (should be impossible under BEGIN IMMEDIATE, but defensive).
        // Re-read to check.
        const existingState = db
            .prepare("SELECT state_revision, state_digest, committed_by_fence_token FROM run_state WHERE singleton = 1")
            .get();
        if (existingState !== undefined) {
            // State exists — the run was established by someone else.
            return null; // ALREADY_ESTABLISHED
        }
        throw new DbIntegrityError("Failed to insert initial state row — unknown reason");
    }
    params.onFaultPoint?.("AFTER_STATE_WRITE");
    // 6. Verify coherence.
    const finalSnapshot = readDbSnapshot(db);
    if (!finalSnapshot.hasIncarnation ||
        !finalSnapshot.hasOwnership ||
        !finalSnapshot.hasState) {
        throw new DbIntegrityError("Post-insert coherence check failed — partial state detected");
    }
    return {
        incarnationId,
        ownerToken,
        fenceToken: acquireResult.fenceToken,
        leaseUntilEpochMs: acquireResult.leaseUntilEpochMs,
        stateDigest: insertResult.state_digest,
        stateRevision: String(bigintFromRow(insertResult.state_revision)),
        committedFenceToken: String(bigintFromRow(insertResult.committed_by_fence_token)),
        normalizedState: initialStateObj,
    };
}
// ---------------------------------------------------------------------------
// Core: bootstrapNewRunAtomicCore
// ---------------------------------------------------------------------------
// The unique implementation of atomic new-run bootstrap.
//
// Production callers go through `bootstrapNewRunAtomic` (run-bootstrap.ts)
// which injects `productionDependencies`.  Tests inject a deterministic
// generator to prove identity stability across SQLITE_BUSY retries.
/** Bootstrap a brand-new run atomically.
 *
 *  All three tables (incarnation, ownership, state) are populated inside a
 *  single BEGIN IMMEDIATE ... COMMIT.  The LockHandle is only constructed
 *  and returned after the COMMIT succeeds.
 *
 *  If any statement fails before COMMIT, the transaction is rolled back.
 *  No partial state is observable, no LockHandle is published.
 *
 *  The `deps.generateId()` parameter permits deterministic testing of
 *  identity stability across SQLITE_BUSY retries.
 *
 *  The `deps.onFaultPoint()` hook is reserved for internal fault injection
 *  tests and is NEVER exposed on the public API. */
export function bootstrapNewRunAtomicCore(params, deps) {
    const { db, runId, orchestratorName, nowEpochMs: _nowEpochMs, nowIso: _nowIso, leaseDurationMs, initialState, stateSchemaVersion, contentionDeadlineMs, } = params;
    const ownerToken = deps.generateId();
    const incarnationCandidate = deps.generateId();
    const ownerPid = process.pid;
    const initialStateJson = JSON.stringify(initialState);
    // Timestamps in initialRecord (startedAt, lastTransitionAt, etc.) are
    // pre-lock values.  establishRunInTransaction will normalize them to
    // the post-lock clock for new runs, or preserve legacy timestamps.
    //
    // incarnationCandidate is generated once before the retry loop so
    // that SQLITE_BUSY retries preserve the same logical identity.
    const deadlineMs = performance.now() + contentionDeadlineMs;
    const maxAttempts = 10;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        if (performance.now() > deadlineMs)
            break;
        let transactionStarted = false;
        let committed = false;
        try {
            beginImmediate(db);
            transactionStarted = true;
            deps.onFaultPoint?.("AFTER_BEGIN");
        }
        catch (error) {
            if (transactionStarted) {
                rollback(db);
            }
            if (isBusy(error))
                continue;
            return { kind: "DB_FAILURE", cause: error };
        }
        // Capture clock AFTER lock acquisition.
        const lockEpochMs = (params.leaseClockEpochMs ?? Date.now)();
        const lockIso = new Date(lockEpochMs).toISOString();
        let establishResult;
        try {
            establishResult = establishRunInTransaction(db, {
                runId,
                orchestratorName,
                nowEpochMs: lockEpochMs,
                nowIso: lockIso,
                leaseDurationMs,
                ownerToken,
                ownerPid,
                initialStateJson,
                stateSchemaVersion,
                partialRecovery: "FORBIDDEN",
                incarnationCandidate,
                ...(deps.onFaultPoint ? { onFaultPoint: deps.onFaultPoint } : {}),
            });
        }
        catch (error) {
            if (transactionStarted && !committed) {
                rollback(db);
            }
            if (error instanceof DbIntegrityError) {
                const msg = error.message;
                if (msg.startsWith("ACTIVE_CONFLICT")) {
                    // Re-read lease for reporting.
                    const ownRow = db
                        .prepare("SELECT lease_until_epoch_ms FROM run_ownership WHERE singleton = 1")
                        .get();
                    return {
                        kind: "ACTIVE_CONFLICT",
                        leaseUntilEpochMs: ownRow?.lease_until_epoch_ms ?? lockEpochMs + leaseDurationMs,
                    };
                }
                if (msg.startsWith("INCOMPLETE_BOOTSTRAP")) {
                    return {
                        kind: "INCOMPLETE_EXISTING_BOOTSTRAP",
                        details: msg,
                    };
                }
            }
            return { kind: "DB_FAILURE", cause: error };
        }
        if (establishResult === null) {
            if (transactionStarted && !committed) {
                rollback(db);
            }
            return { kind: "ALREADY_ESTABLISHED" };
        }
        // Pre-commit fault point + COMMIT — both wrapped so injected
        // failures at BEFORE_COMMIT trigger rollback.
        try {
            deps.onFaultPoint?.("BEFORE_COMMIT");
            commit(db);
            committed = true;
        }
        catch (error) {
            if (transactionStarted && !committed) {
                rollback(db);
            }
            if (isBusy(error))
                continue;
            return { kind: "DB_FAILURE", cause: error };
        }
        // Post-commit fault point — for structural verification only.
        // An injected failure here CANNOT be rolled back (COMMIT already
        // succeeded).  Crash-recovery tests in later lots will prove
        // correct handle reconstruction after a post-commit crash.
        deps.onFaultPoint?.("AFTER_COMMIT_BEFORE_HANDLE");
        // Only after COMMIT: build LockHandle and CommittedState.
        const handle = {
            ownerToken: establishResult.ownerToken,
            incarnationId: establishResult.incarnationId,
            fenceToken: establishResult.fenceToken,
            leaseUntilEpochMs: establishResult.leaseUntilEpochMs,
        };
        const committedState = {
            state: {
                ...establishResult.normalizedState,
                runIncarnationId: establishResult.incarnationId,
                stateRevision: establishResult.stateRevision,
                committedFenceToken: establishResult.committedFenceToken,
            },
            stateDigest: establishResult.stateDigest,
            stateRevision: establishResult.stateRevision,
            committedFenceToken: establishResult.committedFenceToken,
            incarnationId: establishResult.incarnationId,
        };
        return { kind: "BOOTSTRAPPED", handle, committed: committedState };
    }
    return { kind: "DB_CONTENTION_TIMEOUT" };
}
// ---------------------------------------------------------------------------
// Core: migrateLegacyRunAtomicCore
// ---------------------------------------------------------------------------
// The unique implementation of atomic legacy-run migration.
//
// Production callers go through `migrateLegacyRunAtomic` (run-bootstrap.ts)
// which injects `productionDependencies`.  Tests inject a deterministic
// generator to prove identity stability across SQLITE_BUSY retries.
/** Migrate a legacy run (state.json, no SQLite DB) into an authoritative
 *  SQLite run atomically.
 *
 *  Legacy migration preserves the logical runId and historical state
 *  timestamps, but assigns a new Turnlock run incarnation because the
 *  legacy protocol did not contain a distinct durable incarnation identity.
 *
 *  Ownership is established with current wall-clock time.
 *  All three tables populated in a single BEGIN IMMEDIATE ... COMMIT.
 *
 *  The `deps.generateId()` parameter permits deterministic testing of
 *  identity stability across SQLITE_BUSY retries.
 *
 *  The `deps.onFaultPoint()` hook is reserved for internal fault injection
 *  tests and is NEVER exposed on the public API. */
export function migrateLegacyRunAtomicCore(params, deps) {
    const { db, runId, orchestratorName, nowEpochMs: _nowEpochMs, nowIso: _nowIso, leaseDurationMs, legacyState, legacyStartedAtEpochMs, legacyStartedAt, legacyLastTransitionAtEpochMs, legacyLastTransitionAt, stateSchemaVersion, contentionDeadlineMs, } = params;
    // Generate owner token and incarnation candidate once before the
    // retry loop — a SQLITE_BUSY retry is an infrastructure retry,
    // not a new logical migration attempt, and must preserve the same
    // incarnation identity.
    const ownerToken = deps.generateId();
    const incarnationCandidate = deps.generateId();
    const ownerPid = process.pid;
    // Build the initial state JSON with legacy timestamps.
    const initialStateForDb = {
        ...legacyState,
        lastTransitionAt: legacyLastTransitionAt,
        lastTransitionAtEpochMs: legacyLastTransitionAtEpochMs,
    };
    // Legacy state is untrusted migration input and must never manufacture the
    // engine-only evidence that authorizes first-phase crash recovery.
    delete initialStateForDb[PENDING_INITIAL_DISPATCH_STATE_FIELD];
    delete initialStateForDb[PENDING_INITIAL_DISPATCH_VERSION_STATE_FIELD];
    delete initialStateForDb[LEGACY_PENDING_INITIAL_DISPATCH_STATE_FIELD];
    delete initialStateForDb[LEGACY_PENDING_INITIAL_DISPATCH_VERSION_STATE_FIELD];
    const initialStateJson = JSON.stringify(initialStateForDb);
    const deadlineMs = performance.now() + contentionDeadlineMs;
    const maxAttempts = 10;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        if (performance.now() > deadlineMs)
            break;
        let transactionStarted = false;
        let committed = false;
        try {
            beginImmediate(db);
            transactionStarted = true;
            deps.onFaultPoint?.("AFTER_BEGIN");
        }
        catch (error) {
            if (transactionStarted) {
                rollback(db);
            }
            if (isBusy(error))
                continue;
            return { kind: "DB_FAILURE", cause: error };
        }
        // Capture clock AFTER lock acquisition.
        const lockEpochMs = (params.leaseClockEpochMs ?? Date.now)();
        const lockIso = new Date(lockEpochMs).toISOString();
        let establishResult;
        try {
            establishResult = establishRunInTransaction(db, {
                runId,
                orchestratorName,
                nowEpochMs: lockEpochMs,
                nowIso: lockIso,
                leaseDurationMs,
                ownerToken,
                ownerPid,
                initialStateJson,
                stateSchemaVersion,
                partialRecovery: "FROM_VALIDATED_LEGACY_STATE",
                incarnationCandidate,
                legacyStartedAtEpochMs,
                legacyStartedAt,
                legacyLastTransitionAtEpochMs,
                legacyLastTransitionAt,
                ...(deps.onFaultPoint ? { onFaultPoint: deps.onFaultPoint } : {}),
            });
        }
        catch (error) {
            if (transactionStarted && !committed) {
                rollback(db);
            }
            if (error instanceof DbIntegrityError) {
                const msg = error.message;
                if (msg.startsWith("ACTIVE_CONFLICT")) {
                    return { kind: "ACTIVE_CONFLICT" };
                }
                if (msg.startsWith("INCOMPLETE_BOOTSTRAP")) {
                    return {
                        kind: "INCOMPLETE_EXISTING_BOOTSTRAP",
                        details: msg,
                    };
                }
            }
            return { kind: "DB_FAILURE", cause: error };
        }
        if (establishResult === null) {
            if (transactionStarted && !committed) {
                rollback(db);
            }
            return { kind: "ALREADY_ESTABLISHED" };
        }
        // Pre-commit fault point + COMMIT — both wrapped so injected
        // failures at BEFORE_COMMIT trigger rollback.
        try {
            deps.onFaultPoint?.("BEFORE_COMMIT");
            commit(db);
            committed = true;
        }
        catch (error) {
            if (transactionStarted && !committed) {
                rollback(db);
            }
            if (isBusy(error))
                continue;
            return { kind: "DB_FAILURE", cause: error };
        }
        // Post-commit fault point — for structural verification only.
        // An injected failure here CANNOT be rolled back (COMMIT already
        // succeeded).  Crash-recovery tests in later lots will prove
        // correct handle reconstruction after a post-commit crash.
        deps.onFaultPoint?.("AFTER_COMMIT_BEFORE_HANDLE");
        // Only after COMMIT: build LockHandle and CommittedState.
        const handle = {
            ownerToken: establishResult.ownerToken,
            incarnationId: establishResult.incarnationId,
            fenceToken: establishResult.fenceToken,
            leaseUntilEpochMs: establishResult.leaseUntilEpochMs,
        };
        const committedState = {
            state: {
                ...establishResult.normalizedState,
                runIncarnationId: establishResult.incarnationId,
                stateRevision: establishResult.stateRevision,
                committedFenceToken: establishResult.committedFenceToken,
            },
            stateDigest: establishResult.stateDigest,
            stateRevision: establishResult.stateRevision,
            committedFenceToken: establishResult.committedFenceToken,
            incarnationId: establishResult.incarnationId,
        };
        return { kind: "MIGRATED", handle, committed: committedState };
    }
    return { kind: "DB_CONTENTION_TIMEOUT" };
}
//# sourceMappingURL=run-bootstrap-core.js.map