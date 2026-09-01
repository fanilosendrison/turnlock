import assert from "node:assert/strict";
import { join } from "node:path";
// TL-F-001 point 1 — Authority loss continuation prevention tests.
//
// Demonstrates that after a commit rejection, the real handler does NOT continue
// as if the commit succeeded:
//   - No DONE protocol block is emitted
//   - No doExit(0) occurs
//   - The error (AuthorityLostError) propagates out
import { describe, mock, test } from "node:test";
import { STATE_SCHEMA_VERSION } from "../../src/constants.js";
import { refreshOwnershipFromContext } from "../../src/engine/state-commit.js";
import { handleDone } from "../../src/engine/terminal-handlers.js";
import { OrchestratorError } from "../../src/errors/base.js";
import { AuthorityLostError, PersistenceFailureError, StateRevisionConflictError, } from "../../src/errors/concrete.js";
import { nodeSqliteDriver } from "../../src/persistence/sqlite/node-sqlite-driver.js";
import { acquireOwnership, releaseOwnership as sqliteReleaseOwnership, } from "../../src/persistence/sqlite/ownership.js";
import { openRunDatabase } from "../../src/persistence/sqlite/run-database.js";
import { createMockLogger } from "../helpers/mock-logger.js";
import { cleanupTempDir, makeTempDir } from "../helpers/temp-run-dir.js";
import { unsafeEnsureInitialStateRow } from "../helpers/unsafe-state-seed.js";
const LEASE_MS = 30 * 60 * 1000;
const CONTENTION_DEADLINE_MS = 2000;
const RUN_ID = "01HX0000000000000000000001";
function now() {
    return {
        epoch: Date.now(),
        iso: new Date().toISOString(),
    };
}
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
function makeState(overrides = {}) {
    return {
        schemaVersion: STATE_SCHEMA_VERSION,
        runId: RUN_ID,
        orchestratorName: "test",
        startedAt: "2024-01-01T00:00:00.000Z",
        startedAtEpochMs: 1704067200000,
        lastTransitionAt: "2024-01-01T00:00:00.000Z",
        lastTransitionAtEpochMs: 1704067200000,
        currentPhase: "test-phase",
        phasesExecuted: 1,
        accumulatedDurationMs: 100,
        data: { ok: true },
        usedLabels: [],
        ...overrides,
    };
}
function makeContext(dir, runDb, handle) {
    return {
        config: {
            name: "test",
            initial: "start",
            initialState: { ok: false },
            resumeCommand: (id) => `node --run-id ${id} --resume`,
            phases: {
                start: async (_s, io) => io.done({ ok: true }),
            },
        },
        runId: RUN_ID,
        runDir: dir,
        runDb,
        handle,
        logger: createMockLogger(),
        abortController: new AbortController(),
        currentPhase: "test-phase",
        phasesExecuted: 1,
        accumulatedDurationMs: 100,
        stateRevision: "0",
    };
}
// ---------------------------------------------------------------------------
// Real handleDone() continuation prevention
// ---------------------------------------------------------------------------
describe("authority loss — real handleDone continuation prevention", () => {
    test("handleDone with stale handle throws AuthorityLostError and emits no DONE block", async () => {
        const ctx = setup();
        try {
            const { epoch, iso } = now();
            // Acquire handle A.
            const acquired = acquireOwnership({
                db: ctx.runDb.connection,
                runId: RUN_ID,
                orchestratorName: "test",
                nowEpochMs: epoch,
                nowIso: iso,
                leaseDurationMs: LEASE_MS,
                contentionDeadlineMs: CONTENTION_DEADLINE_MS,
            });
            assert.strictEqual(acquired.kind, "ACQUIRED");
            if (acquired.kind !== "ACQUIRED")
                return;
            const handleA = acquired.handle;
            unsafeEnsureInitialStateRow(ctx.runDb.connection, handleA.incarnationId, STATE_SCHEMA_VERSION, JSON.stringify({ schemaVersion: STATE_SCHEMA_VERSION, runId: RUN_ID }), epoch, iso);
            // Make the handle stale (another worker acquired).
            sqliteReleaseOwnership({ db: ctx.runDb.connection, handle: handleA });
            acquireOwnership({
                db: ctx.runDb.connection,
                runId: RUN_ID,
                orchestratorName: "test",
                nowEpochMs: epoch + 1000,
                nowIso: iso,
                leaseDurationMs: LEASE_MS,
                contentionDeadlineMs: CONTENTION_DEADLINE_MS,
            });
            const dCtx = makeContext(ctx.dir, ctx.runDb, handleA);
            const state = makeState();
            // Capture stdout to verify no DONE block is written.
            let stdoutContent = "";
            const originalWrite = process.stdout.write.bind(process.stdout);
            const writeMock = mock.fn((chunk) => {
                stdoutContent +=
                    typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
                return true;
            });
            process.stdout.write = writeMock;
            let catchedErr = null;
            try {
                await handleDone(dCtx, state, { kind: "done", output: { ok: true } }, 200);
            }
            catch (err) {
                catchedErr = err;
            }
            finally {
                process.stdout.write = originalWrite;
            }
            // Must throw AuthorityLostError, not TestExitSignal or anything else.
            assert.ok(catchedErr instanceof AuthorityLostError);
            assert.strictEqual(catchedErr.kind, "authority_lost");
            // stdout must NOT contain a DONE block.
            assert.ok(!stdoutContent.includes("@@TURNLOCK@@"));
            assert.ok(!stdoutContent.includes("action: DONE"));
            // No orchestrator_end(success=true) in the logger.
            const logger = dCtx.logger;
            const endEvents = logger.findAll("orchestrator_end");
            const successEnd = endEvents.filter((e) => e.success === true);
            assert.strictEqual(successEnd.length, 0);
        }
        finally {
            ctx.cleanup();
        }
    });
    // -----------------------------------------------------------------------
    // Revision conflict also prevents continuation (real handleDone)
    // -----------------------------------------------------------------------
    test("revision conflict in handleDone throws StateRevisionConflictError", async () => {
        const ctx = setup();
        try {
            const { epoch, iso } = now();
            const acquired = acquireOwnership({
                db: ctx.runDb.connection,
                runId: RUN_ID,
                orchestratorName: "test",
                nowEpochMs: epoch,
                nowIso: iso,
                leaseDurationMs: LEASE_MS,
                contentionDeadlineMs: CONTENTION_DEADLINE_MS,
            });
            assert.strictEqual(acquired.kind, "ACQUIRED");
            if (acquired.kind !== "ACQUIRED")
                return;
            unsafeEnsureInitialStateRow(ctx.runDb.connection, acquired.handle.incarnationId, STATE_SCHEMA_VERSION, JSON.stringify({ schemaVersion: STATE_SCHEMA_VERSION, runId: RUN_ID }), epoch, iso);
            // Bump revision externally.
            ctx.runDb.connection.exec("UPDATE run_state SET state_revision = 5 WHERE singleton = 1");
            const dCtx = makeContext(ctx.dir, ctx.runDb, acquired.handle);
            // Override stateRevision to simulate stale expectation.
            dCtx.stateRevision = "0";
            const state = makeState();
            let catchedErr = null;
            try {
                await handleDone(dCtx, state, { kind: "done", output: { ok: true } }, 200);
            }
            catch (err) {
                catchedErr = err;
            }
            assert.ok(catchedErr instanceof StateRevisionConflictError);
        }
        finally {
            ctx.cleanup();
        }
    });
    // -----------------------------------------------------------------------
    // Refresh failure prevents continuation
    // -----------------------------------------------------------------------
    test("stale handle during refresh prevents dispatch continuation", () => {
        const ctx = setup();
        try {
            const { epoch, iso } = now();
            const acquired = acquireOwnership({
                db: ctx.runDb.connection,
                runId: RUN_ID,
                orchestratorName: "test",
                nowEpochMs: epoch,
                nowIso: iso,
                leaseDurationMs: LEASE_MS,
                contentionDeadlineMs: CONTENTION_DEADLINE_MS,
            });
            assert.strictEqual(acquired.kind, "ACQUIRED");
            if (acquired.kind !== "ACQUIRED")
                return;
            // Make stale.
            sqliteReleaseOwnership({
                db: ctx.runDb.connection,
                handle: acquired.handle,
            });
            const refreshCtx = {
                runDb: ctx.runDb,
                handle: acquired.handle,
                runId: RUN_ID,
            };
            let continued = false;
            try {
                refreshOwnershipFromContext(refreshCtx);
                continued = true;
            }
            catch (err) {
                assert.ok(err instanceof AuthorityLostError);
                assert.strictEqual(err.operation, "refresh");
            }
            assert.strictEqual(continued, false);
        }
        finally {
            ctx.cleanup();
        }
    });
});
// ---------------------------------------------------------------------------
// Error class taxonomy
// ---------------------------------------------------------------------------
describe("authority/persistence error classes", () => {
    test("AuthorityLostError has correct kind, operation, reason", () => {
        const err = new AuthorityLostError("msg", {
            operation: "state_commit",
            reason: "STALE_HANDLE",
            runId: RUN_ID,
        });
        assert.strictEqual(err.kind, "authority_lost");
        assert.strictEqual(err.operation, "state_commit");
        assert.strictEqual(err.reason, "STALE_HANDLE");
        assert.strictEqual(err.runId, RUN_ID);
        assert.strictEqual(err.message, "msg");
    });
    test("StateRevisionConflictError has correct kind", () => {
        const err = new StateRevisionConflictError("conflict");
        assert.strictEqual(err.kind, "state_revision_conflict");
        assert.strictEqual(err.message, "conflict");
    });
    test("PersistenceFailureError has correct kind and preserves cause", () => {
        const cause = new Error("disk full");
        const err = new PersistenceFailureError("db failed", {
            operation: "state_commit",
            cause,
            runId: RUN_ID,
        });
        assert.strictEqual(err.kind, "persistence_failure");
        assert.strictEqual(err.operation, "state_commit");
        assert.strictEqual(err.cause, cause);
    });
    test("all new errors are instanceof OrchestratorError", () => {
        assert.ok(new AuthorityLostError("x", {
            operation: "state_commit",
            reason: "STALE_HANDLE",
        }) instanceof OrchestratorError);
        assert.ok(new StateRevisionConflictError("x") instanceof OrchestratorError);
        assert.ok(new PersistenceFailureError("x", { operation: "state_commit" }) instanceof
            OrchestratorError);
    });
});
//# sourceMappingURL=authority-loss.test.js.map