import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
// Lot 3 — authoritative state store tests.
//
// Covers: initial state creation, commit with valid handle, stale handle,
// expired handle, revision conflict, read back, state.json projection.
import { describe, test } from "node:test";
import { nodeSqliteDriver } from "../../src/persistence/sqlite/node-sqlite-driver.js";
import { acquireOwnership } from "../../src/persistence/sqlite/ownership.js";
import { openRunDatabase } from "../../src/persistence/sqlite/run-database.js";
import { commitState, readAuthoritativeState, } from "../../src/persistence/sqlite/run-state-store.js";
import { cleanupTempDir, makeTempDir } from "../helpers/temp-run-dir.js";
import { unsafeWriteStateJson } from "../helpers/unsafe-state-projection.js";
import { unsafeEnsureInitialStateRow } from "../helpers/unsafe-state-seed.js";
const LEASE_MS = 30 * 60 * 1000;
const NOW_EPOCH = 1000000000000;
const NOW_ISO = "2001-09-09T01:46:40.000Z";
const CONTENTION_DEADLINE_MS = 2000;
function setup() {
    const dir = makeTempDir();
    const dbPath = join(dir, "turnlock.sqlite3");
    const runDb = openRunDatabase({
        driver: nodeSqliteDriver,
        dbPath,
        busyTimeoutMs: 500,
    });
    return {
        dir,
        runDb,
        cleanup: () => {
            runDb.close();
            cleanupTempDir(dir);
        },
    };
}
function acquire(runDb) {
    return acquireOwnership({
        db: runDb.connection,
        runId: "01HX0000000000000000000001",
        orchestratorName: "test-state",
        nowEpochMs: NOW_EPOCH,
        nowIso: NOW_ISO,
        leaseDurationMs: LEASE_MS,
        contentionDeadlineMs: CONTENTION_DEADLINE_MS,
        leaseClockEpochMs: () => NOW_EPOCH,
    });
}
function makeInitialState() {
    return {
        schemaVersion: 4,
        runId: "01HX0000000000000000000001",
        orchestratorName: "test-state",
        startedAt: NOW_ISO,
        startedAtEpochMs: NOW_EPOCH,
        lastTransitionAt: NOW_ISO,
        lastTransitionAtEpochMs: NOW_EPOCH,
        currentPhase: "start",
        phasesExecuted: 0,
        accumulatedDurationMs: 0,
        data: { stage: "initial", count: 0 },
        usedLabels: [],
        runIncarnationId: "",
        stateRevision: "0",
        committedFenceToken: "0",
    };
}
describe("run-state-store", () => {
    test("initial state row is created and readable", () => {
        const ctx = setup();
        try {
            const result = acquire(ctx.runDb);
            assert.strictEqual(result.kind, "ACQUIRED");
            if (result.kind !== "ACQUIRED")
                return;
            unsafeEnsureInitialStateRow(ctx.runDb.connection, result.handle.incarnationId, 4, JSON.stringify(makeInitialState()), NOW_EPOCH, NOW_ISO);
            const read = readAuthoritativeState(ctx.runDb.connection);
            assert.notStrictEqual(read.state, null);
            if (read.state === null)
                return;
            assert.deepStrictEqual(read.state.data, { stage: "initial", count: 0 });
            assert.strictEqual(read.state.stateRevision, "0");
            if (typeof read.digest !== "string") {
                assert.fail("expected the authoritative state digest");
            }
            assert.match(read.digest, /^sha256:/);
        }
        finally {
            ctx.cleanup();
        }
    });
    test("commit increments revision and persists new state", () => {
        const ctx = setup();
        try {
            const result = acquire(ctx.runDb);
            assert.strictEqual(result.kind, "ACQUIRED");
            if (result.kind !== "ACQUIRED")
                return;
            const initial = makeInitialState();
            unsafeEnsureInitialStateRow(ctx.runDb.connection, result.handle.incarnationId, 4, JSON.stringify(initial), NOW_EPOCH, NOW_ISO);
            const next = {
                ...initial,
                currentPhase: "next",
                phasesExecuted: 1,
                data: { stage: "modified", count: 1 },
            };
            const commitResult = commitState({
                db: ctx.runDb.connection,
                handle: result.handle,
                expectedRevision: "0",
                nextState: next,
                nowEpochMs: NOW_EPOCH,
                nowIso: NOW_ISO,
                leaseClockEpochMs: () => NOW_EPOCH,
            });
            assert.strictEqual(commitResult.kind, "COMMITTED");
            if (commitResult.kind !== "COMMITTED")
                return;
            assert.deepStrictEqual(commitResult.committed.state.data, {
                stage: "modified",
                count: 1,
            });
            assert.strictEqual(commitResult.committed.state.stateRevision, "1");
        }
        finally {
            ctx.cleanup();
        }
    });
    test("revision conflict is detected", () => {
        const ctx = setup();
        try {
            const result = acquire(ctx.runDb);
            assert.strictEqual(result.kind, "ACQUIRED");
            if (result.kind !== "ACQUIRED")
                return;
            const initial = makeInitialState();
            unsafeEnsureInitialStateRow(ctx.runDb.connection, result.handle.incarnationId, 4, JSON.stringify(initial), NOW_EPOCH, NOW_ISO);
            const first = commitState({
                db: ctx.runDb.connection,
                handle: result.handle,
                expectedRevision: "0",
                nextState: { ...initial, currentPhase: "first" },
                nowEpochMs: NOW_EPOCH,
                nowIso: NOW_ISO,
                leaseClockEpochMs: () => NOW_EPOCH,
            });
            assert.strictEqual(first.kind, "COMMITTED");
            // Try with stale revision.
            const second = commitState({
                db: ctx.runDb.connection,
                handle: result.handle,
                expectedRevision: "0", // stale — now at revision 1
                nextState: { ...initial, currentPhase: "second" },
                nowEpochMs: NOW_EPOCH,
                nowIso: NOW_ISO,
                leaseClockEpochMs: () => NOW_EPOCH,
            });
            assert.strictEqual(second.kind, "REVISION_CONFLICT");
        }
        finally {
            ctx.cleanup();
        }
    });
    test("stale handle is rejected during commit", () => {
        const ctx = setup();
        try {
            const result = acquire(ctx.runDb);
            assert.strictEqual(result.kind, "ACQUIRED");
            if (result.kind !== "ACQUIRED")
                return;
            const initial = makeInitialState();
            unsafeEnsureInitialStateRow(ctx.runDb.connection, result.handle.incarnationId, 4, JSON.stringify(initial), NOW_EPOCH, NOW_ISO);
            // Manually release to invalidate handle.
            ctx.runDb.connection.exec(`UPDATE run_ownership
				 SET ownership_status = 'FREE',
				     owner_token = NULL,
				     owner_pid = NULL
				 WHERE singleton = 1`);
            const commitResult = commitState({
                db: ctx.runDb.connection,
                handle: result.handle,
                expectedRevision: "0",
                nextState: { ...initial, currentPhase: "next" },
                nowEpochMs: NOW_EPOCH,
                nowIso: NOW_ISO,
                leaseClockEpochMs: () => NOW_EPOCH,
            });
            assert.strictEqual(commitResult.kind, "STALE_HANDLE");
        }
        finally {
            ctx.cleanup();
        }
    });
    test("state.json projection is written and round-trips", () => {
        const ctx = setup();
        try {
            const result = acquire(ctx.runDb);
            assert.strictEqual(result.kind, "ACQUIRED");
            if (result.kind !== "ACQUIRED")
                return;
            const initial = makeInitialState();
            unsafeEnsureInitialStateRow(ctx.runDb.connection, result.handle.incarnationId, 4, JSON.stringify(initial), NOW_EPOCH, NOW_ISO);
            const next = {
                ...initial,
                currentPhase: "step-2",
                phasesExecuted: 1,
                data: { stage: "projection-test", count: 42 },
            };
            const commitResult = commitState({
                db: ctx.runDb.connection,
                handle: result.handle,
                expectedRevision: "0",
                nextState: next,
                nowEpochMs: NOW_EPOCH,
                nowIso: NOW_ISO,
                leaseClockEpochMs: () => NOW_EPOCH,
            });
            assert.strictEqual(commitResult.kind, "COMMITTED");
            if (commitResult.kind !== "COMMITTED")
                return;
            unsafeWriteStateJson(ctx.dir, commitResult.committed.state, commitResult.committed.stateDigest);
            const statePath = join(ctx.dir, "state.json");
            assert.strictEqual(existsSync(statePath), true);
            const raw = readFileSync(statePath, "utf-8");
            const parsed = JSON.parse(raw);
            assert.deepStrictEqual(parsed.data, {
                stage: "projection-test",
                count: 42,
            });
            assert.strictEqual(parsed.stateRevision, "1");
            assert.strictEqual(parsed.runIncarnationId, result.handle.incarnationId);
            assert.match(parsed.stateDigest, /^sha256:/);
            assert.strictEqual(existsSync(join(ctx.dir, "state.json.tmp")), false);
        }
        finally {
            ctx.cleanup();
        }
    });
    test("repeated commits produce monotonic revisions", () => {
        const ctx = setup();
        try {
            const result = acquire(ctx.runDb);
            assert.strictEqual(result.kind, "ACQUIRED");
            if (result.kind !== "ACQUIRED")
                return;
            const initial = makeInitialState();
            unsafeEnsureInitialStateRow(ctx.runDb.connection, result.handle.incarnationId, 4, JSON.stringify(initial), NOW_EPOCH, NOW_ISO);
            const revisions = [];
            let current = initial;
            let currentRevision = "0";
            for (let i = 1; i <= 5; i++) {
                current = {
                    ...current,
                    currentPhase: `phase-${i}`,
                    phasesExecuted: i,
                };
                const cr = commitState({
                    db: ctx.runDb.connection,
                    handle: result.handle,
                    expectedRevision: currentRevision,
                    nextState: current,
                    nowEpochMs: NOW_EPOCH,
                    nowIso: NOW_ISO,
                    leaseClockEpochMs: () => NOW_EPOCH,
                });
                assert.strictEqual(cr.kind, "COMMITTED");
                if (cr.kind === "COMMITTED") {
                    revisions.push(cr.committed.state.stateRevision);
                    currentRevision = cr.committed.state.stateRevision;
                }
            }
            assert.deepStrictEqual(revisions, ["1", "2", "3", "4", "5"]);
        }
        finally {
            ctx.cleanup();
        }
    });
});
//# sourceMappingURL=run-state-store.test.js.map