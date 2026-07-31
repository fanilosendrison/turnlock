// Lot 6 — crash recovery and integrity tests.
//
// Verifies that SQLite ownership survives process crashes and that
// state.json is a faithful projection of the authoritative state.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { bunSqliteDriver } from "../../src/persistence/sqlite/bun-sqlite-driver";
import {
	acquireOwnership,
	refreshOwnership,
	releaseOwnership,
} from "../../src/persistence/sqlite/ownership";
import { openRunDatabase } from "../../src/persistence/sqlite/run-database";
import {
	commitState,
	ensureInitialStateRow,
	projectStateJson,
	readAuthoritativeState,
	type StateRecord,
} from "../../src/persistence/sqlite/run-state-store";
import { cleanupTempDir, makeTempDir } from "../helpers/temp-run-dir";

const LEASE_MS = 30 * 60 * 1000;
const NOW_EPOCH = 1_000_000_000_000;
const NOW_ISO = "2001-09-09T01:46:40.000Z";

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
		dbPath,
		runDb,
		cleanup: () => {
			runDb.close();
			cleanupTempDir(dir);
		},
	};
}

function acquire(runDb: ReturnType<typeof openRunDatabase>) {
	return acquireOwnership({
		db: runDb.connection,
		runId: "01HX0000000000000000000001",
		orchestratorName: "crash-test",
		nowEpochMs: NOW_EPOCH,
		nowIso: NOW_ISO,
		leaseDurationMs: LEASE_MS,
		contentionDeadlineMs: 2000,
	});
}

describe("crash recovery", () => {
	test("uncommitted transaction is not visible after re-open", () => {
		const ctx = setup();
		try {
			const result = acquire(ctx.runDb);
			expect(result.kind).toBe("ACQUIRED");
			if (result.kind !== "ACQUIRED") return;

			// Simulate crash during transaction: BEGIN IMMEDIATE but no COMMIT.
			ctx.runDb.connection.exec("BEGIN IMMEDIATE");
			ctx.runDb.connection.exec(
				"UPDATE run_ownership SET lease_until_epoch_ms = 999 WHERE singleton = 1",
			);
			// No COMMIT — crash!

			// Re-open the DB (simulates process restart).
			ctx.runDb.close();

			const reopened = openRunDatabase({
				driver: bunSqliteDriver,
				dbPath: ctx.dbPath,
				busyTimeoutMs: 500,
			});

			try {
				// The uncommitted transaction must be rolled back.
				const row = reopened.connection
					.prepare(
						"SELECT lease_until_epoch_ms FROM run_ownership WHERE singleton = 1",
					)
					.get() as { lease_until_epoch_ms: number } | undefined;

				// The lease should be the original value, not 999.
				expect(row?.lease_until_epoch_ms).toBe(NOW_EPOCH + LEASE_MS);
			} finally {
				reopened.close();
			}
		} finally {
			ctx.cleanup();
		}
	});

	test("committed state is durable after re-open", () => {
		const ctx = setup();
		try {
			const result = acquire(ctx.runDb);
			expect(result.kind).toBe("ACQUIRED");
			if (result.kind !== "ACQUIRED") return;

			const initialState = {
				schemaVersion: 4,
				runId: "01HX0000000000000000000001",
				orchestratorName: "crash-test",
				startedAt: NOW_ISO,
				startedAtEpochMs: NOW_EPOCH,
				lastTransitionAt: NOW_ISO,
				lastTransitionAtEpochMs: NOW_EPOCH,
				currentPhase: "start",
				phasesExecuted: 0,
				accumulatedDurationMs: 0,
				data: { stage: "before-crash" },
				usedLabels: [] as readonly string[],
				runIncarnationId: result.handle.incarnationId,
				stateRevision: "1",
				committedFenceToken: String(result.handle.fenceToken),
			};

			ensureInitialStateRow(
				ctx.runDb.connection,
				result.handle.incarnationId,
				4,
				JSON.stringify(initialState),
				NOW_EPOCH,
				NOW_ISO,
			);

			// Commit a state transition.
			const cr = commitState({
				db: ctx.runDb.connection,
				handle: result.handle,
				expectedRevision: "0",
				nextState: { ...initialState, currentPhase: "after-commit" },
				nowEpochMs: NOW_EPOCH,
				nowIso: NOW_ISO,
			});
			expect(cr.kind).toBe("COMMITTED");

			// Simulate crash: close without projection.
			ctx.runDb.close();

			// Re-open and read authoritative state.
			const reopened = openRunDatabase({
				driver: bunSqliteDriver,
				dbPath: ctx.dbPath,
				busyTimeoutMs: 500,
			});

			try {
				const read = readAuthoritativeState(reopened.connection);
				expect(read.state).not.toBeNull();
				expect(read.state?.currentPhase).toBe("after-commit");
			} finally {
				reopened.close();
			}
		} finally {
			ctx.cleanup();
		}
	});

	test("state.json projection matches authoritative state", () => {
		const ctx = setup();
		try {
			const result = acquire(ctx.runDb);
			expect(result.kind).toBe("ACQUIRED");
			if (result.kind !== "ACQUIRED") return;

			const initial: StateRecord<{ stage: string }> = {
				schemaVersion: 4,
				runId: "01HX0000000000000000000001",
				orchestratorName: "crash-test",
				startedAt: NOW_ISO,
				startedAtEpochMs: NOW_EPOCH,
				lastTransitionAt: NOW_ISO,
				lastTransitionAtEpochMs: NOW_EPOCH,
				currentPhase: "start",
				phasesExecuted: 0,
				accumulatedDurationMs: 0,
				data: { stage: "projection-test" },
				usedLabels: [],
				runIncarnationId: result.handle.incarnationId,
				stateRevision: "1",
				committedFenceToken: String(result.handle.fenceToken),
			};

			ensureInitialStateRow(
				ctx.runDb.connection,
				result.handle.incarnationId,
				4,
				JSON.stringify(initial),
				NOW_EPOCH,
				NOW_ISO,
			);

			const cr = commitState({
				db: ctx.runDb.connection,
				handle: result.handle,
				expectedRevision: "0",
				nextState: initial,
				nowEpochMs: NOW_EPOCH,
				nowIso: NOW_ISO,
			});
			expect(cr.kind).toBe("COMMITTED");
			if (cr.kind !== "COMMITTED") return;

			// Project state.json.
			projectStateJson(ctx.dir, cr.committed.state, cr.committed.stateDigest);

			const statePath = join(ctx.dir, "state.json");
			expect(existsSync(statePath)).toBe(true);

			const projected = JSON.parse(readFileSync(statePath, "utf-8")) as Record<
				string,
				unknown
			>;
			expect(projected.data).toEqual({ stage: "projection-test" });
			expect(projected.stateDigest).toBe(cr.committed.stateDigest);
			expect(projected.runIncarnationId).toBe(result.handle.incarnationId);
		} finally {
			ctx.cleanup();
		}
	});
});

describe("ABA prevention", () => {
	test("old handle is rejected on new incarnation", () => {
		const ctx = setup();
		try {
			const first = acquire(ctx.runDb);
			expect(first.kind).toBe("ACQUIRED");
			if (first.kind !== "ACQUIRED") return;

			const firstHandle = first.handle;

			// Release and re-acquire.
			releaseOwnership({
				db: ctx.runDb.connection,
				handle: firstHandle,
			});

			const second = acquire(ctx.runDb);
			expect(second.kind).toBe("ACQUIRED");
			if (second.kind !== "ACQUIRED") return;

			// Old handle should be rejected for refresh.
			const refreshResult = refreshOwnership({
				db: ctx.runDb.connection,
				handle: firstHandle,
				nowEpochMs: NOW_EPOCH,
				leaseDurationMs: LEASE_MS,
			});
			expect(refreshResult.kind).toBe("STALE_HANDLE");
		} finally {
			ctx.cleanup();
		}
	});

	test("release with old fence token is rejected", () => {
		const ctx = setup();
		try {
			const first = acquire(ctx.runDb);
			expect(first.kind).toBe("ACQUIRED");
			if (first.kind !== "ACQUIRED") return;

			// Release and re-acquire (gives new fence token).
			releaseOwnership({
				db: ctx.runDb.connection,
				handle: first.handle,
			});

			const second = acquire(ctx.runDb);
			expect(second.kind).toBe("ACQUIRED");
			if (second.kind !== "ACQUIRED") return;

			// Try to release with the OLD handle (old fence token).
			const releaseResult = releaseOwnership({
				db: ctx.runDb.connection,
				handle: first.handle,
			});
			expect(releaseResult.kind).toBe("STALE_HANDLE");
		} finally {
			ctx.cleanup();
		}
	});
});
