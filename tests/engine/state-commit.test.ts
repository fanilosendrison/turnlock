import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
// TL-F-001 point 1 — Engine-level state commit wrapper tests.
//
// Covers: commit with stale handle, expired handle, revision conflict,
// DB failure; refresh stale/expired/DB_FAILURE; release stale strict/best-effort;
// state.json non-projection assertion.
import { describe, test } from "node:test";
import { STATE_SCHEMA_VERSION } from "../../src/constants.js";
import {
	commitStateWithProjection,
	refreshOwnershipFromContext,
	releaseOwnershipBestEffort,
	releaseOwnershipFromContext,
} from "../../src/engine/state-commit.js";
import {
	AuthorityLostError,
	PersistenceFailureError,
	StateRevisionConflictError,
} from "../../src/errors/concrete.js";
import { nodeSqliteDriver } from "../../src/persistence/sqlite/node-sqlite-driver.js";
import {
	acquireOwnership,
	releaseOwnership as sqliteReleaseOwnership,
} from "../../src/persistence/sqlite/ownership.js";
import { openRunDatabase } from "../../src/persistence/sqlite/run-database.js";
import { createMockLogger } from "../helpers/mock-logger.js";
import { cleanupTempDir, makeTempDir } from "../helpers/temp-run-dir.js";
import { unsafeEnsureInitialStateRow } from "../helpers/unsafe-state-seed.js";

const LEASE_MS = 30 * 60 * 1000;
const CONTENTION_DEADLINE_MS = 2000;
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
const RUN_ID = "01HX0000000000000000000001";
// ---------------------------------------------------------------------------
// 10.1 — Commit with stale handle (+ state.json non-projection assertion)
// ---------------------------------------------------------------------------
describe("commitStateWithProjection — strict orThrow", () => {
	test("stale handle throws AuthorityLostError and does not project state.json", () => {
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
				leaseClockEpochMs: () => epoch,
				leaseDurationMs: LEASE_MS,
				contentionDeadlineMs: CONTENTION_DEADLINE_MS,
			});
			assert.strictEqual(acquired.kind, "ACQUIRED");
			if (acquired.kind !== "ACQUIRED") return;
			const handleA = acquired.handle;
			// Seed initial state row.
			unsafeEnsureInitialStateRow(
				ctx.runDb.connection,
				handleA.incarnationId,
				STATE_SCHEMA_VERSION,
				JSON.stringify({ schemaVersion: STATE_SCHEMA_VERSION, runId: RUN_ID }),
				epoch,
				iso,
			);
			// Release via SQL (simulate another process taking over).
			sqliteReleaseOwnership({
				db: ctx.runDb.connection,
				handle: handleA,
			});
			// Re-acquire to bump fenceToken (worker B).
			const acquiredB = acquireOwnership({
				db: ctx.runDb.connection,
				runId: RUN_ID,
				orchestratorName: "test",
				nowEpochMs: epoch + 1000,
				nowIso: iso,
				leaseClockEpochMs: () => epoch + 1000,
				leaseDurationMs: LEASE_MS,
				contentionDeadlineMs: CONTENTION_DEADLINE_MS,
			});
			assert.strictEqual(acquiredB.kind, "ACQUIRED");
			// Write a known state.json before the attempt.
			const stateJsonPath = join(ctx.dir, "state.json");
			const KNOWN_CONTENT = "{}";
			writeFileSync(stateJsonPath, KNOWN_CONTENT);
			const stateRevisionBefore = "0";
			const commitCtx = {
				runDb: ctx.runDb,
				handle: handleA,
				runDir: ctx.dir,
				runId: RUN_ID,
				stateRevision: stateRevisionBefore,
			};
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
				assert.fail("should have thrown");
			} catch (err) {
				assert.ok(err instanceof AuthorityLostError);
				const aErr = err as AuthorityLostError;
				assert.strictEqual(aErr.kind, "authority_lost");
				assert.strictEqual(aErr.operation, "state_commit");
				assert.strictEqual(aErr.reason, "STALE_HANDLE");
				// stateRevision must NOT have been updated.
				assert.strictEqual(commitCtx.stateRevision, stateRevisionBefore);
			}
			// state.json must NOT have been overwritten.
			assert.strictEqual(readFileSync(stateJsonPath, "utf-8"), KNOWN_CONTENT);
		} finally {
			ctx.cleanup();
		}
	});
	// -----------------------------------------------------------------------
	// 10.2 — Commit with expired handle
	// -----------------------------------------------------------------------
	test("expired handle throws AuthorityLostError with reason EXPIRED_HANDLE", () => {
		const ctx = setup();
		try {
			// Acquire at epoch 0 so the lease expires.
			const acquired = acquireOwnership({
				db: ctx.runDb.connection,
				runId: RUN_ID,
				orchestratorName: "test",
				nowEpochMs: 0,
				nowIso: "1970-01-01T00:00:00.000Z",
				leaseClockEpochMs: () => 0,
				leaseDurationMs: 1000,
				contentionDeadlineMs: CONTENTION_DEADLINE_MS,
			});
			assert.strictEqual(acquired.kind, "ACQUIRED");
			if (acquired.kind !== "ACQUIRED") return;
			const handle = acquired.handle;
			unsafeEnsureInitialStateRow(
				ctx.runDb.connection,
				handle.incarnationId,
				STATE_SCHEMA_VERSION,
				JSON.stringify({ schemaVersion: STATE_SCHEMA_VERSION, runId: RUN_ID }),
				0,
				"1970-01-01T00:00:00.000Z",
			);
			const stateRevisionBefore = "0";
			const commitCtx = {
				runDb: ctx.runDb,
				handle,
				runDir: ctx.dir,
				runId: RUN_ID,
				stateRevision: stateRevisionBefore,
			};
			try {
				commitStateWithProjection(commitCtx, {
					schemaVersion: STATE_SCHEMA_VERSION,
					runId: RUN_ID,
					orchestratorName: "test",
					startedAt: "1970-01-01T00:00:00.000Z",
					startedAtEpochMs: 0,
					lastTransitionAt: "1970-01-01T00:00:00.000Z",
					lastTransitionAtEpochMs: 0,
					currentPhase: "test-phase",
					phasesExecuted: 1,
					accumulatedDurationMs: 100,
					data: { ok: true },
					usedLabels: [],
				});
				assert.fail("should have thrown");
			} catch (err) {
				assert.ok(err instanceof AuthorityLostError);
				const aErr = err as AuthorityLostError;
				assert.strictEqual(aErr.kind, "authority_lost");
				assert.strictEqual(aErr.operation, "state_commit");
				assert.strictEqual(aErr.reason, "EXPIRED_HANDLE");
			}
		} finally {
			ctx.cleanup();
		}
	});
	// -----------------------------------------------------------------------
	// 10.3 — Revision conflict
	// -----------------------------------------------------------------------
	test("revision conflict throws StateRevisionConflictError", () => {
		const ctx = setup();
		try {
			const { epoch, iso } = now();
			const acquired = acquireOwnership({
				db: ctx.runDb.connection,
				runId: RUN_ID,
				orchestratorName: "test",
				nowEpochMs: epoch,
				nowIso: iso,
				leaseClockEpochMs: () => epoch,
				leaseDurationMs: LEASE_MS,
				contentionDeadlineMs: CONTENTION_DEADLINE_MS,
			});
			assert.strictEqual(acquired.kind, "ACQUIRED");
			if (acquired.kind !== "ACQUIRED") return;
			const handle = acquired.handle;
			unsafeEnsureInitialStateRow(
				ctx.runDb.connection,
				handle.incarnationId,
				STATE_SCHEMA_VERSION,
				JSON.stringify({ schemaVersion: STATE_SCHEMA_VERSION, runId: RUN_ID }),
				epoch,
				iso,
			);
			// Bump state revision outside of the wrapper.
			ctx.runDb.connection.exec(
				"UPDATE run_state SET state_revision = 5 WHERE singleton = 1",
			);
			// ctx thinks revision is 0 but actual is 5.
			const commitCtx = {
				runDb: ctx.runDb,
				handle,
				runDir: ctx.dir,
				runId: RUN_ID,
				stateRevision: "0",
			};
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
				assert.fail("should have thrown");
			} catch (err) {
				assert.ok(err instanceof StateRevisionConflictError);
				const sErr = err as StateRevisionConflictError;
				assert.strictEqual(sErr.kind, "state_revision_conflict");
			}
		} finally {
			ctx.cleanup();
		}
	});
	// -----------------------------------------------------------------------
	// 10.4a — DB_FAILURE during commit
	// -----------------------------------------------------------------------
	test("DB_FAILURE during commit throws PersistenceFailureError with preserved cause", () => {
		const ctx = setup();
		try {
			const { epoch, iso } = now();
			const acquired = acquireOwnership({
				db: ctx.runDb.connection,
				runId: RUN_ID,
				orchestratorName: "test",
				nowEpochMs: epoch,
				nowIso: iso,
				leaseClockEpochMs: () => epoch,
				leaseDurationMs: LEASE_MS,
				contentionDeadlineMs: CONTENTION_DEADLINE_MS,
			});
			assert.strictEqual(acquired.kind, "ACQUIRED");
			if (acquired.kind !== "ACQUIRED") return;
			const handle = acquired.handle;
			unsafeEnsureInitialStateRow(
				ctx.runDb.connection,
				handle.incarnationId,
				STATE_SCHEMA_VERSION,
				JSON.stringify({ schemaVersion: STATE_SCHEMA_VERSION, runId: RUN_ID }),
				epoch,
				iso,
			);
			// Close the db to trigger DB_FAILURE.
			ctx.runDb.close();
			const commitCtx = {
				runDb: ctx.runDb,
				handle,
				runDir: ctx.dir,
				runId: RUN_ID,
				stateRevision: "0",
			};
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
				assert.fail("should have thrown");
			} catch (err) {
				assert.ok(err instanceof PersistenceFailureError);
				const pErr = err as PersistenceFailureError;
				assert.strictEqual(pErr.kind, "persistence_failure");
				assert.strictEqual(pErr.operation, "state_commit");
				assert.notStrictEqual(pErr.cause, undefined);
			}
		} finally {
			ctx.cleanup();
		}
	});
	// -----------------------------------------------------------------------
	// 10.4b — DB_FAILURE during refresh
	// -----------------------------------------------------------------------
	test("DB_FAILURE during refresh throws PersistenceFailureError", () => {
		const ctx = setup();
		try {
			const { epoch, iso } = now();
			const acquired = acquireOwnership({
				db: ctx.runDb.connection,
				runId: RUN_ID,
				orchestratorName: "test",
				nowEpochMs: epoch,
				nowIso: iso,
				leaseClockEpochMs: () => epoch,
				leaseDurationMs: LEASE_MS,
				contentionDeadlineMs: CONTENTION_DEADLINE_MS,
			});
			assert.strictEqual(acquired.kind, "ACQUIRED");
			if (acquired.kind !== "ACQUIRED") return;
			// Close the db to trigger DB_FAILURE on refresh.
			ctx.runDb.close();
			const refreshCtx = {
				runDb: ctx.runDb,
				handle: acquired.handle,
				runId: RUN_ID,
			};
			try {
				refreshOwnershipFromContext(refreshCtx);
				assert.fail("should have thrown");
			} catch (err) {
				assert.ok(err instanceof PersistenceFailureError);
				const pErr = err as PersistenceFailureError;
				assert.strictEqual(pErr.kind, "persistence_failure");
				assert.strictEqual(pErr.operation, "refresh");
				assert.notStrictEqual(pErr.cause, undefined);
			}
		} finally {
			ctx.cleanup();
		}
	});
	// -----------------------------------------------------------------------
	// 10.4c — DB_FAILURE during strict release
	// -----------------------------------------------------------------------
	test("DB_FAILURE during strict release throws PersistenceFailureError", () => {
		const ctx = setup();
		try {
			const { epoch, iso } = now();
			const acquired = acquireOwnership({
				db: ctx.runDb.connection,
				runId: RUN_ID,
				orchestratorName: "test",
				nowEpochMs: epoch,
				nowIso: iso,
				leaseClockEpochMs: () => epoch,
				leaseDurationMs: LEASE_MS,
				contentionDeadlineMs: CONTENTION_DEADLINE_MS,
			});
			assert.strictEqual(acquired.kind, "ACQUIRED");
			if (acquired.kind !== "ACQUIRED") return;
			// Close the db to trigger DB_FAILURE on release.
			ctx.runDb.close();
			const releaseCtx = {
				runDb: ctx.runDb,
				handle: acquired.handle,
				runId: RUN_ID,
			};
			try {
				releaseOwnershipFromContext(releaseCtx);
				assert.fail("should have thrown");
			} catch (err) {
				assert.ok(err instanceof PersistenceFailureError);
				const pErr = err as PersistenceFailureError;
				assert.strictEqual(pErr.kind, "persistence_failure");
				assert.strictEqual(pErr.operation, "release");
				assert.notStrictEqual(pErr.cause, undefined);
			}
		} finally {
			ctx.cleanup();
		}
	});
	// -----------------------------------------------------------------------
	// 10.4d — DB_FAILURE during best-effort release (no throw)
	// -----------------------------------------------------------------------
	test("DB_FAILURE during best-effort release does not throw", () => {
		const ctx = setup();
		try {
			const { epoch, iso } = now();
			const acquired = acquireOwnership({
				db: ctx.runDb.connection,
				runId: RUN_ID,
				orchestratorName: "test",
				nowEpochMs: epoch,
				nowIso: iso,
				leaseClockEpochMs: () => epoch,
				leaseDurationMs: LEASE_MS,
				contentionDeadlineMs: CONTENTION_DEADLINE_MS,
			});
			assert.strictEqual(acquired.kind, "ACQUIRED");
			if (acquired.kind !== "ACQUIRED") return;
			// Close the db to trigger DB_FAILURE on release.
			ctx.runDb.close();
			const logger = createMockLogger();
			assert.doesNotThrow(() =>
				releaseOwnershipBestEffort({
					runDb: ctx.runDb,
					handle: acquired.handle,
					runId: RUN_ID,
					logger,
				}),
			);
			// Should have emitted a diagnostic.
			const failedEvents = logger.findAll("ownership_release_failed");
			assert.strictEqual(failedEvents.length, 1);
			const ev = failedEvents[0] as {
				reason?: string;
			};
			assert.strictEqual(ev.reason, "DB_FAILURE");
		} finally {
			ctx.cleanup();
		}
	});
	// -----------------------------------------------------------------------
	// 10.5 — Refresh stale
	// -----------------------------------------------------------------------
	test("refresh with stale handle throws AuthorityLostError", () => {
		const ctx = setup();
		try {
			const { epoch, iso } = now();
			const acquired = acquireOwnership({
				db: ctx.runDb.connection,
				runId: RUN_ID,
				orchestratorName: "test",
				nowEpochMs: epoch,
				nowIso: iso,
				leaseClockEpochMs: () => epoch,
				leaseDurationMs: LEASE_MS,
				contentionDeadlineMs: CONTENTION_DEADLINE_MS,
			});
			assert.strictEqual(acquired.kind, "ACQUIRED");
			if (acquired.kind !== "ACQUIRED") return;
			const handle = acquired.handle;
			// Release via SQL.
			sqliteReleaseOwnership({
				db: ctx.runDb.connection,
				handle,
			});
			const refreshCtx = {
				runDb: ctx.runDb,
				handle,
				runId: RUN_ID,
			};
			try {
				refreshOwnershipFromContext(refreshCtx);
				assert.fail("should have thrown");
			} catch (err) {
				assert.ok(err instanceof AuthorityLostError);
				const aErr = err as AuthorityLostError;
				assert.strictEqual(aErr.kind, "authority_lost");
				assert.strictEqual(aErr.operation, "refresh");
				assert.strictEqual(aErr.reason, "STALE_HANDLE");
			}
		} finally {
			ctx.cleanup();
		}
	});
	// -----------------------------------------------------------------------
	// 10.6 — Refresh expired
	// -----------------------------------------------------------------------
	test("refresh with expired handle throws AuthorityLostError", () => {
		const ctx = setup();
		try {
			const acquired = acquireOwnership({
				db: ctx.runDb.connection,
				runId: RUN_ID,
				orchestratorName: "test",
				nowEpochMs: 0,
				nowIso: "1970-01-01T00:00:00.000Z",
				leaseClockEpochMs: () => 0,
				leaseDurationMs: 1000,
				contentionDeadlineMs: CONTENTION_DEADLINE_MS,
			});
			assert.strictEqual(acquired.kind, "ACQUIRED");
			if (acquired.kind !== "ACQUIRED") return;
			const refreshCtx = {
				runDb: ctx.runDb,
				handle: acquired.handle,
				runId: RUN_ID,
			};
			try {
				refreshOwnershipFromContext(refreshCtx);
				assert.fail("should have thrown");
			} catch (err) {
				assert.ok(err instanceof AuthorityLostError);
				const aErr = err as AuthorityLostError;
				assert.strictEqual(aErr.operation, "refresh");
				assert.strictEqual(aErr.reason, "EXPIRED_HANDLE");
			}
		} finally {
			ctx.cleanup();
		}
	});
	// -----------------------------------------------------------------------
	// 10.7 — Refresh success
	// -----------------------------------------------------------------------
	test("successful refresh returns LockHandle and updates ctx.handle", () => {
		const ctx = setup();
		try {
			const { epoch, iso } = now();
			const acquired = acquireOwnership({
				db: ctx.runDb.connection,
				runId: RUN_ID,
				orchestratorName: "test",
				nowEpochMs: epoch,
				nowIso: iso,
				// Keep the assertion independent of wall-clock millisecond resolution.
				leaseClockEpochMs: () => epoch - 1,
				leaseDurationMs: LEASE_MS,
				contentionDeadlineMs: CONTENTION_DEADLINE_MS,
			});
			assert.strictEqual(acquired.kind, "ACQUIRED");
			if (acquired.kind !== "ACQUIRED") return;
			const refreshCtx = {
				runDb: ctx.runDb,
				handle: acquired.handle,
				runId: RUN_ID,
			};
			const newHandle = refreshOwnershipFromContext(refreshCtx);
			assert.strictEqual(newHandle.ownerToken, acquired.handle.ownerToken);
			assert.strictEqual(
				newHandle.incarnationId,
				acquired.handle.incarnationId,
			);
			assert.strictEqual(newHandle.fenceToken, acquired.handle.fenceToken);
			assert.ok(
				newHandle.leaseUntilEpochMs > acquired.handle.leaseUntilEpochMs,
			);
			// ctx.handle must have been updated.
			assert.strictEqual(
				refreshCtx.handle.leaseUntilEpochMs,
				newHandle.leaseUntilEpochMs,
			);
		} finally {
			ctx.cleanup();
		}
	});
	// -----------------------------------------------------------------------
	// 10.8 — Release stale (strict)
	// -----------------------------------------------------------------------
	test("strict release with stale handle throws AuthorityLostError", () => {
		const ctx = setup();
		try {
			const { epoch, iso } = now();
			const acquired = acquireOwnership({
				db: ctx.runDb.connection,
				runId: RUN_ID,
				orchestratorName: "test",
				nowEpochMs: epoch,
				nowIso: iso,
				leaseClockEpochMs: () => epoch,
				leaseDurationMs: LEASE_MS,
				contentionDeadlineMs: CONTENTION_DEADLINE_MS,
			});
			assert.strictEqual(acquired.kind, "ACQUIRED");
			if (acquired.kind !== "ACQUIRED") return;
			// Release first (so handle is stale).
			sqliteReleaseOwnership({
				db: ctx.runDb.connection,
				handle: acquired.handle,
			});
			const releaseCtx = {
				runDb: ctx.runDb,
				handle: acquired.handle,
				runId: RUN_ID,
			};
			try {
				releaseOwnershipFromContext(releaseCtx);
				assert.fail("should have thrown");
			} catch (err) {
				assert.ok(err instanceof AuthorityLostError);
				const aErr = err as AuthorityLostError;
				assert.strictEqual(aErr.operation, "release");
				assert.strictEqual(aErr.reason, "STALE_HANDLE");
			}
		} finally {
			ctx.cleanup();
		}
	});
	// -----------------------------------------------------------------------
	// 10.9 — Release best-effort stale
	// -----------------------------------------------------------------------
	test("best-effort release with stale handle does not throw", () => {
		const ctx = setup();
		try {
			const { epoch, iso } = now();
			const acquired = acquireOwnership({
				db: ctx.runDb.connection,
				runId: RUN_ID,
				orchestratorName: "test",
				nowEpochMs: epoch,
				nowIso: iso,
				leaseClockEpochMs: () => epoch,
				leaseDurationMs: LEASE_MS,
				contentionDeadlineMs: CONTENTION_DEADLINE_MS,
			});
			assert.strictEqual(acquired.kind, "ACQUIRED");
			if (acquired.kind !== "ACQUIRED") return;
			// Release first so handle is stale.
			sqliteReleaseOwnership({
				db: ctx.runDb.connection,
				handle: acquired.handle,
			});
			const logger = createMockLogger();
			// Must not throw.
			assert.doesNotThrow(() =>
				releaseOwnershipBestEffort({
					runDb: ctx.runDb,
					handle: acquired.handle,
					runId: RUN_ID,
					logger,
				}),
			);
			// Should have emitted a diagnostic.
			const failedEvents = logger.findAll("ownership_release_failed");
			assert.strictEqual(failedEvents.length, 1);
			const ev = failedEvents[0] as {
				reason?: string;
			};
			assert.strictEqual(ev.reason, "STALE_HANDLE");
		} finally {
			ctx.cleanup();
		}
	});
	// -----------------------------------------------------------------------
	// Successful commit returns CommittedState and updates stateRevision
	// -----------------------------------------------------------------------
	test("successful commit returns CommittedState and updates ctx.stateRevision", () => {
		const ctx = setup();
		try {
			const { epoch, iso } = now();
			const acquired = acquireOwnership({
				db: ctx.runDb.connection,
				runId: RUN_ID,
				orchestratorName: "test",
				nowEpochMs: epoch,
				nowIso: iso,
				leaseClockEpochMs: () => epoch,
				leaseDurationMs: LEASE_MS,
				contentionDeadlineMs: CONTENTION_DEADLINE_MS,
			});
			assert.strictEqual(acquired.kind, "ACQUIRED");
			if (acquired.kind !== "ACQUIRED") return;
			const handle = acquired.handle;
			unsafeEnsureInitialStateRow(
				ctx.runDb.connection,
				handle.incarnationId,
				STATE_SCHEMA_VERSION,
				JSON.stringify({ schemaVersion: STATE_SCHEMA_VERSION, runId: RUN_ID }),
				epoch,
				iso,
			);
			const commitCtx = {
				runDb: ctx.runDb,
				handle,
				runDir: ctx.dir,
				runId: RUN_ID,
				stateRevision: "0",
			};
			const committed = commitStateWithProjection(commitCtx, {
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
			assert.strictEqual(committed.state.stateRevision, "1");
			assert.strictEqual(commitCtx.stateRevision, "1");
			assert.match(committed.stateDigest, /^sha256:/);
		} finally {
			ctx.cleanup();
		}
	});
});
