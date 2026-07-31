// TL-F-001 point 1 — Authority loss continuation prevention tests.
//
// Demonstrates that after a commit rejection, the engine does NOT continue
// as if the commit succeeded (no DONE protocol block, no normal exit).

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { STATE_SCHEMA_VERSION } from "../../src/constants";
import {
	commitStateWithProjection,
	refreshOwnershipFromContext,
	releaseOwnershipFromContext,
} from "../../src/engine/state-commit";
import {
	AuthorityLostError,
	PersistenceFailureError,
	StateRevisionConflictError,
} from "../../src/errors/concrete";
import { bunSqliteDriver } from "../../src/persistence/sqlite/bun-sqlite-driver";
import {
	acquireOwnership,
	releaseOwnership as sqliteReleaseOwnership,
} from "../../src/persistence/sqlite/ownership";
import { openRunDatabase } from "../../src/persistence/sqlite/run-database";
import { ensureInitialStateRow } from "../../src/persistence/sqlite/run-state-store";
import { cleanupTempDir, makeTempDir } from "../helpers/temp-run-dir";

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
		driver: bunSqliteDriver,
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

// ---------------------------------------------------------------------------
// Handler continuation prevention
// ---------------------------------------------------------------------------

describe("authority loss — handler continuation prevention", () => {
	// -----------------------------------------------------------------------
	// 10.10 — DONE handler does not continue after stale commit
	// -----------------------------------------------------------------------

	test("terminal handler does not continue after stale commit", () => {
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
			expect(acquired.kind).toBe("ACQUIRED");
			if (acquired.kind !== "ACQUIRED") return;
			const handleA = acquired.handle;

			ensureInitialStateRow(
				ctx.runDb.connection,
				handleA.incarnationId,
				STATE_SCHEMA_VERSION,
				JSON.stringify({ schemaVersion: STATE_SCHEMA_VERSION, runId: RUN_ID }),
				epoch,
				iso,
			);

			// Simulate phase producing DONE, but ownership lost before commit.
			sqliteReleaseOwnership({
				db: ctx.runDb.connection,
				handle: handleA,
			});

			// Another worker acquires.
			acquireOwnership({
				db: ctx.runDb.connection,
				runId: RUN_ID,
				orchestratorName: "test",
				nowEpochMs: epoch + 1000,
				nowIso: iso,
				leaseDurationMs: LEASE_MS,
				contentionDeadlineMs: CONTENTION_DEADLINE_MS,
			});

			const commitCtx = {
				runDb: ctx.runDb,
				handle: handleA,
				runDir: ctx.dir,
				runId: RUN_ID,
				stateRevision: "0",
			};

			// This simulates what handleDone() does: commit, then emit DONE, then release, then exit.
			let emittedProtocolBlock = false;
			let releasedOwnership = false;
			let exited = false;

			try {
				// Step 1: commitStateWithProjection (should throw)
				commitStateWithProjection(commitCtx, {
					schemaVersion: STATE_SCHEMA_VERSION,
					runId: RUN_ID,
					orchestratorName: "test",
					startedAt: iso,
					startedAtEpochMs: epoch,
					lastTransitionAt: iso,
					lastTransitionAtEpochMs: epoch,
					currentPhase: "test-phase",
					phasesExecuted: 1,
					accumulatedDurationMs: 100,
					data: { ok: true },
					usedLabels: [],
				});
				// If we get here, the fix is not working.
				emittedProtocolBlock = true; // Would emit DONE block here
				releaseOwnershipFromContext(commitCtx);
				releasedOwnership = true;
				exited = true; // Would exit(0) here
			} catch (err) {
				expect(err).toBeInstanceOf(AuthorityLostError);
				expect((err as AuthorityLostError).kind).toBe("authority_lost");
			}

			// None of the post-commit steps should have executed.
			expect(emittedProtocolBlock).toBe(false);
			expect(releasedOwnership).toBe(false);
			expect(exited).toBe(false);
		} finally {
			ctx.cleanup();
		}
	});

	// -----------------------------------------------------------------------
	// Revision conflict also prevents continuation
	// -----------------------------------------------------------------------

	test("revision conflict prevents handler continuation", () => {
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
			expect(acquired.kind).toBe("ACQUIRED");
			if (acquired.kind !== "ACQUIRED") return;

			ensureInitialStateRow(
				ctx.runDb.connection,
				acquired.handle.incarnationId,
				STATE_SCHEMA_VERSION,
				JSON.stringify({ schemaVersion: STATE_SCHEMA_VERSION, runId: RUN_ID }),
				epoch,
				iso,
			);

			// Bump revision externally.
			ctx.runDb.connection.exec(
				"UPDATE run_state SET state_revision = 5 WHERE singleton = 1",
			);

			const commitCtx = {
				runDb: ctx.runDb,
				handle: acquired.handle,
				runDir: ctx.dir,
				runId: RUN_ID,
				stateRevision: "0",
			};

			let continued = false;
			try {
				commitStateWithProjection(commitCtx, {
					schemaVersion: STATE_SCHEMA_VERSION,
					runId: RUN_ID,
					orchestratorName: "test",
					startedAt: iso,
					startedAtEpochMs: epoch,
					lastTransitionAt: iso,
					lastTransitionAtEpochMs: epoch,
					currentPhase: "test-phase",
					phasesExecuted: 1,
					accumulatedDurationMs: 100,
					data: { ok: true },
					usedLabels: [],
				});
				continued = true;
			} catch (err) {
				expect(err).toBeInstanceOf(StateRevisionConflictError);
			}

			expect(continued).toBe(false);
		} finally {
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
			expect(acquired.kind).toBe("ACQUIRED");
			if (acquired.kind !== "ACQUIRED") return;

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
			} catch (err) {
				expect(err).toBeInstanceOf(AuthorityLostError);
				expect((err as AuthorityLostError).operation).toBe("refresh");
			}

			expect(continued).toBe(false);
		} finally {
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
		expect(err.kind).toBe("authority_lost");
		expect(err.operation).toBe("state_commit");
		expect(err.reason).toBe("STALE_HANDLE");
		expect(err.runId).toBe(RUN_ID);
		expect(err.message).toBe("msg");
	});

	test("StateRevisionConflictError has correct kind", () => {
		const err = new StateRevisionConflictError("conflict");
		expect(err.kind).toBe("state_revision_conflict");
		expect(err.message).toBe("conflict");
	});

	test("PersistenceFailureError has correct kind and preserves cause", () => {
		const cause = new Error("disk full");
		const err = new PersistenceFailureError("db failed", {
			operation: "state_commit",
			cause,
			runId: RUN_ID,
		});
		expect(err.kind).toBe("persistence_failure");
		expect(err.operation).toBe("state_commit");
		expect(err.cause).toBe(cause);
	});

	test("all new errors are instanceof OrchestratorError", () => {
		const { OrchestratorError } = require("../../src/errors/base");
		expect(
			new AuthorityLostError("x", {
				operation: "state_commit",
				reason: "STALE_HANDLE",
			}),
		).toBeInstanceOf(OrchestratorError);
		expect(new StateRevisionConflictError("x")).toBeInstanceOf(
			OrchestratorError,
		);
		expect(
			new PersistenceFailureError("x", { operation: "state_commit" }),
		).toBeInstanceOf(OrchestratorError);
	});
});
