// TL-F-001 point 1 — Authority loss continuation prevention tests.
//
// Demonstrates that after a commit rejection, the real handler does NOT continue
// as if the commit succeeded:
//   - No DONE protocol block is emitted
//   - No doExit(0) occurs
//   - The error (AuthorityLostError) propagates out

import { describe, expect, mock, test } from "bun:test";
import { join } from "node:path";
import { STATE_SCHEMA_VERSION } from "../../src/constants";
import type { DispatchContext } from "../../src/engine/context";
import { refreshOwnershipFromContext } from "../../src/engine/state-commit";
import { handleDone } from "../../src/engine/terminal-handlers";
import {
	AuthorityLostError,
	PersistenceFailureError,
	StateRevisionConflictError,
} from "../../src/errors/concrete";
import { bunSqliteDriver } from "../../src/persistence/sqlite/bun-sqlite-driver";
import {
	acquireOwnership,
	type LockHandle,
	releaseOwnership as sqliteReleaseOwnership,
} from "../../src/persistence/sqlite/ownership";
import { openRunDatabase } from "../../src/persistence/sqlite/run-database";
import { ensureInitialStateRow } from "../../src/persistence/sqlite/run-state-store";
import type { StateFile } from "../../src/services/state-io";
import { createMockLogger } from "../helpers/mock-logger";
import { cleanupTempDir, makeTempDir } from "../helpers/temp-run-dir";

const LEASE_MS = 30 * 60 * 1000;
const CONTENTION_DEADLINE_MS = 2000;
const RUN_ID = "01HX0000000000000000000001";

interface TestState {
	readonly ok: boolean;
}

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

function makeState(
	overrides: Partial<StateFile<TestState>> = {},
): StateFile<TestState> {
	return {
		schemaVersion: STATE_SCHEMA_VERSION,
		runId: RUN_ID,
		orchestratorName: "test",
		startedAt: "2024-01-01T00:00:00.000Z",
		startedAtEpochMs: 1_704_067_200_000,
		lastTransitionAt: "2024-01-01T00:00:00.000Z",
		lastTransitionAtEpochMs: 1_704_067_200_000,
		currentPhase: "test-phase",
		phasesExecuted: 1,
		accumulatedDurationMs: 100,
		data: { ok: true },
		usedLabels: [],
		...overrides,
	};
}

function makeContext(
	dir: string,
	runDb: ReturnType<typeof openRunDatabase>,
	handle: LockHandle,
): DispatchContext<TestState> {
	return {
		config: {
			name: "test",
			initial: "start",
			initialState: { ok: false },
			resumeCommand: (id) => `bun test --run-id ${id} --resume`,
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
			const writeMock = mock((chunk: string | Uint8Array) => {
				stdoutContent +=
					typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
				return true;
			});
			process.stdout.write = writeMock as typeof process.stdout.write;

			let catchedErr: unknown = null;
			try {
				await handleDone(
					dCtx,
					state,
					{ kind: "done", output: { ok: true } },
					200,
				);
			} catch (err) {
				catchedErr = err;
			} finally {
				process.stdout.write = originalWrite;
			}

			// Must throw AuthorityLostError, not TestExitSignal or anything else.
			expect(catchedErr).toBeInstanceOf(AuthorityLostError);
			expect((catchedErr as AuthorityLostError).kind).toBe("authority_lost");

			// stdout must NOT contain a DONE block.
			expect(stdoutContent).not.toContain("@@TURNLOCK@@");
			expect(stdoutContent).not.toContain("action: DONE");

			// No orchestrator_end(success=true) in the logger.
			const logger = dCtx.logger as ReturnType<typeof createMockLogger>;
			const endEvents = logger.findAll("orchestrator_end");
			const successEnd = endEvents.filter(
				(e) => (e as { success?: boolean }).success === true,
			);
			expect(successEnd.length).toBe(0);
		} finally {
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

			const dCtx = makeContext(ctx.dir, ctx.runDb, acquired.handle);
			// Override stateRevision to simulate stale expectation.
			dCtx.stateRevision = "0";
			const state = makeState();

			let catchedErr: unknown = null;
			try {
				await handleDone(
					dCtx,
					state,
					{ kind: "done", output: { ok: true } },
					200,
				);
			} catch (err) {
				catchedErr = err;
			}

			expect(catchedErr).toBeInstanceOf(StateRevisionConflictError);
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
