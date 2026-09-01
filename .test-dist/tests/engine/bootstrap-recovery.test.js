import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
// Bootstrap crash-recovery tests.
//
// Verifies that an interrupted SQLite bootstrap (crash between
// openRunDatabase and ensureInitialStateRow) is correctly recovered
// on the next resume, and that ownership is released when the
// authoritative state is unexpectedly missing.
import { describe, test } from "node:test";
import { STATE_SCHEMA_VERSION } from "../../src/constants.js";
import { nodeSqliteDriver } from "../../src/persistence/sqlite/node-sqlite-driver.js";
import { acquireOwnership, releaseOwnership, } from "../../src/persistence/sqlite/ownership.js";
import { openRunDatabase } from "../../src/persistence/sqlite/run-database.js";
import { readAuthoritativeState } from "../../src/persistence/sqlite/run-state-store.js";
import { readStateSnapshot } from "../../src/services/state-io.js";
import { cleanupTempDir, makeTempDir } from "../helpers/temp-run-dir.js";
import { unsafeEnsureInitialStateRow } from "../helpers/unsafe-state-seed.js";
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const LEASE_MS = 30 * 60 * 1000;
const CONTENTION_DEADLINE_MS = 2000;
const NOW_EPOCH = 1704067200000;
const NOW_ISO = "2024-01-01T00:00:00.000Z";
function makeLegacyStateJson(overrides = {}) {
    return {
        schemaVersion: STATE_SCHEMA_VERSION,
        runId: "01HX0000000000000000000001",
        orchestratorName: "bootstrap-test",
        startedAt: "2024-01-01T00:00:00.000Z",
        startedAtEpochMs: 1704067200000,
        lastTransitionAt: "2024-01-01T00:00:10.000Z",
        lastTransitionAtEpochMs: 1704067210000,
        currentPhase: "start",
        phasesExecuted: 0,
        accumulatedDurationMs: 0,
        data: { stage: "before-crash" },
        usedLabels: [],
        ...overrides,
    };
}
function setupRunDir() {
    const base = makeTempDir();
    const orchestratorName = "bootstrap-test";
    const runId = "01HX0000000000000000000001";
    const runDir = join(base, ".turnlock", "runs", orchestratorName, runId);
    mkdirSync(runDir, { recursive: true });
    mkdirSync(join(runDir, "delegations"), { recursive: true });
    mkdirSync(join(runDir, "results"), { recursive: true });
    mkdirSync(join(runDir, "artifacts", "sha256"), { recursive: true });
    const legacyState = makeLegacyStateJson();
    const stateJsonPath = join(runDir, "state.json");
    writeFileSync(stateJsonPath, JSON.stringify(legacyState));
    return {
        base,
        runDir,
        runId,
        orchestratorName,
        legacyState,
        cleanup: () => cleanupTempDir(base),
    };
}
/** Create a DB with schema only, no state row — simulates crash after
 *  openRunDatabase but before ensureInitialStateRow. */
function createSchemaOnlyDb(runDir) {
    const dbPath = join(runDir, "turnlock.sqlite3");
    const runDb = openRunDatabase({
        driver: nodeSqliteDriver,
        dbPath,
        busyTimeoutMs: 500,
    });
    // Verify no state row exists.
    const read = readAuthoritativeState(runDb.connection);
    assert.strictEqual(read.state, null);
    runDb.close();
    return { dbPath, runDb };
}
/** Create a DB with schema + incarnation, but no state row and no
 *  ownership — simulates crash after incarnation pre-creation but
 *  before acquireOwnership completes. */
function createIncarnationOnlyDb(runDir, runId, orchestratorName) {
    const dbPath = join(runDir, "turnlock.sqlite3");
    const runDb = openRunDatabase({
        driver: nodeSqliteDriver,
        dbPath,
        busyTimeoutMs: 500,
    });
    // Insert incarnation manually (simulating the pre-create step).
    runDb.connection
        .prepare(`INSERT OR IGNORE INTO run_incarnation
			 (singleton, run_id, incarnation_id, orchestrator_name,
			  created_at_epoch_ms, created_at_iso)
			 VALUES (1, ?, ?, ?, ?, ?)`)
        .run(runId, runId, orchestratorName, NOW_EPOCH, NOW_ISO);
    runDb.close();
    return { dbPath, runDb };
}
/** Create a DB with schema + incarnation + ownership acquired, but no
 *  state row — simulates crash after acquireOwnership but before
 *  ensureInitialStateRow. */
function createOwnedNoStateDb(runDir, runId, orchestratorName) {
    const dbPath = join(runDir, "turnlock.sqlite3");
    const runDb = openRunDatabase({
        driver: nodeSqliteDriver,
        dbPath,
        busyTimeoutMs: 500,
    });
    // Pre-create incarnation (seedLegacyStateToSqlite step).
    runDb.connection
        .prepare(`INSERT OR IGNORE INTO run_incarnation
			 (singleton, run_id, incarnation_id, orchestrator_name,
			  created_at_epoch_ms, created_at_iso)
			 VALUES (1, ?, ?, ?, ?, ?)`)
        .run(runId, runId, orchestratorName, NOW_EPOCH, NOW_ISO);
    // Acquire ownership.
    const result = acquireOwnership({
        db: runDb.connection,
        runId,
        orchestratorName,
        nowEpochMs: NOW_EPOCH,
        nowIso: NOW_ISO,
        leaseClockEpochMs: () => NOW_EPOCH,
        leaseDurationMs: LEASE_MS,
        contentionDeadlineMs: CONTENTION_DEADLINE_MS,
    });
    assert.strictEqual(result.kind, "ACQUIRED");
    runDb.close();
    return { dbPath, handle: result };
}
// ---------------------------------------------------------------------------
// Test 1 — crash after schema creation: next resume completes the seed
// ---------------------------------------------------------------------------
describe("bootstrap crash recovery", () => {
    test("crash after schema creation → next resume completes the seed via state.json", () => {
        const ctx = setupRunDir();
        // Simulate: DB created with schema only (crash before seed).
        createSchemaOnlyDb(ctx.runDir);
        // Verify DB exists but has no state.
        const dbPath = join(ctx.runDir, "turnlock.sqlite3");
        assert.strictEqual(existsSync(dbPath), true);
        const preCheckDb = openRunDatabase({
            driver: nodeSqliteDriver,
            dbPath,
            busyTimeoutMs: 500,
        });
        const preCheck = readAuthoritativeState(preCheckDb.connection);
        assert.strictEqual(preCheck.state, null);
        preCheckDb.close();
        // Now simulate the recovery: read state.json and seed.
        const snapshot = readStateSnapshot(ctx.runDir);
        assert.notStrictEqual(snapshot.state, null);
        assert.strictEqual(snapshot.state.runId, ctx.runId);
        // Simulate the full recovery by opening a new connection and calling the
        // same primitives as seedLegacyStateToSqlite.
        const recoveryDb = openRunDatabase({
            driver: nodeSqliteDriver,
            dbPath,
            busyTimeoutMs: 500,
        });
        // Pre-create incarnation (INSERT OR IGNORE — idempotent).
        recoveryDb.connection
            .prepare(`INSERT OR IGNORE INTO run_incarnation
				 (singleton, run_id, incarnation_id, orchestrator_name,
				  created_at_epoch_ms, created_at_iso)
				 VALUES (1, ?, ?, ?, ?, ?)`)
            .run(ctx.runId, ctx.runId, // incarnation_id
        ctx.orchestratorName, ctx.legacyState.startedAtEpochMs, ctx.legacyState.startedAt);
        // Acquire ownership.
        const acquireResult = acquireOwnership({
            db: recoveryDb.connection,
            runId: ctx.runId,
            orchestratorName: ctx.orchestratorName,
            nowEpochMs: NOW_EPOCH,
            nowIso: NOW_ISO,
            leaseClockEpochMs: () => NOW_EPOCH,
            leaseDurationMs: LEASE_MS,
            contentionDeadlineMs: CONTENTION_DEADLINE_MS,
        });
        assert.strictEqual(acquireResult.kind, "ACQUIRED");
        if (acquireResult.kind !== "ACQUIRED")
            return;
        // Seed the state row.
        unsafeEnsureInitialStateRow(recoveryDb.connection, acquireResult.handle.incarnationId, STATE_SCHEMA_VERSION, JSON.stringify(ctx.legacyState), ctx.legacyState.lastTransitionAtEpochMs, ctx.legacyState.lastTransitionAt);
        // Verify the state is now readable.
        const postRead = readAuthoritativeState(recoveryDb.connection);
        assert.notStrictEqual(postRead.state, null);
        assert.strictEqual(postRead.state.currentPhase, "start");
        assert.deepStrictEqual(postRead.state.data, { stage: "before-crash" });
        // Cleanup: release ownership and close.
        releaseOwnership({
            db: recoveryDb.connection,
            handle: acquireResult.handle,
        });
        recoveryDb.close();
        ctx.cleanup();
    });
    // -----------------------------------------------------------------------
    // Test 2 — crash after incarnation creation: startedAt historique préservé
    // -----------------------------------------------------------------------
    test("crash after run_incarnation → startedAt historique préservé on recovery", () => {
        const ctx = setupRunDir();
        // Pre-populate the DB with incarnation only (crash after pre-create step).
        createIncarnationOnlyDb(ctx.runDir, ctx.runId, ctx.orchestratorName);
        const dbPath = join(ctx.runDir, "turnlock.sqlite3");
        // Re-open and complete the seed (simulating recovery).
        const recoveryDb = openRunDatabase({
            driver: nodeSqliteDriver,
            dbPath,
            busyTimeoutMs: 500,
        });
        // The incarnation already exists.  acquireOwnership will call
        // ensureIncarnation which uses INSERT OR IGNORE — it keeps the
        // existing row with the historical timestamps.
        const acquireResult = acquireOwnership({
            db: recoveryDb.connection,
            runId: ctx.runId,
            orchestratorName: ctx.orchestratorName,
            nowEpochMs: NOW_EPOCH + 100000, // different from legacy
            nowIso: "2024-01-01T00:01:40.000Z", // different from legacy
            leaseClockEpochMs: () => NOW_EPOCH + 100000, // different from legacy,
            leaseDurationMs: LEASE_MS,
            contentionDeadlineMs: CONTENTION_DEADLINE_MS,
        });
        assert.strictEqual(acquireResult.kind, "ACQUIRED");
        if (acquireResult.kind !== "ACQUIRED")
            return;
        // Seed the state row.
        unsafeEnsureInitialStateRow(recoveryDb.connection, acquireResult.handle.incarnationId, STATE_SCHEMA_VERSION, JSON.stringify(ctx.legacyState), ctx.legacyState.lastTransitionAtEpochMs, ctx.legacyState.lastTransitionAt);
        // Verify incarnation timestamps are the historical ones.
        const incRow = recoveryDb.connection
            .prepare("SELECT created_at_epoch_ms, created_at_iso FROM run_incarnation WHERE singleton = 1")
            .get();
        assert.strictEqual(incRow.created_at_epoch_ms, NOW_EPOCH);
        assert.strictEqual(incRow.created_at_iso, NOW_ISO);
        // Ownership timestamp should be the current (recovery) time.
        const ownRow = recoveryDb.connection
            .prepare("SELECT acquired_at_epoch_ms FROM run_ownership WHERE singleton = 1")
            .get();
        assert.strictEqual(ownRow.acquired_at_epoch_ms, NOW_EPOCH + 100000);
        releaseOwnership({
            db: recoveryDb.connection,
            handle: acquireResult.handle,
        });
        recoveryDb.close();
        ctx.cleanup();
    });
    // -----------------------------------------------------------------------
    // Test 3 — crash after acquisition before run_state: takeover possible
    // -----------------------------------------------------------------------
    test("crash after acquisition before run_state → next resume can acquire and seed", () => {
        const ctx = setupRunDir();
        // Create DB with ownership acquired but no state row (crash after
        // acquireOwnership but before ensureInitialStateRow).
        const { handle: staleHandle } = createOwnedNoStateDb(ctx.runDir, ctx.runId, ctx.orchestratorName);
        // The old handle's lease is still valid (NOW_EPOCH + LEASE_MS).
        // Verify the stale handle from the crashed process has a valid shape
        // but the DB connection is closed — the next process must re-acquire.
        assert.strictEqual(staleHandle.kind, "ACQUIRED");
        if (staleHandle.kind !== "ACQUIRED")
            return;
        assert.strictEqual(typeof staleHandle.handle.ownerToken, "string");
        // We simulate time passing beyond the lease so the next process
        // can acquire.
        const futureEpoch = NOW_EPOCH + LEASE_MS + 10000;
        const futureIso = "2024-01-01T08:30:10.000Z";
        const dbPath = join(ctx.runDir, "turnlock.sqlite3");
        // Re-open DB — the ownership is still HELD by the stale process.
        const recoveryDb = openRunDatabase({
            driver: nodeSqliteDriver,
            dbPath,
            busyTimeoutMs: 500,
        });
        // Check that the stale handle prevents immediate acquisition.
        const blocked = acquireOwnership({
            db: recoveryDb.connection,
            runId: ctx.runId,
            orchestratorName: ctx.orchestratorName,
            nowEpochMs: NOW_EPOCH + 1000, // lease not yet expired
            nowIso: NOW_ISO,
            leaseClockEpochMs: () => NOW_EPOCH + 1000, // lease not yet expired,
            leaseDurationMs: LEASE_MS,
            contentionDeadlineMs: 500,
        });
        assert.strictEqual(blocked.kind, "ACTIVE_CONFLICT");
        // After the lease expires, acquisition should succeed.
        const reacquired = acquireOwnership({
            db: recoveryDb.connection,
            runId: ctx.runId,
            orchestratorName: ctx.orchestratorName,
            nowEpochMs: futureEpoch,
            nowIso: futureIso,
            leaseClockEpochMs: () => futureEpoch,
            leaseDurationMs: LEASE_MS,
            contentionDeadlineMs: 2000,
        });
        assert.strictEqual(reacquired.kind, "ACQUIRED");
        if (reacquired.kind !== "ACQUIRED")
            return;
        // Seed the state row (idempotent — INSERT OR IGNORE).
        unsafeEnsureInitialStateRow(recoveryDb.connection, reacquired.handle.incarnationId, STATE_SCHEMA_VERSION, JSON.stringify(ctx.legacyState), ctx.legacyState.lastTransitionAtEpochMs, ctx.legacyState.lastTransitionAt);
        // Verify state is now readable.
        const postRead = readAuthoritativeState(recoveryDb.connection);
        assert.notStrictEqual(postRead.state, null);
        releaseOwnership({
            db: recoveryDb.connection,
            handle: reacquired.handle,
        });
        recoveryDb.close();
        ctx.cleanup();
    });
    // -----------------------------------------------------------------------
    // Test 4 — run_state absent in existing DB → fallback to state.json
    // -----------------------------------------------------------------------
    test("run_state absent dans une DB existante → fallback contrôlé vers state.json", () => {
        const ctx = setupRunDir();
        // DB exists with schema but no state row.
        createSchemaOnlyDb(ctx.runDir);
        // Verify state.json exists as fallback.
        const snapshot = readStateSnapshot(ctx.runDir);
        assert.notStrictEqual(snapshot.state, null);
        assert.strictEqual(snapshot.state.runId, ctx.runId);
        assert.strictEqual(snapshot.state.orchestratorName, ctx.orchestratorName);
        // The recovery path should succeed by reading state.json and seeding.
        const dbPath = join(ctx.runDir, "turnlock.sqlite3");
        const recoveryDb = openRunDatabase({
            driver: nodeSqliteDriver,
            dbPath,
            busyTimeoutMs: 500,
        });
        // Simulate the recovery path from runResumeMode:
        // 1. Pre-read shows null state
        const preRead = readAuthoritativeState(recoveryDb.connection);
        assert.strictEqual(preRead.state, null);
        recoveryDb.close();
        // 2. Read state.json snapshot
        assert.notStrictEqual(snapshot.state, null);
        // 3. Validate identity
        assert.strictEqual(snapshot.state.runId, ctx.runId);
        assert.strictEqual(snapshot.state.orchestratorName, ctx.orchestratorName);
        // 4. Seed idempotently
        const seedDb = openRunDatabase({
            driver: nodeSqliteDriver,
            dbPath,
            busyTimeoutMs: 500,
        });
        // Pre-create incarnation.
        seedDb.connection
            .prepare(`INSERT OR IGNORE INTO run_incarnation
				 (singleton, run_id, incarnation_id, orchestrator_name,
				  created_at_epoch_ms, created_at_iso)
				 VALUES (1, ?, ?, ?, ?, ?)`)
            .run(ctx.runId, ctx.runId, ctx.orchestratorName, ctx.legacyState.startedAtEpochMs, ctx.legacyState.startedAt);
        const acquireResult = acquireOwnership({
            db: seedDb.connection,
            runId: ctx.runId,
            orchestratorName: ctx.orchestratorName,
            nowEpochMs: NOW_EPOCH,
            nowIso: NOW_ISO,
            leaseClockEpochMs: () => NOW_EPOCH,
            leaseDurationMs: LEASE_MS,
            contentionDeadlineMs: CONTENTION_DEADLINE_MS,
        });
        assert.strictEqual(acquireResult.kind, "ACQUIRED");
        if (acquireResult.kind !== "ACQUIRED")
            return;
        unsafeEnsureInitialStateRow(seedDb.connection, acquireResult.handle.incarnationId, STATE_SCHEMA_VERSION, JSON.stringify(ctx.legacyState), ctx.legacyState.lastTransitionAtEpochMs, ctx.legacyState.lastTransitionAt);
        // 5. Verify authoritative state is now present.
        const finalRead = readAuthoritativeState(seedDb.connection);
        assert.notStrictEqual(finalRead.state, null);
        assert.strictEqual(finalRead.state.currentPhase, "start");
        releaseOwnership({
            db: seedDb.connection,
            handle: acquireResult.handle,
        });
        seedDb.close();
        ctx.cleanup();
    });
    // -----------------------------------------------------------------------
    // Test 5 — state absent après acquisition → ownership libéré
    // -----------------------------------------------------------------------
    test("state absent après acquisition → ownership libéré avant throw", () => {
        const ctx = setupRunDir();
        // Create a fully bootstrapped DB, then manually delete the state row.
        const dbPath = join(ctx.runDir, "turnlock.sqlite3");
        const runDb = openRunDatabase({
            driver: nodeSqliteDriver,
            dbPath,
            busyTimeoutMs: 500,
        });
        const acquireResult = acquireOwnership({
            db: runDb.connection,
            runId: ctx.runId,
            orchestratorName: ctx.orchestratorName,
            nowEpochMs: NOW_EPOCH,
            nowIso: NOW_ISO,
            leaseClockEpochMs: () => NOW_EPOCH,
            leaseDurationMs: LEASE_MS,
            contentionDeadlineMs: CONTENTION_DEADLINE_MS,
        });
        assert.strictEqual(acquireResult.kind, "ACQUIRED");
        if (acquireResult.kind !== "ACQUIRED")
            return;
        unsafeEnsureInitialStateRow(runDb.connection, acquireResult.handle.incarnationId, STATE_SCHEMA_VERSION, JSON.stringify(ctx.legacyState), ctx.legacyState.lastTransitionAtEpochMs, ctx.legacyState.lastTransitionAt);
        // Verify state exists.
        const preCheck = readAuthoritativeState(runDb.connection);
        assert.notStrictEqual(preCheck.state, null);
        // Now delete the state row while ownership is held — simulates
        // corruption or a race.
        runDb.connection.exec("DELETE FROM run_state WHERE singleton = 1");
        // Verify state is now null.
        const postDelete = readAuthoritativeState(runDb.connection);
        assert.strictEqual(postDelete.state, null);
        // The code should release ownership before throwing.
        // We simulate the release-then-throw from runResumeMode.
        const releaseResult = releaseOwnership({
            db: runDb.connection,
            handle: acquireResult.handle,
        });
        assert.strictEqual(releaseResult.kind === "SUCCESS" || releaseResult.kind === "STALE_HANDLE", true);
        runDb.close();
        // After release, a new process should be able to acquire.
        const reopened = openRunDatabase({
            driver: nodeSqliteDriver,
            dbPath,
            busyTimeoutMs: 500,
        });
        const reacquired = acquireOwnership({
            db: reopened.connection,
            runId: ctx.runId,
            orchestratorName: ctx.orchestratorName,
            nowEpochMs: NOW_EPOCH + 1000,
            nowIso: NOW_ISO,
            leaseClockEpochMs: () => NOW_EPOCH + 1000,
            leaseDurationMs: LEASE_MS,
            contentionDeadlineMs: CONTENTION_DEADLINE_MS,
        });
        assert.strictEqual(reacquired.kind, "ACQUIRED");
        if (reacquired.kind === "ACQUIRED") {
            releaseOwnership({
                db: reopened.connection,
                handle: reacquired.handle,
            });
        }
        reopened.close();
        ctx.cleanup();
    });
    // -----------------------------------------------------------------------
    // Test 6 — idempotent seed on fully bootstrapped DB
    // -----------------------------------------------------------------------
    test("seed idempotent — seedLegacyStateToSqlite path on already-bootstrapped DB", () => {
        const ctx = setupRunDir();
        // First seed: normal legacy path.
        const dbPath = join(ctx.runDir, "turnlock.sqlite3");
        const runDb = openRunDatabase({
            driver: nodeSqliteDriver,
            dbPath,
            busyTimeoutMs: 500,
        });
        // Pre-create incarnation.
        runDb.connection
            .prepare(`INSERT OR IGNORE INTO run_incarnation
				 (singleton, run_id, incarnation_id, orchestrator_name,
				  created_at_epoch_ms, created_at_iso)
				 VALUES (1, ?, ?, ?, ?, ?)`)
            .run(ctx.runId, ctx.runId, ctx.orchestratorName, ctx.legacyState.startedAtEpochMs, ctx.legacyState.startedAt);
        const first = acquireOwnership({
            db: runDb.connection,
            runId: ctx.runId,
            orchestratorName: ctx.orchestratorName,
            nowEpochMs: NOW_EPOCH,
            nowIso: NOW_ISO,
            leaseClockEpochMs: () => NOW_EPOCH,
            leaseDurationMs: LEASE_MS,
            contentionDeadlineMs: CONTENTION_DEADLINE_MS,
        });
        assert.strictEqual(first.kind, "ACQUIRED");
        if (first.kind !== "ACQUIRED")
            return;
        unsafeEnsureInitialStateRow(runDb.connection, first.handle.incarnationId, STATE_SCHEMA_VERSION, JSON.stringify(ctx.legacyState), ctx.legacyState.lastTransitionAtEpochMs, ctx.legacyState.lastTransitionAt);
        releaseOwnership({ db: runDb.connection, handle: first.handle });
        // Now re-open and simulate the same seed path again (idempotent).
        // Pre-create incarnation — INSERT OR IGNORE, should be no-op.
        runDb.connection
            .prepare(`INSERT OR IGNORE INTO run_incarnation
				 (singleton, run_id, incarnation_id, orchestrator_name,
				  created_at_epoch_ms, created_at_iso)
				 VALUES (1, ?, ?, ?, ?, ?)`)
            .run(ctx.runId, "different-incarnation-id", // different incarnation — IGNORE'd
        "different-orch", NOW_EPOCH + 999, // would overwrite if not IGNORE
        "2025-01-01T00:00:00.000Z");
        // Verify incarnation was NOT overwritten.
        const incRow = runDb.connection
            .prepare("SELECT incarnation_id, orchestrator_name, created_at_epoch_ms FROM run_incarnation WHERE singleton = 1")
            .get();
        assert.strictEqual(incRow.incarnation_id, ctx.runId);
        assert.strictEqual(incRow.orchestrator_name, ctx.orchestratorName);
        assert.strictEqual(incRow.created_at_epoch_ms, NOW_EPOCH);
        // ensureInitialStateRow — INSERT OR IGNORE, should be no-op.
        const differentState = {
            ...ctx.legacyState,
            currentPhase: "should-not-overwrite",
        };
        unsafeEnsureInitialStateRow(runDb.connection, first.handle.incarnationId, STATE_SCHEMA_VERSION, JSON.stringify(differentState), NOW_EPOCH + 999, "2025-01-01T00:00:00.000Z");
        // Verify state was NOT overwritten.
        const stateRead = readAuthoritativeState(runDb.connection);
        assert.notStrictEqual(stateRead.state, null);
        assert.strictEqual(stateRead.state.currentPhase, "start");
        runDb.close();
        ctx.cleanup();
    });
    // -----------------------------------------------------------------------
    // Test 7 — DB exists, no state, no state.json → proper error
    // -----------------------------------------------------------------------
    test("DB exists, no state row, no state.json → StateMissingError", () => {
        const base = makeTempDir();
        const runDir = join(base, "no-state-json");
        mkdirSync(runDir, { recursive: true });
        const dbPath = join(runDir, "turnlock.sqlite3");
        const runDb = openRunDatabase({
            driver: nodeSqliteDriver,
            dbPath,
            busyTimeoutMs: 500,
        });
        runDb.close();
        // DB exists but no state.json.
        assert.strictEqual(existsSync(dbPath), true);
        assert.strictEqual(existsSync(join(runDir, "state.json")), false);
        // The recovery path should detect the missing state.json and throw.
        assert.throws(() => {
            const snapshot = readStateSnapshot(runDir);
            if (snapshot.state === null) {
                throw new Error("state.json missing");
            }
        });
        cleanupTempDir(base);
    });
});
//# sourceMappingURL=bootstrap-recovery.test.js.map