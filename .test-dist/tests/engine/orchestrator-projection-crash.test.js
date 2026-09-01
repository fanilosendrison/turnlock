import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
// Real-process crash recovery across the orchestrator/bootstrap/projection seam.
//
// These tests deliberately SIGKILL a worker while it is executing the real
// initial-mode engine path, then resume through the public `--resume` path.
// SQLite is the authority throughout; state.json is only a repairable view.
import { describe, test } from "node:test";
import { PENDING_INITIAL_DISPATCH_STATE_FIELD, PENDING_INITIAL_DISPATCH_VERSION_STATE_FIELD, } from "../../src/constants.js";
import { CRASH_TEST_ORCHESTRATOR_NAME, crashInitialModeAt, expireOnlyOwnershipLease, killAndCollect, readPersistenceSnapshot, runInitialToCompletion, runPublicResumeToCompletion, spawnPublicResumeAtPhase, } from "../helpers/orchestrator-crash-harness.js";
import { cleanupTempDir, makeTempDir } from "../helpers/temp-run-dir.js";
const STATE_FILENAME = "state.json";
const TEMP_STATE_FILENAME = "state.json.tmp";
function readSentinelEntries(sentinelFile) {
    return readFileSync(sentinelFile, "utf-8")
        .split("\n")
        .filter((entry) => entry.length > 0);
}
function assertInitialDispatchClaimCommittedOnResume(before, after) {
    assert.strictEqual(after.schemaVersion, before.schemaVersion);
    assert.deepStrictEqual(after.incarnation, before.incarnation);
    assert.strictEqual(after.ownership.count, 1);
    assert.strictEqual(after.ownership.incarnationId, before.incarnation.id);
    assert.strictEqual(after.ownership.status, "HELD");
    assert.notStrictEqual(after.ownership.ownerToken, before.ownership.ownerToken);
    assert.strictEqual(BigInt(after.ownership.fenceToken), BigInt(before.ownership.fenceToken) + 1n);
    assert.strictEqual(after.state.count, 1);
    assert.strictEqual(after.state.incarnationId, before.state.incarnationId);
    assert.strictEqual(after.state.revision, "1");
    assert.strictEqual(after.state.committedByFenceToken, after.ownership.fenceToken);
    if (after.ownership.ownerToken === null) {
        throw new Error("resumed worker must hold an ownership token");
    }
    assert.strictEqual(after.state.committedByOwnerToken, after.ownership.ownerToken);
    const expectedClaimedState = JSON.parse(before.state.json);
    delete expectedClaimedState[PENDING_INITIAL_DISPATCH_STATE_FIELD];
    delete expectedClaimedState[PENDING_INITIAL_DISPATCH_VERSION_STATE_FIELD];
    assert.deepStrictEqual(JSON.parse(after.state.json), expectedClaimedState);
}
async function assertPublicResumeRepairsFromSqlite(params) {
    const statePath = join(params.runDir, STATE_FILENAME);
    const temporaryStatePath = join(params.runDir, TEMP_STATE_FILENAME);
    const phaseSignalFile = join(params.dir, "phase-signal.json");
    // A deliberately invalid projection proves that resume does not use it as
    // migration input when the authoritative database already exists.
    writeFileSync(statePath, JSON.stringify({ source: "state-json-decoy" }), {
        encoding: "utf-8",
    });
    expireOnlyOwnershipLease(params.dbPath);
    const resumed = await spawnPublicResumeAtPhase(params.runDirRoot, params.runId, phaseSignalFile);
    const expectedState = {
        source: "sqlite-authority",
        marker: params.runId,
    };
    const expectedPhaseSignal = {
        type: "PHASE_ENTERED",
        phase: "start",
        runId: params.runId,
        runDir: params.runDir,
        state: expectedState,
    };
    let output;
    try {
        assert.deepStrictEqual(resumed.signal, expectedPhaseSignal);
        const after = readPersistenceSnapshot(params.dbPath);
        assertInitialDispatchClaimCommittedOnResume(params.before, after);
        assert.strictEqual(existsSync(statePath), true);
        assert.strictEqual(existsSync(temporaryStatePath), false);
        const projected = JSON.parse(readFileSync(statePath, "utf-8"));
        assert.strictEqual(projected.runId, params.runId);
        assert.strictEqual(projected.orchestratorName, CRASH_TEST_ORCHESTRATOR_NAME);
        assert.strictEqual(projected.runIncarnationId, params.before.incarnation.id);
        assert.strictEqual(projected.currentPhase, "start");
        assert.strictEqual(projected.stateRevision, "1");
        assert.strictEqual(projected.committedFenceToken, after.state.committedByFenceToken);
        assert.strictEqual(projected.stateDigest, after.state.digest);
        assert.ok(!(PENDING_INITIAL_DISPATCH_STATE_FIELD in Object(projected)));
        assert.ok(!(PENDING_INITIAL_DISPATCH_VERSION_STATE_FIELD in Object(projected)));
        assert.deepStrictEqual(projected.data, expectedState);
    }
    finally {
        output = await killAndCollect(resumed.worker);
    }
    assert.notStrictEqual(output.exitCode, 0);
    assert.strictEqual(output.stdout, "");
    assert.ok(!output.stderr.includes("orchestrator crash worker failed"));
}
describe("orchestrator projection crash recovery", () => {
    test("real initial path dies after bootstrap returns and real --resume repairs and dispatches SQLite state", async () => {
        const dir = makeTempDir("orchestrator-boundary-crash-");
        const runDirRoot = join(dir, "runs");
        const runId = "01HX0000000000000000000001";
        const runDir = join(runDirRoot, CRASH_TEST_ORCHESTRATOR_NAME, runId);
        const dbPath = join(runDir, "turnlock.sqlite3");
        const signalFile = join(dir, "initial-signal.json");
        try {
            const crashed = await crashInitialModeAt(runDirRoot, runId, signalFile, "BEFORE_INITIAL_PROJECTION");
            assert.deepStrictEqual(crashed.signal, {
                type: "FAULT_POINT_REACHED",
                point: "BEFORE_INITIAL_PROJECTION",
                observedPoints: ["AFTER_BOOTSTRAP_RESULT", "BEFORE_INITIAL_PROJECTION"],
            });
            assert.notStrictEqual(crashed.exitCode, 0);
            assert.strictEqual(crashed.stdout, "");
            assert.ok(!crashed.stderr.includes("orchestrator crash worker failed"));
            assert.strictEqual(existsSync(dbPath), true);
            assert.strictEqual(existsSync(join(runDir, STATE_FILENAME)), false);
            assert.strictEqual(existsSync(join(runDir, TEMP_STATE_FILENAME)), false);
            const before = readPersistenceSnapshot(dbPath);
            assert.strictEqual(before.incarnation.count, 1);
            assert.strictEqual(before.ownership.count, 1);
            assert.strictEqual(before.state.count, 1);
            assert.strictEqual(before.incarnation.runId, runId);
            assert.strictEqual(before.incarnation.orchestratorName, CRASH_TEST_ORCHESTRATOR_NAME);
            assert.strictEqual(before.ownership.incarnationId, before.incarnation.id);
            assert.strictEqual(before.state.incarnationId, before.incarnation.id);
            assert.strictEqual(before.ownership.fenceToken, "1");
            assert.strictEqual(before.state.revision, "0");
            assert.strictEqual(before.state.committedByFenceToken, "1");
            await assertPublicResumeRepairsFromSqlite({
                dir,
                runDirRoot,
                runDir,
                runId,
                dbPath,
                before,
            });
        }
        finally {
            cleanupTempDir(dir);
        }
    });
    test("SIGKILL before the initial dispatch claim permits one public resume", async () => {
        const dir = makeTempDir("initial-dispatch-preclaim-crash-");
        const runDirRoot = join(dir, "runs");
        const runId = "01HX0000000000000000000005";
        const runDir = join(runDirRoot, CRASH_TEST_ORCHESTRATOR_NAME, runId);
        const dbPath = join(runDir, "turnlock.sqlite3");
        const initialSignalFile = join(dir, "initial-signal.json");
        const phaseSignalFile = join(dir, "phase-signal.json");
        const sentinelFile = join(dir, "phase-sentinel.txt");
        try {
            const crashed = await crashInitialModeAt(runDirRoot, runId, initialSignalFile, "BEFORE_INITIAL_DISPATCH_CLAIM");
            assert.partialDeepStrictEqual(crashed.signal, {
                type: "FAULT_POINT_REACHED",
                point: "BEFORE_INITIAL_DISPATCH_CLAIM",
            });
            const before = readPersistenceSnapshot(dbPath);
            assert.strictEqual(before.state.revision, "0");
            const beforeClaim = JSON.parse(before.state.json);
            assert.strictEqual(beforeClaim[PENDING_INITIAL_DISPATCH_STATE_FIELD], true);
            assert.strictEqual(beforeClaim[PENDING_INITIAL_DISPATCH_VERSION_STATE_FIELD], 1);
            expireOnlyOwnershipLease(dbPath);
            const resumed = await spawnPublicResumeAtPhase(runDirRoot, runId, phaseSignalFile, { sentinelFile });
            let output;
            try {
                assert.partialDeepStrictEqual(resumed.signal, {
                    type: "PHASE_ENTERED",
                    phase: "start",
                    runId,
                });
                assert.deepStrictEqual(readSentinelEntries(sentinelFile), ["start"]);
                const after = readPersistenceSnapshot(dbPath);
                assert.strictEqual(after.state.revision, "1");
                const claimed = JSON.parse(after.state.json);
                assert.ok(!(PENDING_INITIAL_DISPATCH_STATE_FIELD in Object(claimed)));
                assert.ok(!(PENDING_INITIAL_DISPATCH_VERSION_STATE_FIELD in Object(claimed)));
            }
            finally {
                output = await killAndCollect(resumed.worker);
            }
            assert.notStrictEqual(output.exitCode, 0);
        }
        finally {
            cleanupTempDir(dir);
        }
    });
    test("SIGKILL after the initial dispatch claim refuses resume before phase entry", async () => {
        const dir = makeTempDir("initial-dispatch-postclaim-crash-");
        const runDirRoot = join(dir, "runs");
        const runId = "01HX0000000000000000000006";
        const runDir = join(runDirRoot, CRASH_TEST_ORCHESTRATOR_NAME, runId);
        const dbPath = join(runDir, "turnlock.sqlite3");
        const initialSignalFile = join(dir, "initial-signal.json");
        const sentinelFile = join(dir, "phase-sentinel.txt");
        try {
            const crashed = await crashInitialModeAt(runDirRoot, runId, initialSignalFile, "AFTER_INITIAL_DISPATCH_CLAIM");
            assert.partialDeepStrictEqual(crashed.signal, {
                type: "FAULT_POINT_REACHED",
                point: "AFTER_INITIAL_DISPATCH_CLAIM",
            });
            const claimed = readPersistenceSnapshot(dbPath);
            assert.strictEqual(claimed.state.revision, "1");
            const claimedState = JSON.parse(claimed.state.json);
            assert.ok(!(PENDING_INITIAL_DISPATCH_STATE_FIELD in Object(claimedState)));
            assert.ok(!(PENDING_INITIAL_DISPATCH_VERSION_STATE_FIELD in Object(claimedState)));
            expireOnlyOwnershipLease(dbPath);
            const resumed = await runPublicResumeToCompletion(runDirRoot, runId, {
                sentinelFile,
            });
            assert.notStrictEqual(resumed.exitCode, 0);
            assert.ok(resumed.stdout.includes("Initial dispatch was already claimed"));
            assert.strictEqual(existsSync(sentinelFile), false);
            const after = readPersistenceSnapshot(dbPath);
            assert.strictEqual(after.state.revision, "1");
            assert.strictEqual(after.state.json, claimed.state.json);
        }
        finally {
            cleanupTempDir(dir);
        }
    });
    test("normal initial execution claims revision 1 before its durable phase result", async () => {
        const dir = makeTempDir("initial-dispatch-normal-");
        const runDirRoot = join(dir, "runs");
        const runId = "01HX0000000000000000000007";
        const runDir = join(runDirRoot, CRASH_TEST_ORCHESTRATOR_NAME, runId);
        const dbPath = join(runDir, "turnlock.sqlite3");
        const sentinelFile = join(dir, "phase-sentinel.txt");
        try {
            const completed = await runInitialToCompletion(runDirRoot, runId, {
                sentinelFile,
            });
            assert.strictEqual(completed.exitCode, 0);
            assert.ok(completed.stdout.includes("@@TURNLOCK@@"));
            assert.deepStrictEqual(readSentinelEntries(sentinelFile), ["start"]);
            const state = readPersistenceSnapshot(dbPath);
            assert.strictEqual(state.state.revision, "2");
            const authoritativeState = JSON.parse(state.state.json);
            assert.strictEqual(authoritativeState.phasesExecuted, 1);
            assert.ok("terminalResult" in Object(authoritativeState));
            assert.ok(!(PENDING_INITIAL_DISPATCH_STATE_FIELD in Object(authoritativeState)));
            assert.ok(!(PENDING_INITIAL_DISPATCH_VERSION_STATE_FIELD in
                Object(authoritativeState)));
            const projectedState = JSON.parse(readFileSync(join(runDir, STATE_FILENAME), "utf-8"));
            assert.strictEqual(projectedState.stateRevision, "2");
        }
        finally {
            cleanupTempDir(dir);
        }
    });
    test("refuses a second public resume after SIGKILL interrupts the first freely executing phase", async () => {
        const dir = makeTempDir("initial-phase-replay-crash-");
        const runDirRoot = join(dir, "runs");
        const runId = "01HX0000000000000000000004";
        const runDir = join(runDirRoot, CRASH_TEST_ORCHESTRATOR_NAME, runId);
        const dbPath = join(runDir, "turnlock.sqlite3");
        const initialSignalFile = join(dir, "initial-signal.json");
        const phaseSignalFile = join(dir, "phase-signal.json");
        const sentinelFile = join(dir, "phase-sentinel.txt");
        try {
            const crashed = await crashInitialModeAt(runDirRoot, runId, initialSignalFile, "AFTER_INITIAL_PROJECTION");
            assert.deepStrictEqual(crashed.signal, {
                type: "FAULT_POINT_REACHED",
                point: "AFTER_INITIAL_PROJECTION",
                observedPoints: [
                    "AFTER_BOOTSTRAP_RESULT",
                    "BEFORE_INITIAL_PROJECTION",
                    "AFTER_TEMP_FILE_WRITE",
                    "AFTER_TEMP_FILE_FSYNC",
                    "AFTER_RENAME",
                    "BEFORE_DIRECTORY_FSYNC",
                    "AFTER_INITIAL_PROJECTION",
                ],
            });
            assert.notStrictEqual(crashed.exitCode, 0);
            expireOnlyOwnershipLease(dbPath);
            const firstResume = await spawnPublicResumeAtPhase(runDirRoot, runId, phaseSignalFile, { sentinelFile });
            let firstResumeOutput;
            try {
                assert.partialDeepStrictEqual(firstResume.signal, {
                    type: "PHASE_ENTERED",
                    phase: "start",
                    runId,
                });
                assert.deepStrictEqual(readSentinelEntries(sentinelFile), ["start"]);
            }
            finally {
                firstResumeOutput = await killAndCollect(firstResume.worker);
            }
            assert.notStrictEqual(firstResumeOutput.exitCode, 0);
            assert.strictEqual(firstResumeOutput.stdout, "");
            expireOnlyOwnershipLease(dbPath);
            const secondResume = await runPublicResumeToCompletion(runDirRoot, runId, {
                sentinelFile,
            });
            assert.notStrictEqual(secondResume.exitCode, 0);
            assert.ok(secondResume.stdout.includes("Initial dispatch was already claimed"));
            assert.deepStrictEqual(readSentinelEntries(sentinelFile), ["start"]);
        }
        finally {
            cleanupTempDir(dir);
        }
    });
    test("SIGKILL after temporary projection write leaves SQLite unchanged and real --resume replaces the temp", async () => {
        const dir = makeTempDir("projection-write-crash-");
        const runDirRoot = join(dir, "runs");
        const runId = "01HX0000000000000000000002";
        const runDir = join(runDirRoot, CRASH_TEST_ORCHESTRATOR_NAME, runId);
        const dbPath = join(runDir, "turnlock.sqlite3");
        const signalFile = join(dir, "projection-signal.json");
        const statePath = join(runDir, STATE_FILENAME);
        const temporaryStatePath = join(runDir, TEMP_STATE_FILENAME);
        try {
            const crashed = await crashInitialModeAt(runDirRoot, runId, signalFile, "AFTER_TEMP_FILE_WRITE");
            assert.deepStrictEqual(crashed.signal, {
                type: "FAULT_POINT_REACHED",
                point: "AFTER_TEMP_FILE_WRITE",
                observedPoints: [
                    "AFTER_BOOTSTRAP_RESULT",
                    "BEFORE_INITIAL_PROJECTION",
                    "AFTER_TEMP_FILE_WRITE",
                ],
            });
            assert.notStrictEqual(crashed.exitCode, 0);
            assert.strictEqual(crashed.stdout, "");
            assert.ok(!crashed.stderr.includes("orchestrator crash worker failed"));
            const before = readPersistenceSnapshot(dbPath);
            assert.strictEqual(before.ownership.fenceToken, "1");
            assert.strictEqual(before.state.revision, "0");
            assert.strictEqual(existsSync(statePath), false);
            assert.strictEqual(existsSync(temporaryStatePath), true);
            const interruptedProjection = JSON.parse(readFileSync(temporaryStatePath, "utf-8"));
            assert.strictEqual(interruptedProjection.runIncarnationId, before.incarnation.id);
            assert.strictEqual(interruptedProjection.stateRevision, "0");
            assert.strictEqual(interruptedProjection.stateDigest, before.state.digest);
            await assertPublicResumeRepairsFromSqlite({
                dir,
                runDirRoot,
                runDir,
                runId,
                dbPath,
                before,
            });
        }
        finally {
            cleanupTempDir(dir);
        }
    });
    test("process-only SIGKILL after rename preserves a visible projection without claiming power-loss durability", async () => {
        const dir = makeTempDir("projection-rename-crash-");
        const runDirRoot = join(dir, "runs");
        const runId = "01HX0000000000000000000003";
        const runDir = join(runDirRoot, CRASH_TEST_ORCHESTRATOR_NAME, runId);
        const dbPath = join(runDir, "turnlock.sqlite3");
        const signalFile = join(dir, "rename-signal.json");
        const statePath = join(runDir, STATE_FILENAME);
        const temporaryStatePath = join(runDir, TEMP_STATE_FILENAME);
        try {
            const crashed = await crashInitialModeAt(runDirRoot, runId, signalFile, "AFTER_RENAME");
            assert.deepStrictEqual(crashed.signal, {
                type: "FAULT_POINT_REACHED",
                point: "AFTER_RENAME",
                observedPoints: [
                    "AFTER_BOOTSTRAP_RESULT",
                    "BEFORE_INITIAL_PROJECTION",
                    "AFTER_TEMP_FILE_WRITE",
                    "AFTER_TEMP_FILE_FSYNC",
                    "AFTER_RENAME",
                ],
            });
            assert.notStrictEqual(crashed.exitCode, 0);
            assert.strictEqual(crashed.stdout, "");
            const before = readPersistenceSnapshot(dbPath);
            assert.strictEqual(existsSync(statePath), true);
            assert.strictEqual(existsSync(temporaryStatePath), false);
            const renamedProjection = JSON.parse(readFileSync(statePath, "utf-8"));
            assert.strictEqual(renamedProjection.runIncarnationId, before.incarnation.id);
            assert.strictEqual(renamedProjection.stateDigest, before.state.digest);
            await assertPublicResumeRepairsFromSqlite({
                dir,
                runDirRoot,
                runDir,
                runId,
                dbPath,
                before,
            });
        }
        finally {
            cleanupTempDir(dir);
        }
    });
});
//# sourceMappingURL=orchestrator-projection-crash.test.js.map