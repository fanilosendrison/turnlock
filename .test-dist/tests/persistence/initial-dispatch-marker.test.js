import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, test } from "node:test";
import { LEGACY_PENDING_INITIAL_DISPATCH_STATE_FIELD, LEGACY_PENDING_INITIAL_DISPATCH_VERSION_STATE_FIELD, PENDING_INITIAL_DISPATCH_STATE_FIELD, PENDING_INITIAL_DISPATCH_VERSION, PENDING_INITIAL_DISPATCH_VERSION_STATE_FIELD, STATE_SCHEMA_VERSION, } from "../../src/constants.js";
import { nodeSqliteDriver } from "../../src/persistence/sqlite/node-sqlite-driver.js";
import { acquireOwnership, releaseOwnership, } from "../../src/persistence/sqlite/ownership.js";
import { bootstrapNewRunAtomic, migrateLegacyRunAtomic, } from "../../src/persistence/sqlite/run-bootstrap.js";
import { openRunDatabase } from "../../src/persistence/sqlite/run-database.js";
import { claimInitialDispatchUnderFence, readAuthoritativeState, } from "../../src/persistence/sqlite/run-state-store.js";
import { cleanupTempDir, makeTempDir } from "../helpers/temp-run-dir.js";
const NOW_EPOCH_MS = 1704067200000;
const NOW_ISO = "2024-01-01T00:00:00.000Z";
const LEASE_DURATION_MS = 30 * 60 * 1000;
function makeInitialState(runId) {
    return {
        schemaVersion: STATE_SCHEMA_VERSION,
        runId,
        orchestratorName: "initial-dispatch-marker-test",
        startedAt: NOW_ISO,
        startedAtEpochMs: NOW_EPOCH_MS,
        lastTransitionAt: NOW_ISO,
        lastTransitionAtEpochMs: NOW_EPOCH_MS,
        currentPhase: "start",
        phasesExecuted: 0,
        accumulatedDurationMs: 0,
        data: { source: "test" },
        usedLabels: [],
        [PENDING_INITIAL_DISPATCH_STATE_FIELD]: true,
        [PENDING_INITIAL_DISPATCH_VERSION_STATE_FIELD]: PENDING_INITIAL_DISPATCH_VERSION,
    };
}
describe("pending initial dispatch persistence marker", () => {
    test("new-run state exposes durable pending-dispatch evidence", () => {
        const dir = makeTempDir("initial-dispatch-marker-");
        const runDb = openRunDatabase({
            driver: nodeSqliteDriver,
            dbPath: join(dir, "turnlock.sqlite3"),
            busyTimeoutMs: 500,
        });
        try {
            const result = bootstrapNewRunAtomic({
                db: runDb.connection,
                runId: "01HX0000000000000000000011",
                orchestratorName: "initial-dispatch-marker-test",
                nowEpochMs: NOW_EPOCH_MS,
                nowIso: NOW_ISO,
                leaseDurationMs: LEASE_DURATION_MS,
                leaseClockEpochMs: () => NOW_EPOCH_MS,
                initialState: makeInitialState("01HX0000000000000000000011"),
                stateSchemaVersion: STATE_SCHEMA_VERSION,
                contentionDeadlineMs: 2000,
            });
            assert.strictEqual(result.kind, "BOOTSTRAPPED");
            if (result.kind !== "BOOTSTRAPPED")
                return;
            const read = readAuthoritativeState(runDb.connection);
            assert.strictEqual(read.pendingInitialDispatch, true);
            assert.strictEqual(read.state?.stateRevision, "0");
            const claim = claimInitialDispatchUnderFence({
                db: runDb.connection,
                handle: result.handle,
                leaseClockEpochMs: () => NOW_EPOCH_MS,
            });
            assert.strictEqual(claim.kind, "CLAIMED");
            if (claim.kind !== "CLAIMED")
                return;
            assert.strictEqual(claim.committed.state.stateRevision, "1");
            const claimedRead = readAuthoritativeState(runDb.connection);
            assert.strictEqual(claimedRead.pendingInitialDispatch, false);
            assert.strictEqual(claimedRead.state?.stateRevision, "1");
            const rawClaimedState = runDb.connection
                .prepare("SELECT state_json FROM run_state WHERE singleton = 1")
                .get();
            const parsedClaimedState = JSON.parse(rawClaimedState.state_json);
            assert.ok(!(PENDING_INITIAL_DISPATCH_STATE_FIELD in Object(parsedClaimedState)));
            assert.ok(!(PENDING_INITIAL_DISPATCH_VERSION_STATE_FIELD in
                Object(parsedClaimedState)));
            releaseOwnership({ db: runDb.connection, handle: result.handle });
        }
        finally {
            runDb.close();
            cleanupTempDir(dir);
        }
    });
    test("legacy migration strips forged pending-dispatch evidence", () => {
        const dir = makeTempDir("legacy-dispatch-marker-");
        const runDb = openRunDatabase({
            driver: nodeSqliteDriver,
            dbPath: join(dir, "turnlock.sqlite3"),
            busyTimeoutMs: 500,
        });
        try {
            const result = migrateLegacyRunAtomic({
                db: runDb.connection,
                runId: "01HX0000000000000000000012",
                orchestratorName: "initial-dispatch-marker-test",
                nowEpochMs: NOW_EPOCH_MS,
                nowIso: NOW_ISO,
                leaseDurationMs: LEASE_DURATION_MS,
                leaseClockEpochMs: () => NOW_EPOCH_MS,
                legacyState: makeInitialState("01HX0000000000000000000012"),
                legacyStartedAtEpochMs: NOW_EPOCH_MS - 10000,
                legacyStartedAt: "2023-12-31T23:59:50.000Z",
                legacyLastTransitionAtEpochMs: NOW_EPOCH_MS - 5000,
                legacyLastTransitionAt: "2023-12-31T23:59:55.000Z",
                stateSchemaVersion: STATE_SCHEMA_VERSION,
                contentionDeadlineMs: 2000,
            });
            assert.strictEqual(result.kind, "MIGRATED");
            if (result.kind !== "MIGRATED")
                return;
            const read = readAuthoritativeState(runDb.connection);
            assert.strictEqual(read.pendingInitialDispatch, false);
            const rawMigratedState = runDb.connection
                .prepare("SELECT state_json FROM run_state WHERE singleton = 1")
                .get();
            const parsedMigratedState = JSON.parse(rawMigratedState.state_json);
            assert.ok(!(PENDING_INITIAL_DISPATCH_STATE_FIELD in Object(parsedMigratedState)));
            assert.ok(!(PENDING_INITIAL_DISPATCH_VERSION_STATE_FIELD in
                Object(parsedMigratedState)));
            releaseOwnership({ db: runDb.connection, handle: result.handle });
        }
        finally {
            runDb.close();
            cleanupTempDir(dir);
        }
    });
    test("claim is fenced against a successor ownership handle", () => {
        const dir = makeTempDir("initial-dispatch-claim-fence-");
        const runId = "01HX0000000000000000000013";
        const runDb = openRunDatabase({
            driver: nodeSqliteDriver,
            dbPath: join(dir, "turnlock.sqlite3"),
            busyTimeoutMs: 500,
        });
        try {
            const result = bootstrapNewRunAtomic({
                db: runDb.connection,
                runId,
                orchestratorName: "initial-dispatch-marker-test",
                nowEpochMs: NOW_EPOCH_MS,
                nowIso: NOW_ISO,
                leaseDurationMs: LEASE_DURATION_MS,
                leaseClockEpochMs: () => NOW_EPOCH_MS,
                initialState: makeInitialState(runId),
                stateSchemaVersion: STATE_SCHEMA_VERSION,
                contentionDeadlineMs: 2000,
            });
            assert.strictEqual(result.kind, "BOOTSTRAPPED");
            if (result.kind !== "BOOTSTRAPPED")
                return;
            assert.strictEqual(releaseOwnership({ db: runDb.connection, handle: result.handle }).kind, "SUCCESS");
            const successor = acquireOwnership({
                db: runDb.connection,
                runId,
                orchestratorName: "initial-dispatch-marker-test",
                nowEpochMs: NOW_EPOCH_MS + 1,
                nowIso: "2024-01-01T00:00:00.001Z",
                leaseDurationMs: LEASE_DURATION_MS,
                leaseClockEpochMs: () => NOW_EPOCH_MS + 1,
                contentionDeadlineMs: 2000,
            });
            assert.strictEqual(successor.kind, "ACQUIRED");
            if (successor.kind !== "ACQUIRED")
                return;
            const claim = claimInitialDispatchUnderFence({
                db: runDb.connection,
                handle: result.handle,
                leaseClockEpochMs: () => NOW_EPOCH_MS + 1,
            });
            assert.strictEqual(claim.kind, "STALE_HANDLE");
            const read = readAuthoritativeState(runDb.connection);
            assert.strictEqual(read.pendingInitialDispatch, true);
            assert.strictEqual(read.state?.stateRevision, "0");
            releaseOwnership({ db: runDb.connection, handle: successor.handle });
        }
        finally {
            runDb.close();
            cleanupTempDir(dir);
        }
    });
    test("unversioned markers from a prior binary are not claimable after upgrade", () => {
        const dir = makeTempDir("legacy-initial-dispatch-marker-");
        const runDb = openRunDatabase({
            driver: nodeSqliteDriver,
            dbPath: join(dir, "turnlock.sqlite3"),
            busyTimeoutMs: 500,
        });
        try {
            const unversionedState = makeInitialState("01HX0000000000000000000013");
            delete unversionedState[PENDING_INITIAL_DISPATCH_VERSION_STATE_FIELD];
            const result = bootstrapNewRunAtomic({
                db: runDb.connection,
                runId: "01HX0000000000000000000013",
                orchestratorName: "initial-dispatch-marker-test",
                nowEpochMs: NOW_EPOCH_MS,
                nowIso: NOW_ISO,
                leaseDurationMs: LEASE_DURATION_MS,
                leaseClockEpochMs: () => NOW_EPOCH_MS,
                initialState: unversionedState,
                stateSchemaVersion: STATE_SCHEMA_VERSION,
                contentionDeadlineMs: 2000,
            });
            assert.strictEqual(result.kind, "BOOTSTRAPPED");
            if (result.kind !== "BOOTSTRAPPED")
                return;
            const read = readAuthoritativeState(runDb.connection);
            assert.strictEqual(read.pendingInitialDispatch, false);
            releaseOwnership({ db: runDb.connection, handle: result.handle });
        }
        finally {
            runDb.close();
            cleanupTempDir(dir);
        }
    });
    test("legacy field names are recognised and stripped on claim", () => {
        const dir = makeTempDir("legacy-field-compat-");
        const runDb = openRunDatabase({
            driver: nodeSqliteDriver,
            dbPath: join(dir, "turnlock.sqlite3"),
            busyTimeoutMs: 500,
        });
        try {
            // Simulate a database created by a v0.10.0 build that wrote the
            // legacy field names before the rename to ClaimV1.
            const legacyState = makeInitialState("01HX0000000000000000000014");
            delete legacyState[PENDING_INITIAL_DISPATCH_STATE_FIELD];
            delete legacyState[PENDING_INITIAL_DISPATCH_VERSION_STATE_FIELD];
            legacyState[LEGACY_PENDING_INITIAL_DISPATCH_STATE_FIELD] = true;
            legacyState[LEGACY_PENDING_INITIAL_DISPATCH_VERSION_STATE_FIELD] =
                PENDING_INITIAL_DISPATCH_VERSION;
            const result = bootstrapNewRunAtomic({
                db: runDb.connection,
                runId: "01HX0000000000000000000014",
                orchestratorName: "initial-dispatch-marker-test",
                nowEpochMs: NOW_EPOCH_MS,
                nowIso: NOW_ISO,
                leaseDurationMs: LEASE_DURATION_MS,
                leaseClockEpochMs: () => NOW_EPOCH_MS,
                initialState: legacyState,
                stateSchemaVersion: STATE_SCHEMA_VERSION,
                contentionDeadlineMs: 2000,
            });
            assert.strictEqual(result.kind, "BOOTSTRAPPED");
            if (result.kind !== "BOOTSTRAPPED")
                return;
            // Current build must recognise the legacy marker.
            const read = readAuthoritativeState(runDb.connection);
            assert.strictEqual(read.pendingInitialDispatch, true);
            // Claim must strip both old and new field names.
            const claim = claimInitialDispatchUnderFence({
                db: runDb.connection,
                handle: result.handle,
                leaseClockEpochMs: () => NOW_EPOCH_MS,
            });
            assert.strictEqual(claim.kind, "CLAIMED");
            const claimedRead = readAuthoritativeState(runDb.connection);
            assert.strictEqual(claimedRead.pendingInitialDispatch, false);
            const rawClaimed = runDb.connection
                .prepare("SELECT state_json FROM run_state WHERE singleton = 1")
                .get();
            const parsed = JSON.parse(rawClaimed.state_json);
            assert.ok(!(LEGACY_PENDING_INITIAL_DISPATCH_STATE_FIELD in Object(parsed)));
            assert.ok(!(LEGACY_PENDING_INITIAL_DISPATCH_VERSION_STATE_FIELD in Object(parsed)));
            assert.ok(!(PENDING_INITIAL_DISPATCH_STATE_FIELD in Object(parsed)));
            releaseOwnership({ db: runDb.connection, handle: result.handle });
        }
        finally {
            runDb.close();
            cleanupTempDir(dir);
        }
    });
});
//# sourceMappingURL=initial-dispatch-marker.test.js.map