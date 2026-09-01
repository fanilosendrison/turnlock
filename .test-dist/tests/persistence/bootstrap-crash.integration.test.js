import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync, } from "node:fs";
import { join } from "node:path";
// Bootstrap crash integration tests — TL-F-001 point 4.
//
// Multiprocess tests proving the durability properties of
// bootstrapNewRunAtomic and migrateLegacyRunAtomic under real
// SIGKILL crashes.
//
// The parent spawns a real child process, waits for it to reach a
// specific fault-point boundary, then sends SIGKILL.  After the
// child dies the parent reopens the database and verifies the
// expected state:
//
//   Pre-commit crash  →  zero durable rows (all three tables empty)
//   Post-commit crash →  incarnation + ownership + state durable
//                        (but no LockHandle received by the child)
//
// No sleep-based synchronization — the child writes a signal file
// and the parent polls for it.
import { describe, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { STATE_SCHEMA_VERSION } from "../../src/constants.js";
import { nodeSqliteDriver } from "../../src/persistence/sqlite/node-sqlite-driver.js";
import { acquireOwnership, releaseOwnership, } from "../../src/persistence/sqlite/ownership.js";
import { bootstrapNewRunAtomic, migrateLegacyRunAtomic, } from "../../src/persistence/sqlite/run-bootstrap.js";
import { openRunDatabase } from "../../src/persistence/sqlite/run-database.js";
import { isSubprocessAlive, killAndWaitForSigkill, killSubprocessIfAlive, } from "../helpers/crash-worker-process.js";
import { spawnNode } from "../helpers/node-subprocess.js";
import { cleanupTempDir, makeTempDir } from "../helpers/temp-run-dir.js";
// ---------------------------------------------------------------------------
// Constants (must match bootstrap-crash-worker.ts)
// ---------------------------------------------------------------------------
const LEASE_MS = 30 * 60 * 1000;
const NOW_EPOCH = 1000000000000;
const CONTENTION_DEADLINE_MS = 2000;
const WORKER_PATH = join(import.meta.dirname, "fixtures", "bootstrap-crash-worker.js");
const PRE_COMMIT_POINTS = [
    "AFTER_INCARNATION_WRITE",
    "AFTER_OWNERSHIP_WRITE",
    "AFTER_STATE_WRITE",
    "BEFORE_COMMIT",
];
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function assertTablesEmpty(db) {
    const inc = db.connection
        .prepare("SELECT COUNT(*) AS cnt FROM run_incarnation")
        .get();
    const own = db.connection
        .prepare("SELECT COUNT(*) AS cnt FROM run_ownership")
        .get();
    const state = db.connection
        .prepare("SELECT COUNT(*) AS cnt FROM run_state")
        .get();
    assert.strictEqual(inc.cnt, 0);
    assert.strictEqual(own.cnt, 0);
    assert.strictEqual(state.cnt, 0);
}
function assertAllThreeTablesPresent(db) {
    const inc = db.connection
        .prepare("SELECT COUNT(*) AS cnt FROM run_incarnation")
        .get();
    const own = db.connection
        .prepare("SELECT COUNT(*) AS cnt FROM run_ownership")
        .get();
    const state = db.connection
        .prepare("SELECT COUNT(*) AS cnt FROM run_state")
        .get();
    assert.strictEqual(inc.cnt, 1);
    assert.strictEqual(own.cnt, 1);
    assert.strictEqual(state.cnt, 1);
}
function assertThreeTableCoherence(db, runId) {
    const incRow = db.connection
        .prepare("SELECT incarnation_id FROM run_incarnation WHERE singleton = 1")
        .get();
    const ownRow = db.connection
        .prepare("SELECT incarnation_id, ownership_status, owner_token, fence_token, lease_until_epoch_ms FROM run_ownership WHERE singleton = 1")
        .get();
    const stateRow = db.connection
        .prepare("SELECT incarnation_id, state_revision, committed_by_owner_token, committed_by_fence_token FROM run_state WHERE singleton = 1")
        .get();
    assert.strictEqual(incRow.incarnation_id, `incarnation-${runId}`);
    assert.strictEqual(ownRow.owner_token, `owner-${runId}`);
    // incarnation_id matches across all three tables.
    assert.strictEqual(ownRow.incarnation_id, incRow.incarnation_id);
    assert.strictEqual(stateRow.incarnation_id, incRow.incarnation_id);
    // owner_token matches between ownership and state.
    assert.strictEqual(stateRow.committed_by_owner_token, ownRow.owner_token);
    // fence_token matches between ownership and state.
    const ownFence = typeof ownRow.fence_token === "bigint"
        ? ownRow.fence_token
        : BigInt(ownRow.fence_token);
    const stateFence = typeof stateRow.committed_by_fence_token === "bigint"
        ? stateRow.committed_by_fence_token
        : BigInt(stateRow.committed_by_fence_token);
    assert.strictEqual(stateFence, ownFence);
    // Ownership is HELD (orphaned lease).
    assert.strictEqual(ownRow.ownership_status, "HELD");
    // State revision is 0 (first commit).
    const rev = typeof stateRow.state_revision === "bigint"
        ? stateRow.state_revision
        : BigInt(stateRow.state_revision);
    assert.strictEqual(rev, 0n);
}
function legacyState(overrides = {}) {
    return {
        schemaVersion: STATE_SCHEMA_VERSION,
        runId: "01HX0000000000000000000001",
        orchestratorName: "crash-test",
        startedAt: "2020-01-01T00:00:00.000Z",
        startedAtEpochMs: 1577836800000,
        lastTransitionAt: "2020-01-01T00:01:00.000Z",
        lastTransitionAtEpochMs: 1577836860000,
        currentPhase: "legacy-phase",
        phasesExecuted: 5,
        accumulatedDurationMs: 10000,
        data: { stage: "legacy" },
        usedLabels: ["old-label"],
        ...overrides,
    };
}
/** Poll for a signal file to appear, returning its content.
 *  Throws after `timeoutMs`. */
async function waitForSignalFile(path, timeoutMs) {
    const start = Date.now();
    while (!existsSync(path)) {
        if (Date.now() - start > timeoutMs) {
            throw new Error(`Timeout waiting for signal file: ${path} (${timeoutMs}ms)`);
        }
        await sleep(10);
    }
    const content = readFileSync(path, "utf-8").trim();
    // Clean up the signal file.
    try {
        unlinkSync(path);
    }
    catch {
        /* ok */
    }
    return content;
}
/** Spawn the crash worker and wait for it to reach the target fault point,
 *  then kill it with SIGKILL.  Returns the child process info for cleanup. */
async function spawnAndKillAtPoint(args, signalFile, timeoutMs) {
    const child = spawnNode(WORKER_PATH, args);
    try {
        const signalContent = await waitForSignalFile(signalFile, timeoutMs);
        if (!isSubprocessAlive(child)) {
            throw new Error(`Child died before SIGKILL. Signal content: ${signalContent}`);
        }
        await killAndWaitForSigkill(child, "bootstrap crash worker");
        const stdout = await child.stdout;
        const stderr = await child.stderr;
        return { stdout, stderr };
    }
    finally {
        await killSubprocessIfAlive(child, "bootstrap crash worker");
    }
}
// ---------------------------------------------------------------------------
// Pre-commit crash tests — bootstrap
// ---------------------------------------------------------------------------
describe("bootstrap pre-commit crash", () => {
    for (const point of PRE_COMMIT_POINTS) {
        test(`SIGKILL at ${point} — zero durable rows`, async () => {
            const dir = makeTempDir("crash-bootstrap-");
            const runDir = join(dir, "runs", "crash-test", `crash-${point.toLowerCase().replace(/_/g, "-")}`);
            const signalFile = join(dir, "signal.json");
            const runId = `crash-${point.toLowerCase().replace(/_/g, "-")}`;
            try {
                // Spawn the worker — it will open/init the DB, start
                // bootstrap, reach the fault point, signal, and block.
                await spawnAndKillAtPoint([
                    "--run-dir",
                    runDir,
                    "--mode",
                    "BOOTSTRAP",
                    "--crash-point",
                    point,
                    "--run-id",
                    runId,
                    "--orchestrator-name",
                    "crash-test",
                    "--signal-file",
                    signalFile,
                ], signalFile, 10000);
                // Reopen the DB and verify all three tables are empty.
                const reopened = openRunDatabase({
                    driver: nodeSqliteDriver,
                    dbPath: join(runDir, "turnlock.sqlite3"),
                    busyTimeoutMs: 500,
                });
                try {
                    assertTablesEmpty(reopened);
                }
                finally {
                    reopened.close();
                }
                // Verify a fresh bootstrap can succeed on the same DB.
                const retry = openRunDatabase({
                    driver: nodeSqliteDriver,
                    dbPath: join(runDir, "turnlock.sqlite3"),
                    busyTimeoutMs: 500,
                });
                try {
                    const result = bootstrapNewRunAtomic({
                        db: retry.connection,
                        runId,
                        orchestratorName: "crash-test",
                        nowEpochMs: NOW_EPOCH,
                        nowIso: "2001-09-09T01:46:40.000Z",
                        leaseDurationMs: LEASE_MS,
                        leaseClockEpochMs: () => NOW_EPOCH,
                        initialState: {
                            schemaVersion: STATE_SCHEMA_VERSION,
                            runId,
                            orchestratorName: "crash-test",
                            startedAt: "2001-09-09T01:46:40.000Z",
                            startedAtEpochMs: NOW_EPOCH,
                            lastTransitionAt: "2001-09-09T01:46:40.000Z",
                            lastTransitionAtEpochMs: NOW_EPOCH,
                            currentPhase: "retry",
                            phasesExecuted: 0,
                            accumulatedDurationMs: 0,
                            data: {},
                            usedLabels: [],
                        },
                        stateSchemaVersion: STATE_SCHEMA_VERSION,
                        contentionDeadlineMs: CONTENTION_DEADLINE_MS,
                    });
                    assert.strictEqual(result.kind, "BOOTSTRAPPED");
                    if (result.kind === "BOOTSTRAPPED") {
                        releaseOwnership({
                            db: retry.connection,
                            handle: result.handle,
                        });
                    }
                }
                finally {
                    retry.close();
                }
            }
            finally {
                cleanupTempDir(dir);
            }
        });
    }
});
// ---------------------------------------------------------------------------
// Post-commit crash — bootstrap
// ---------------------------------------------------------------------------
describe("bootstrap post-commit crash", () => {
    test("SIGKILL at AFTER_COMMIT_BEFORE_HANDLE — durable state, no handle", async () => {
        const dir = makeTempDir("crash-postcommit-");
        const runDir = join(dir, "runs", "crash-test", "crash-postcommit");
        const signalFile = join(dir, "signal.json");
        const runId = "crash-postcommit";
        try {
            const { stdout } = await spawnAndKillAtPoint([
                "--run-dir",
                runDir,
                "--mode",
                "BOOTSTRAP",
                "--crash-point",
                "AFTER_COMMIT_BEFORE_HANDLE",
                "--run-id",
                runId,
                "--orchestrator-name",
                "crash-test",
                "--signal-file",
                signalFile,
            ], signalFile, 10000);
            // The child must NOT have received a BOOTSTRAPPED result.
            assert.ok(!stdout.includes("RESULT_RETURNED"));
            assert.ok(!stdout.includes("BOOTSTRAPPED"));
            assert.ok(stdout.includes("FAULT_POINT_REACHED"));
            // Reopen — all three tables must be populated.
            const reopened = openRunDatabase({
                driver: nodeSqliteDriver,
                dbPath: join(runDir, "turnlock.sqlite3"),
                busyTimeoutMs: 500,
            });
            try {
                assertAllThreeTablesPresent(reopened);
                assertThreeTableCoherence(reopened, runId);
            }
            finally {
                reopened.close();
            }
            // Verify orphaned lease: immediate attempt → ACTIVE_CONFLICT.
            const conflict = openRunDatabase({
                driver: nodeSqliteDriver,
                dbPath: join(runDir, "turnlock.sqlite3"),
                busyTimeoutMs: 500,
            });
            try {
                const result = bootstrapNewRunAtomic({
                    db: conflict.connection,
                    runId,
                    orchestratorName: "crash-test",
                    nowEpochMs: NOW_EPOCH,
                    nowIso: "2001-09-09T01:46:40.000Z",
                    leaseDurationMs: LEASE_MS,
                    leaseClockEpochMs: () => NOW_EPOCH,
                    initialState: {
                        schemaVersion: STATE_SCHEMA_VERSION,
                        runId,
                        orchestratorName: "crash-test",
                        startedAt: "2001-09-09T01:46:40.000Z",
                        startedAtEpochMs: NOW_EPOCH,
                        lastTransitionAt: "2001-09-09T01:46:40.000Z",
                        lastTransitionAtEpochMs: NOW_EPOCH,
                        currentPhase: "recovery",
                        phasesExecuted: 0,
                        accumulatedDurationMs: 0,
                        data: {},
                        usedLabels: [],
                    },
                    stateSchemaVersion: STATE_SCHEMA_VERSION,
                    contentionDeadlineMs: CONTENTION_DEADLINE_MS,
                });
                // Lease is still active → conflict.
                assert.strictEqual(result.kind, "ACTIVE_CONFLICT");
            }
            finally {
                conflict.close();
            }
            // Takeover after lease expiration.
            // Use a clock that simulates time after lease expiry.
            const futureEpoch = NOW_EPOCH + LEASE_MS + 1000;
            const takeover = openRunDatabase({
                driver: nodeSqliteDriver,
                dbPath: join(runDir, "turnlock.sqlite3"),
                busyTimeoutMs: 500,
            });
            try {
                // Read the old fence token before takeover.
                const oldFence = takeover.connection
                    .prepare("SELECT fence_token FROM run_ownership WHERE singleton = 1")
                    .get();
                const oldFenceValue = typeof oldFence.fence_token === "bigint"
                    ? oldFence.fence_token
                    : BigInt(oldFence.fence_token);
                // Acquire ownership via acquireOwnership (not bootstrap,
                // since the DB is already established).
                const acqResult = acquireOwnership({
                    db: takeover.connection,
                    runId,
                    orchestratorName: "crash-test",
                    nowEpochMs: futureEpoch,
                    nowIso: new Date(futureEpoch).toISOString(),
                    leaseDurationMs: LEASE_MS,
                    contentionDeadlineMs: CONTENTION_DEADLINE_MS,
                    leaseClockEpochMs: () => futureEpoch,
                });
                assert.strictEqual(acqResult.kind, "ACQUIRED");
                if (acqResult.kind === "ACQUIRED") {
                    // fenceToken must have incremented by exactly 1.
                    assert.strictEqual(acqResult.handle.fenceToken, oldFenceValue + 1n);
                    // Release immediately for cleanup.
                    releaseOwnership({
                        db: takeover.connection,
                        handle: acqResult.handle,
                    });
                }
            }
            finally {
                takeover.close();
            }
        }
        finally {
            cleanupTempDir(dir);
        }
    });
});
// ---------------------------------------------------------------------------
// Migration crash tests
// ---------------------------------------------------------------------------
describe("legacy migration crash", () => {
    test("migration pre-commit SIGKILL — zero rows, state.json intact", async () => {
        const dir = makeTempDir("crash-migration-pre-");
        const runDir = join(dir, "runs", "crash-test", "crash-migration-pre");
        const signalFile = join(dir, "signal.json");
        const legacyStatePath = join(runDir, "state.json");
        const runId = "crash-migration-pre";
        // Write legacy state.json.
        mkdirSync(runDir, { recursive: true });
        const stateJson = legacyState({ currentPhase: "legacy-crash-pre" });
        const stateJsonBytes = Buffer.from(JSON.stringify(stateJson), "utf-8");
        writeFileSync(legacyStatePath, stateJsonBytes);
        try {
            await spawnAndKillAtPoint([
                "--run-dir",
                runDir,
                "--mode",
                "MIGRATION",
                "--crash-point",
                "AFTER_OWNERSHIP_WRITE",
                "--run-id",
                runId,
                "--orchestrator-name",
                "crash-test",
                "--signal-file",
                signalFile,
                "--legacy-state-file",
                legacyStatePath,
            ], signalFile, 10000);
            // Verify state.json unchanged byte-for-byte.
            assert.strictEqual(existsSync(legacyStatePath), true);
            const currentBytes = readFileSync(legacyStatePath);
            assert.strictEqual(currentBytes.equals(stateJsonBytes), true);
            // Verify tables empty.
            const reopened = openRunDatabase({
                driver: nodeSqliteDriver,
                dbPath: join(runDir, "turnlock.sqlite3"),
                busyTimeoutMs: 500,
            });
            try {
                assertTablesEmpty(reopened);
            }
            finally {
                reopened.close();
            }
        }
        finally {
            cleanupTempDir(dir);
        }
    });
    test("migration post-commit SIGKILL — durable state, legacy timestamps preserved", async () => {
        const dir = makeTempDir("crash-migration-post-");
        const runDir = join(dir, "runs", "crash-test", "crash-migration-post");
        const signalFile = join(dir, "signal.json");
        const legacyStatePath = join(runDir, "state.json");
        const runId = "crash-migration-post";
        const stateJson = legacyState({ currentPhase: "legacy-crash-post" });
        mkdirSync(runDir, { recursive: true });
        writeFileSync(legacyStatePath, Buffer.from(JSON.stringify(stateJson), "utf-8"));
        try {
            const { stdout } = await spawnAndKillAtPoint([
                "--run-dir",
                runDir,
                "--mode",
                "MIGRATION",
                "--crash-point",
                "AFTER_COMMIT_BEFORE_HANDLE",
                "--run-id",
                runId,
                "--orchestrator-name",
                "crash-test",
                "--signal-file",
                signalFile,
                "--legacy-state-file",
                legacyStatePath,
            ], signalFile, 10000);
            // Must not have received MIGRATED result.
            assert.ok(!stdout.includes("RESULT_RETURNED"));
            assert.ok(!stdout.includes("MIGRATED"));
            assert.ok(stdout.includes("FAULT_POINT_REACHED"));
            // Reopen — all three tables populated.
            const reopened = openRunDatabase({
                driver: nodeSqliteDriver,
                dbPath: join(runDir, "turnlock.sqlite3"),
                busyTimeoutMs: 500,
            });
            try {
                assertAllThreeTablesPresent(reopened);
                assertThreeTableCoherence(reopened, runId);
                // Legacy timestamps preserved in incarnation.
                const incRow = reopened.connection
                    .prepare("SELECT created_at_epoch_ms, created_at_iso FROM run_incarnation WHERE singleton = 1")
                    .get();
                assert.strictEqual(incRow.created_at_epoch_ms, stateJson.startedAtEpochMs);
                assert.strictEqual(incRow.created_at_iso, stateJson.startedAt);
                // state.json still present on disk (legacy file, not authoritative).
                assert.strictEqual(existsSync(legacyStatePath), true);
                // SQLite is authoritative — a resume should use it, not
                // re-import the legacy file as a new incarnation.
                const authRead = reopened.connection
                    .prepare("SELECT state_json FROM run_state WHERE singleton = 1")
                    .get();
                const authState = JSON.parse(authRead.state_json);
                assert.strictEqual(authState.currentPhase, "legacy-crash-post");
                assert.strictEqual(authState.phasesExecuted, 5);
                // Ownership is HELD (orphaned).
                const ownRow = reopened.connection
                    .prepare("SELECT ownership_status FROM run_ownership WHERE singleton = 1")
                    .get();
                assert.strictEqual(ownRow.ownership_status, "HELD");
            }
            finally {
                reopened.close();
            }
            // Re-migration should detect already established.
            const retry = openRunDatabase({
                driver: nodeSqliteDriver,
                dbPath: join(runDir, "turnlock.sqlite3"),
                busyTimeoutMs: 500,
            });
            try {
                // First release the orphaned lease (by takeover).
                const acqResult = acquireOwnership({
                    db: retry.connection,
                    runId,
                    orchestratorName: "crash-test",
                    nowEpochMs: NOW_EPOCH + LEASE_MS + 1000,
                    nowIso: new Date(NOW_EPOCH + LEASE_MS + 1000).toISOString(),
                    leaseDurationMs: LEASE_MS,
                    contentionDeadlineMs: CONTENTION_DEADLINE_MS,
                    leaseClockEpochMs: () => NOW_EPOCH + LEASE_MS + 1000,
                });
                assert.strictEqual(acqResult.kind, "ACQUIRED");
                if (acqResult.kind === "ACQUIRED") {
                    releaseOwnership({
                        db: retry.connection,
                        handle: acqResult.handle,
                    });
                }
                // Now the DB is FREE. Re-migration should say ALREADY_ESTABLISHED.
                const result = migrateLegacyRunAtomic({
                    db: retry.connection,
                    runId,
                    orchestratorName: "crash-test",
                    nowEpochMs: NOW_EPOCH,
                    nowIso: "2001-09-09T01:46:40.000Z",
                    leaseDurationMs: LEASE_MS,
                    leaseClockEpochMs: () => NOW_EPOCH,
                    legacyState: stateJson,
                    legacyStartedAtEpochMs: stateJson.startedAtEpochMs,
                    legacyStartedAt: stateJson.startedAt,
                    legacyLastTransitionAtEpochMs: stateJson.lastTransitionAtEpochMs,
                    legacyLastTransitionAt: stateJson.lastTransitionAt,
                    stateSchemaVersion: STATE_SCHEMA_VERSION,
                    contentionDeadlineMs: CONTENTION_DEADLINE_MS,
                });
                assert.strictEqual(result.kind, "ALREADY_ESTABLISHED");
            }
            finally {
                retry.close();
            }
        }
        finally {
            cleanupTempDir(dir);
        }
    });
});
// ---------------------------------------------------------------------------
// No handle received by child
// ---------------------------------------------------------------------------
describe("no handle received before kill", () => {
    test("pre-commit crash — child never receives BOOTSTRAPPED", async () => {
        const dir = makeTempDir("crash-nohandle-");
        const runDir = join(dir, "runs", "crash-test", "crash-nohandle");
        const signalFile = join(dir, "signal.json");
        try {
            const { stdout } = await spawnAndKillAtPoint([
                "--run-dir",
                runDir,
                "--mode",
                "BOOTSTRAP",
                "--crash-point",
                "BEFORE_COMMIT",
                "--run-id",
                "crash-nohandle",
                "--orchestrator-name",
                "crash-test",
                "--signal-file",
                signalFile,
            ], signalFile, 10000);
            // The child stdout must contain only FAULT_POINT_REACHED,
            // not RESULT_RETURNED or BOOTSTRAPPED.
            assert.ok(stdout.includes("FAULT_POINT_REACHED"));
            assert.ok(!stdout.includes("RESULT_RETURNED"));
            assert.ok(!stdout.includes("BOOTSTRAPPED"));
        }
        finally {
            cleanupTempDir(dir);
        }
    });
});
//# sourceMappingURL=bootstrap-crash.integration.test.js.map