// TL-F-001 point 1 — Engine-level state commit wrapper tests.
//
// Covers: commit with stale handle, expired handle, revision conflict,
// DB failure; refresh stale/expired/DB_FAILURE; release stale strict/best-effort;
// state.json non-projection assertion.

import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { STATE_SCHEMA_VERSION } from "../../src/constants";
import {
	commitStateWithProjection,
	refreshOwnershipFromContext,
	releaseOwnershipBestEffort,
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
import { createMockLogger } from "../helpers/mock-logger";
import { cleanupTempDir, makeTempDir } from "../helpers/temp-run-dir";

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
				leaseDurationMs: LEASE_MS,
				contentionDeadlineMs: CONTENTION_DEADLINE_MS,
			});
			expect(acquired.kind).toBe("ACQUIRED");
			if (acquired.kind !== "ACQUIRED") return;
			const handleA = acquired.handle;

			// Seed initial state row.
			ensureInitialStateRow(
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
				leaseDurationMs: LEASE_MS,
				contentionDeadlineMs: CONTENTION_DEADLINE_MS,
			});
			expect(acquiredB.kind).toBe("ACQUIRED");

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
				expect.unreachable("should have thrown");
			} catch (err) {
				expect(err).toBeInstanceOf(AuthorityLostError);
				const aErr = err as AuthorityLostError;
				expect(aErr.kind).toBe("authority_lost");
				expect(aErr.operation).toBe("state_commit");
				expect(aErr.reason).toBe("STALE_HANDLE");
				// stateRevision must NOT have been updated.
				expect(commitCtx.stateRevision).toBe(stateRevisionBefore);
			}

			// state.json must NOT have been overwritten.
			expect(readFileSync(stateJsonPath, "utf-8")).toBe(KNOWN_CONTENT);
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
				leaseDurationMs: 1000,
				contentionDeadlineMs: CONTENTION_DEADLINE_MS,
			});
			expect(acquired.kind).toBe("ACQUIRED");
			if (acquired.kind !== "ACQUIRED") return;
			const handle = acquired.handle;

			ensureInitialStateRow(
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
				expect.unreachable("should have thrown");
			} catch (err) {
				expect(err).toBeInstanceOf(AuthorityLostError);
				const aErr = err as AuthorityLostError;
				expect(aErr.kind).toBe("authority_lost");
				expect(aErr.operation).toBe("state_commit");
				expect(aErr.reason).toBe("EXPIRED_HANDLE");
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
				leaseDurationMs: LEASE_MS,
				contentionDeadlineMs: CONTENTION_DEADLINE_MS,
			});
			expect(acquired.kind).toBe("ACQUIRED");
			if (acquired.kind !== "ACQUIRED") return;
			const handle = acquired.handle;

			ensureInitialStateRow(
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
				expect.unreachable("should have thrown");
			} catch (err) {
				expect(err).toBeInstanceOf(StateRevisionConflictError);
				const sErr = err as StateRevisionConflictError;
				expect(sErr.kind).toBe("state_revision_conflict");
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
				leaseDurationMs: LEASE_MS,
				contentionDeadlineMs: CONTENTION_DEADLINE_MS,
			});
			expect(acquired.kind).toBe("ACQUIRED");
			if (acquired.kind !== "ACQUIRED") return;
			const handle = acquired.handle;

			ensureInitialStateRow(
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
				expect.unreachable("should have thrown");
			} catch (err) {
				expect(err).toBeInstanceOf(PersistenceFailureError);
				const pErr = err as PersistenceFailureError;
				expect(pErr.kind).toBe("persistence_failure");
				expect(pErr.operation).toBe("state_commit");
				expect(pErr.cause).toBeDefined();
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
				leaseDurationMs: LEASE_MS,
				contentionDeadlineMs: CONTENTION_DEADLINE_MS,
			});
			expect(acquired.kind).toBe("ACQUIRED");
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
				expect.unreachable("should have thrown");
			} catch (err) {
				expect(err).toBeInstanceOf(PersistenceFailureError);
				const pErr = err as PersistenceFailureError;
				expect(pErr.kind).toBe("persistence_failure");
				expect(pErr.operation).toBe("refresh");
				expect(pErr.cause).toBeDefined();
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
				leaseDurationMs: LEASE_MS,
				contentionDeadlineMs: CONTENTION_DEADLINE_MS,
			});
			expect(acquired.kind).toBe("ACQUIRED");
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
				expect.unreachable("should have thrown");
			} catch (err) {
				expect(err).toBeInstanceOf(PersistenceFailureError);
				const pErr = err as PersistenceFailureError;
				expect(pErr.kind).toBe("persistence_failure");
				expect(pErr.operation).toBe("release");
				expect(pErr.cause).toBeDefined();
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
				leaseDurationMs: LEASE_MS,
				contentionDeadlineMs: CONTENTION_DEADLINE_MS,
			});
			expect(acquired.kind).toBe("ACQUIRED");
			if (acquired.kind !== "ACQUIRED") return;

			// Close the db to trigger DB_FAILURE on release.
			ctx.runDb.close();

			const logger = createMockLogger();

			expect(() =>
				releaseOwnershipBestEffort({
					runDb: ctx.runDb,
					handle: acquired.handle,
					runId: RUN_ID,
					logger,
				}),
			).not.toThrow();

			// Should have emitted a diagnostic.
			const failedEvents = logger.findAll("ownership_release_failed");
			expect(failedEvents.length).toBe(1);
			const ev = failedEvents[0] as { reason?: string };
			expect(ev.reason).toBe("DB_FAILURE");
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
				leaseDurationMs: LEASE_MS,
				contentionDeadlineMs: CONTENTION_DEADLINE_MS,
			});
			expect(acquired.kind).toBe("ACQUIRED");
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
				expect.unreachable("should have thrown");
			} catch (err) {
				expect(err).toBeInstanceOf(AuthorityLostError);
				const aErr = err as AuthorityLostError;
				expect(aErr.kind).toBe("authority_lost");
				expect(aErr.operation).toBe("refresh");
				expect(aErr.reason).toBe("STALE_HANDLE");
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
				leaseDurationMs: 1000,
				contentionDeadlineMs: CONTENTION_DEADLINE_MS,
			});
			expect(acquired.kind).toBe("ACQUIRED");
			if (acquired.kind !== "ACQUIRED") return;

			const refreshCtx = {
				runDb: ctx.runDb,
				handle: acquired.handle,
				runId: RUN_ID,
			};

			try {
				refreshOwnershipFromContext(refreshCtx);
				expect.unreachable("should have thrown");
			} catch (err) {
				expect(err).toBeInstanceOf(AuthorityLostError);
				const aErr = err as AuthorityLostError;
				expect(aErr.operation).toBe("refresh");
				expect(aErr.reason).toBe("EXPIRED_HANDLE");
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
				leaseDurationMs: LEASE_MS,
				contentionDeadlineMs: CONTENTION_DEADLINE_MS,
			});
			expect(acquired.kind).toBe("ACQUIRED");
			if (acquired.kind !== "ACQUIRED") return;

			const refreshCtx = {
				runDb: ctx.runDb,
				handle: acquired.handle,
				runId: RUN_ID,
			};

			const newHandle = refreshOwnershipFromContext(refreshCtx);

			expect(newHandle.ownerToken).toBe(acquired.handle.ownerToken);
			expect(newHandle.incarnationId).toBe(acquired.handle.incarnationId);
			expect(newHandle.fenceToken).toBe(acquired.handle.fenceToken);
			expect(newHandle.leaseUntilEpochMs).toBeGreaterThan(
				acquired.handle.leaseUntilEpochMs,
			);
			// ctx.handle must have been updated.
			expect(refreshCtx.handle.leaseUntilEpochMs).toBe(
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
				leaseDurationMs: LEASE_MS,
				contentionDeadlineMs: CONTENTION_DEADLINE_MS,
			});
			expect(acquired.kind).toBe("ACQUIRED");
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
				expect.unreachable("should have thrown");
			} catch (err) {
				expect(err).toBeInstanceOf(AuthorityLostError);
				const aErr = err as AuthorityLostError;
				expect(aErr.operation).toBe("release");
				expect(aErr.reason).toBe("STALE_HANDLE");
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
				leaseDurationMs: LEASE_MS,
				contentionDeadlineMs: CONTENTION_DEADLINE_MS,
			});
			expect(acquired.kind).toBe("ACQUIRED");
			if (acquired.kind !== "ACQUIRED") return;

			// Release first so handle is stale.
			sqliteReleaseOwnership({
				db: ctx.runDb.connection,
				handle: acquired.handle,
			});

			const logger = createMockLogger();

			// Must not throw.
			expect(() =>
				releaseOwnershipBestEffort({
					runDb: ctx.runDb,
					handle: acquired.handle,
					runId: RUN_ID,
					logger,
				}),
			).not.toThrow();

			// Should have emitted a diagnostic.
			const failedEvents = logger.findAll("ownership_release_failed");
			expect(failedEvents.length).toBe(1);
			const ev = failedEvents[0] as { reason?: string };
			expect(ev.reason).toBe("STALE_HANDLE");
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
				leaseDurationMs: LEASE_MS,
				contentionDeadlineMs: CONTENTION_DEADLINE_MS,
			});
			expect(acquired.kind).toBe("ACQUIRED");
			if (acquired.kind !== "ACQUIRED") return;
			const handle = acquired.handle;

			ensureInitialStateRow(
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

			expect(committed.state.stateRevision).toBe("1");
			expect(commitCtx.stateRevision).toBe("1");
			expect(committed.stateDigest).toMatch(/^sha256:/);
		} finally {
			ctx.cleanup();
		}
	});
});
