// Bootstrap commit failure tests — TL-F-001 point 4.
//
// Proves that a real COMMIT failure (exception thrown before the SQL reaches
// SQLite) results in DB_FAILURE, no LockHandle, no durable rows, and a
// correct rollback.  Uses a SqliteConnection wrapper that injects failures
// at the exec("COMMIT") call.
//
// Distinct from the fault-injection tests in bootstrap-atomicity.test.ts:
// those inject exceptions at pre-commit fault points inside the transaction
// body; these inject exceptions at the COMMIT boundary itself.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { STATE_SCHEMA_VERSION } from "../../src/constants";
import { bunSqliteDriver } from "../../src/persistence/sqlite/bun-sqlite-driver";
import {
	type LockHandle,
	releaseOwnership,
} from "../../src/persistence/sqlite/ownership";
import {
	bootstrapNewRunAtomic,
	type CommittedState,
	migrateLegacyRunAtomic,
} from "../../src/persistence/sqlite/run-bootstrap";
import { openRunDatabase } from "../../src/persistence/sqlite/run-database";
import type {
	SqliteConnection,
	SqliteStatement,
} from "../../src/persistence/sqlite/sqlite-driver";
import { cleanupTempDir, makeTempDir } from "../helpers/temp-run-dir";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LEASE_MS = 30 * 60 * 1000;
const NOW_EPOCH = 1_000_000_000_000;
const NOW_ISO = "2001-09-09T01:46:40.000Z";
const CONTENTION_DEADLINE_MS = 2000;
const RUN_ID = "01HX0000000000000000000001";
const ORCH_NAME = "bootstrap-commit-failure-test";

// ---------------------------------------------------------------------------
// SQL normalization
// ---------------------------------------------------------------------------

function normalizeSql(sql: string): string {
	return sql.trim().replace(/;$/, "").toUpperCase();
}

// ---------------------------------------------------------------------------
// CommitFailingConnection — throws on COMMIT before delegating to inner
// ---------------------------------------------------------------------------

class CommitFailingConnection implements SqliteConnection {
	private _commitFailuresRemaining: number;
	/** Records every exec() call for assertion purposes. */
	readonly execLog: string[] = [];

	constructor(
		private readonly inner: SqliteConnection,
		failures = 1,
	) {
		this._commitFailuresRemaining = failures;
	}

	get commitFailuresRemaining(): number {
		return this._commitFailuresRemaining;
	}

	exec(sql: string): void {
		this.execLog.push(normalizeSql(sql));

		if (this._commitFailuresRemaining > 0 && normalizeSql(sql) === "COMMIT") {
			this._commitFailuresRemaining -= 1;
			throw new Error("INJECTED_COMMIT_FAILURE");
		}

		this.inner.exec(sql);
	}

	prepare(sql: string): SqliteStatement {
		return this.inner.prepare(sql);
	}

	close(): void {
		this.inner.close();
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function makeInitialState(overrides: Record<string, unknown> = {}) {
	return {
		schemaVersion: STATE_SCHEMA_VERSION,
		runId: RUN_ID,
		orchestratorName: ORCH_NAME,
		startedAt: NOW_ISO,
		startedAtEpochMs: NOW_EPOCH,
		lastTransitionAt: NOW_ISO,
		lastTransitionAtEpochMs: NOW_EPOCH,
		currentPhase: "start",
		phasesExecuted: 0,
		accumulatedDurationMs: 0,
		data: { stage: "initial" },
		usedLabels: [],
		...overrides,
	};
}

function assertTablesEmpty(runDb: ReturnType<typeof openRunDatabase>) {
	const inc = runDb.connection
		.prepare("SELECT COUNT(*) AS cnt FROM run_incarnation")
		.get() as { cnt: number };
	const own = runDb.connection
		.prepare("SELECT COUNT(*) AS cnt FROM run_ownership")
		.get() as { cnt: number };
	const state = runDb.connection
		.prepare("SELECT COUNT(*) AS cnt FROM run_state")
		.get() as { cnt: number };
	expect(inc.cnt).toBe(0);
	expect(own.cnt).toBe(0);
	expect(state.cnt).toBe(0);
}

function assertFullyEstablished(
	runDb: ReturnType<typeof openRunDatabase>,
	handle: LockHandle,
	_committed: CommittedState,
) {
	const incRow = runDb.connection
		.prepare(
			"SELECT incarnation_id, run_id, orchestrator_name FROM run_incarnation WHERE singleton = 1",
		)
		.get() as
		| { incarnation_id: string; run_id: string; orchestrator_name: string }
		| undefined;
	expect(incRow).toBeDefined();
	expect(incRow?.incarnation_id).toBe(handle.incarnationId);
	expect(incRow?.run_id).toBe(RUN_ID);

	const ownRow = runDb.connection
		.prepare(
			"SELECT ownership_status, owner_token, fence_token, lease_until_epoch_ms FROM run_ownership WHERE singleton = 1",
		)
		.get() as
		| {
				ownership_status: string;
				owner_token: string;
				fence_token: number | bigint;
				lease_until_epoch_ms: number;
		  }
		| undefined;
	expect(ownRow).toBeDefined();
	expect(ownRow?.ownership_status).toBe("HELD");
	expect(ownRow?.owner_token).toBe(handle.ownerToken);
	const ownFence =
		typeof ownRow?.fence_token === "bigint"
			? ownRow?.fence_token
			: BigInt(ownRow?.fence_token);
	expect(ownFence).toBe(handle.fenceToken);

	const stateRow = runDb.connection
		.prepare(
			"SELECT state_revision, committed_by_owner_token, committed_by_fence_token FROM run_state WHERE singleton = 1",
		)
		.get() as
		| {
				state_revision: number | bigint;
				committed_by_owner_token: string;
				committed_by_fence_token: number | bigint;
		  }
		| undefined;
	expect(stateRow).toBeDefined();
	expect(stateRow?.committed_by_owner_token).toBe(handle.ownerToken);
	const stateFence =
		typeof stateRow?.committed_by_fence_token === "bigint"
			? stateRow?.committed_by_fence_token
			: BigInt(stateRow?.committed_by_fence_token);
	expect(stateFence).toBe(handle.fenceToken);
	const rev =
		typeof stateRow?.state_revision === "bigint"
			? stateRow?.state_revision
			: BigInt(stateRow?.state_revision);
	expect(rev).toBe(0n);
}

// ---------------------------------------------------------------------------
// Tests — bootstrap COMMIT failure
// ---------------------------------------------------------------------------

describe("bootstrap commit failure", () => {
	test("real COMMIT failure returns DB_FAILURE", () => {
		const ctx = setup();

		// Wrap the real connection with a commit-failing proxy.
		const faulty = new CommitFailingConnection(ctx.runDb.connection, 1);

		const result = bootstrapNewRunAtomic({
			db: faulty,
			runId: RUN_ID,
			orchestratorName: ORCH_NAME,
			nowEpochMs: NOW_EPOCH,
			nowIso: NOW_ISO,
			leaseDurationMs: LEASE_MS,
			leaseClockEpochMs: () => NOW_EPOCH,
			initialState: makeInitialState(),
			stateSchemaVersion: STATE_SCHEMA_VERSION,
			contentionDeadlineMs: CONTENTION_DEADLINE_MS,
		});

		// Must be DB_FAILURE, not BOOTSTRAPPED or ACTIVE_CONFLICT.
		expect(result.kind).toBe("DB_FAILURE");

		// No handle, no committed state.
		expect(result).not.toHaveProperty("handle");

		if (result.kind === "DB_FAILURE") {
			expect(String(result.cause)).toContain("INJECTED_COMMIT_FAILURE");
		}

		ctx.cleanup();
	});

	test("commit failure returns no handle", () => {
		const ctx = setup();
		const faulty = new CommitFailingConnection(ctx.runDb.connection, 1);

		const result = bootstrapNewRunAtomic({
			db: faulty,
			runId: RUN_ID,
			orchestratorName: ORCH_NAME,
			nowEpochMs: NOW_EPOCH,
			nowIso: NOW_ISO,
			leaseDurationMs: LEASE_MS,
			leaseClockEpochMs: () => NOW_EPOCH,
			initialState: makeInitialState(),
			stateSchemaVersion: STATE_SCHEMA_VERSION,
			contentionDeadlineMs: CONTENTION_DEADLINE_MS,
		});

		// No handle property whatsoever.
		expect(result).not.toHaveProperty("handle");
		expect(result.kind).toBe("DB_FAILURE");

		ctx.cleanup();
	});

	test("commit failure leaves all run tables empty after reopen", () => {
		const ctx = setup();
		const faulty = new CommitFailingConnection(ctx.runDb.connection, 1);

		const result = bootstrapNewRunAtomic({
			db: faulty,
			runId: RUN_ID,
			orchestratorName: ORCH_NAME,
			nowEpochMs: NOW_EPOCH,
			nowIso: NOW_ISO,
			leaseDurationMs: LEASE_MS,
			leaseClockEpochMs: () => NOW_EPOCH,
			initialState: makeInitialState(),
			stateSchemaVersion: STATE_SCHEMA_VERSION,
			contentionDeadlineMs: CONTENTION_DEADLINE_MS,
		});

		expect(result.kind).toBe("DB_FAILURE");

		// Close the faulty connection (it wraps the real one — closing
		// the outer closes the inner).
		faulty.close();

		// Reopen the underlying DB file directly.
		const reopened = openRunDatabase({
			driver: bunSqliteDriver,
			dbPath: ctx.dbPath,
			busyTimeoutMs: 500,
		});

		try {
			// All three tables must be empty.
			assertTablesEmpty(reopened);
		} finally {
			reopened.close();
			ctx.cleanup();
		}
	});

	test("bootstrap can succeed after previous commit failure", () => {
		const ctx = setup();

		// First attempt: commit fails.
		const faulty = new CommitFailingConnection(ctx.runDb.connection, 1);
		const failed = bootstrapNewRunAtomic({
			db: faulty,
			runId: RUN_ID,
			orchestratorName: ORCH_NAME,
			nowEpochMs: NOW_EPOCH,
			nowIso: NOW_ISO,
			leaseDurationMs: LEASE_MS,
			leaseClockEpochMs: () => NOW_EPOCH,
			initialState: makeInitialState(),
			stateSchemaVersion: STATE_SCHEMA_VERSION,
			contentionDeadlineMs: CONTENTION_DEADLINE_MS,
		});
		expect(failed.kind).toBe("DB_FAILURE");

		// Close faulty, reopen clean.
		faulty.close();
		const reopened = openRunDatabase({
			driver: bunSqliteDriver,
			dbPath: ctx.dbPath,
			busyTimeoutMs: 500,
		});

		try {
			// Tables empty.
			assertTablesEmpty(reopened);

			// Second attempt on clean connection must succeed.
			const success = bootstrapNewRunAtomic({
				db: reopened.connection,
				runId: RUN_ID,
				orchestratorName: ORCH_NAME,
				nowEpochMs: NOW_EPOCH,
				nowIso: NOW_ISO,
				leaseDurationMs: LEASE_MS,
				leaseClockEpochMs: () => NOW_EPOCH,
				initialState: makeInitialState(),
				stateSchemaVersion: STATE_SCHEMA_VERSION,
				contentionDeadlineMs: CONTENTION_DEADLINE_MS,
			});

			expect(success.kind).toBe("BOOTSTRAPPED");
			if (success.kind === "BOOTSTRAPPED") {
				// fence starts at 1 — the failed attempt didn't consume it.
				expect(success.handle.fenceToken).toBe(1n);
				expect(success.committed.stateRevision).toBe("0");
				assertFullyEstablished(reopened, success.handle, success.committed);
				releaseOwnership({
					db: reopened.connection,
					handle: success.handle,
				});
			}
		} finally {
			reopened.close();
			ctx.cleanup();
		}
	});
});

// ---------------------------------------------------------------------------
// Tests — legacy migration COMMIT failure
// ---------------------------------------------------------------------------

describe("legacy migration commit failure", () => {
	const legacyState = makeInitialState({
		currentPhase: "legacy-phase",
		phasesExecuted: 5,
		data: { stage: "legacy" },
	});

	test("migration commit failure returns DB_FAILURE", () => {
		const ctx = setup();
		const faulty = new CommitFailingConnection(ctx.runDb.connection, 1);

		const result = migrateLegacyRunAtomic({
			db: faulty,
			runId: RUN_ID,
			orchestratorName: ORCH_NAME,
			nowEpochMs: NOW_EPOCH,
			nowIso: NOW_ISO,
			leaseDurationMs: LEASE_MS,
			leaseClockEpochMs: () => NOW_EPOCH,
			legacyState,
			legacyStartedAtEpochMs: NOW_EPOCH,
			legacyStartedAt: NOW_ISO,
			legacyLastTransitionAtEpochMs: NOW_EPOCH,
			legacyLastTransitionAt: NOW_ISO,
			stateSchemaVersion: STATE_SCHEMA_VERSION,
			contentionDeadlineMs: CONTENTION_DEADLINE_MS,
		});

		expect(result.kind).toBe("DB_FAILURE");
		expect(result).not.toHaveProperty("handle");

		if (result.kind === "DB_FAILURE") {
			expect(String(result.cause)).toContain("INJECTED_COMMIT_FAILURE");
		}

		ctx.cleanup();
	});

	test("migration commit failure preserves state.json byte-for-byte", () => {
		const ctx = setup();

		// Write legacy state.json.
		const stateJsonPath = join(ctx.dir, "state.json");
		const stateJsonBytes = Buffer.from(JSON.stringify(legacyState), "utf-8");
		require("node:fs").writeFileSync(stateJsonPath, stateJsonBytes);

		const faulty = new CommitFailingConnection(ctx.runDb.connection, 1);

		const result = migrateLegacyRunAtomic({
			db: faulty,
			runId: RUN_ID,
			orchestratorName: ORCH_NAME,
			nowEpochMs: NOW_EPOCH,
			nowIso: NOW_ISO,
			leaseDurationMs: LEASE_MS,
			leaseClockEpochMs: () => NOW_EPOCH,
			legacyState,
			legacyStartedAtEpochMs: NOW_EPOCH,
			legacyStartedAt: NOW_ISO,
			legacyLastTransitionAtEpochMs: NOW_EPOCH,
			legacyLastTransitionAt: NOW_ISO,
			stateSchemaVersion: STATE_SCHEMA_VERSION,
			contentionDeadlineMs: CONTENTION_DEADLINE_MS,
		});

		expect(result.kind).toBe("DB_FAILURE");

		// state.json must be unchanged.
		const currentBytes = readFileSync(stateJsonPath);
		expect(currentBytes.equals(stateJsonBytes)).toBe(true);

		// Close faulty, reopen — tables empty.
		faulty.close();
		const reopened = openRunDatabase({
			driver: bunSqliteDriver,
			dbPath: ctx.dbPath,
			busyTimeoutMs: 500,
		});

		try {
			assertTablesEmpty(reopened);

			// Re-migration must succeed.
			const second = migrateLegacyRunAtomic({
				db: reopened.connection,
				runId: RUN_ID,
				orchestratorName: ORCH_NAME,
				nowEpochMs: NOW_EPOCH,
				nowIso: NOW_ISO,
				leaseDurationMs: LEASE_MS,
				leaseClockEpochMs: () => NOW_EPOCH,
				legacyState,
				legacyStartedAtEpochMs: NOW_EPOCH,
				legacyStartedAt: NOW_ISO,
				legacyLastTransitionAtEpochMs: NOW_EPOCH,
				legacyLastTransitionAt: NOW_ISO,
				stateSchemaVersion: STATE_SCHEMA_VERSION,
				contentionDeadlineMs: CONTENTION_DEADLINE_MS,
			});

			expect(second.kind).toBe("MIGRATED");
			if (second.kind === "MIGRATED") {
				assertFullyEstablished(reopened, second.handle, second.committed);
				releaseOwnership({
					db: reopened.connection,
					handle: second.handle,
				});
			}
		} finally {
			reopened.close();
			ctx.cleanup();
		}
	});

	test("migration tables empty after commit failure", () => {
		const ctx = setup();
		const faulty = new CommitFailingConnection(ctx.runDb.connection, 1);

		const result = migrateLegacyRunAtomic({
			db: faulty,
			runId: RUN_ID,
			orchestratorName: ORCH_NAME,
			nowEpochMs: NOW_EPOCH,
			nowIso: NOW_ISO,
			leaseDurationMs: LEASE_MS,
			leaseClockEpochMs: () => NOW_EPOCH,
			legacyState,
			legacyStartedAtEpochMs: NOW_EPOCH,
			legacyStartedAt: NOW_ISO,
			legacyLastTransitionAtEpochMs: NOW_EPOCH,
			legacyLastTransitionAt: NOW_ISO,
			stateSchemaVersion: STATE_SCHEMA_VERSION,
			contentionDeadlineMs: CONTENTION_DEADLINE_MS,
		});

		expect(result.kind).toBe("DB_FAILURE");

		faulty.close();
		const reopened = openRunDatabase({
			driver: bunSqliteDriver,
			dbPath: ctx.dbPath,
			busyTimeoutMs: 500,
		});

		try {
			assertTablesEmpty(reopened);
		} finally {
			reopened.close();
			ctx.cleanup();
		}
	});
});

// ---------------------------------------------------------------------------
// Tests — exec sequence verification (BEGIN → COMMIT → ROLLBACK)
// ---------------------------------------------------------------------------

describe("exec sequence on commit failure", () => {
	test("COMMIT failure triggers ROLLBACK attempt", () => {
		const ctx = setup();
		const faulty = new CommitFailingConnection(ctx.runDb.connection, 1);

		bootstrapNewRunAtomic({
			db: faulty,
			runId: RUN_ID,
			orchestratorName: ORCH_NAME,
			nowEpochMs: NOW_EPOCH,
			nowIso: NOW_ISO,
			leaseDurationMs: LEASE_MS,
			leaseClockEpochMs: () => NOW_EPOCH,
			initialState: makeInitialState(),
			stateSchemaVersion: STATE_SCHEMA_VERSION,
			contentionDeadlineMs: CONTENTION_DEADLINE_MS,
		});

		// Verify the exec sequence:
		// 1. BEGIN IMMEDIATE
		// 2. ... various INSERT/UPDATE calls ...
		// 3. COMMIT (threw)
		// 4. ROLLBACK
		const log = faulty.execLog;

		const beginIdx = log.indexOf("BEGIN IMMEDIATE");
		expect(beginIdx).toBeGreaterThanOrEqual(0);

		const commitIdx = log.lastIndexOf("COMMIT");
		expect(commitIdx).toBeGreaterThan(beginIdx);
		expect(faulty.commitFailuresRemaining).toBe(0); // was consumed

		const rollbackIdx = log.lastIndexOf("ROLLBACK");
		expect(rollbackIdx).toBeGreaterThan(commitIdx);

		// Commit was attempted exactly once.
		const commitCount = log.filter((s) => s === "COMMIT").length;
		expect(commitCount).toBe(1);

		ctx.cleanup();
	});

	test("COMMIT failure in migration triggers ROLLBACK", () => {
		const ctx = setup();
		const faulty = new CommitFailingConnection(ctx.runDb.connection, 1);

		const legacyState = makeInitialState({ currentPhase: "test" });

		migrateLegacyRunAtomic({
			db: faulty,
			runId: RUN_ID,
			orchestratorName: ORCH_NAME,
			nowEpochMs: NOW_EPOCH,
			nowIso: NOW_ISO,
			leaseDurationMs: LEASE_MS,
			leaseClockEpochMs: () => NOW_EPOCH,
			legacyState,
			legacyStartedAtEpochMs: NOW_EPOCH,
			legacyStartedAt: NOW_ISO,
			legacyLastTransitionAtEpochMs: NOW_EPOCH,
			legacyLastTransitionAt: NOW_ISO,
			stateSchemaVersion: STATE_SCHEMA_VERSION,
			contentionDeadlineMs: CONTENTION_DEADLINE_MS,
		});

		const log = faulty.execLog;

		const beginIdx = log.indexOf("BEGIN IMMEDIATE");
		expect(beginIdx).toBeGreaterThanOrEqual(0);

		const commitIdx = log.lastIndexOf("COMMIT");
		expect(commitIdx).toBeGreaterThan(beginIdx);

		const rollbackIdx = log.lastIndexOf("ROLLBACK");
		expect(rollbackIdx).toBeGreaterThan(commitIdx);

		ctx.cleanup();
	});
});

// ---------------------------------------------------------------------------
// Tests — ROLLBACK also fails
// ---------------------------------------------------------------------------

describe("commit failure with rollback also failing", () => {
	test("COMMIT fails and ROLLBACK also fails → still DB_FAILURE, no handle", () => {
		const ctx = setup();

		// Wrapper: fails on COMMIT, then also fails on ROLLBACK.
		class CommitAndRollbackFailingConnection implements SqliteConnection {
			readonly execLog: string[] = [];

			constructor(private readonly inner: SqliteConnection) {}

			exec(sql: string): void {
				const normalized = normalizeSql(sql);
				this.execLog.push(normalized);

				if (normalized === "COMMIT") {
					throw new Error("INJECTED_COMMIT_FAILURE");
				}
				if (normalized === "ROLLBACK") {
					throw new Error("INJECTED_ROLLBACK_FAILURE");
				}

				this.inner.exec(sql);
			}

			prepare(sql: string): SqliteStatement {
				return this.inner.prepare(sql);
			}

			close(): void {
				this.inner.close();
			}
		}

		const faulty = new CommitAndRollbackFailingConnection(ctx.runDb.connection);

		const result = bootstrapNewRunAtomic({
			db: faulty,
			runId: RUN_ID,
			orchestratorName: ORCH_NAME,
			nowEpochMs: NOW_EPOCH,
			nowIso: NOW_ISO,
			leaseDurationMs: LEASE_MS,
			leaseClockEpochMs: () => NOW_EPOCH,
			initialState: makeInitialState(),
			stateSchemaVersion: STATE_SCHEMA_VERSION,
			contentionDeadlineMs: CONTENTION_DEADLINE_MS,
		});

		// Must still be DB_FAILURE — never a handle.
		expect(result.kind).toBe("DB_FAILURE");
		expect(result).not.toHaveProperty("handle");

		if (result.kind === "DB_FAILURE") {
			// The cause should reference the original COMMIT failure.
			expect(String(result.cause)).toContain("INJECTED_COMMIT_FAILURE");
		}

		// Both COMMIT and ROLLBACK were attempted.
		expect(faulty.execLog).toContain("COMMIT");
		expect(faulty.execLog).toContain("ROLLBACK");

		ctx.cleanup();
	});
});

// ---------------------------------------------------------------------------
// Tests — isBusy classification and retry behavior
// ---------------------------------------------------------------------------

describe("commit failure is not classified as BUSY", () => {
	test("INJECTED_COMMIT_FAILURE is not matched by isBusy", async () => {
		// Dynamically import to access the internal isBusy function.
		const { isBusy } = await import(
			"../../src/persistence/sqlite/run-bootstrap-core"
		);

		expect(isBusy(new Error("INJECTED_COMMIT_FAILURE"))).toBe(false);
		expect(isBusy(new Error("SQLITE_BUSY"))).toBe(true);
		expect(isBusy(new Error("database is locked"))).toBe(true);
		expect(isBusy(new Error("some random error"))).toBe(false);
	});

	test("non-BUSY COMMIT failure is not retried", () => {
		const ctx = setup();
		// Failures=1 — only one COMMIT should be attempted, not retried.
		const faulty = new CommitFailingConnection(ctx.runDb.connection, 1);

		bootstrapNewRunAtomic({
			db: faulty,
			runId: RUN_ID,
			orchestratorName: ORCH_NAME,
			nowEpochMs: NOW_EPOCH,
			nowIso: NOW_ISO,
			leaseDurationMs: LEASE_MS,
			leaseClockEpochMs: () => NOW_EPOCH,
			initialState: makeInitialState(),
			stateSchemaVersion: STATE_SCHEMA_VERSION,
			contentionDeadlineMs: CONTENTION_DEADLINE_MS,
		});

		// COMMIT must have been attempted exactly once.
		const commitCount = faulty.execLog.filter((s) => s === "COMMIT").length;
		expect(commitCount).toBe(1);

		// BEGIN IMMEDIATE should also be exactly once (no retry loop).
		const beginCount = faulty.execLog.filter(
			(s) => s === "BEGIN IMMEDIATE",
		).length;
		expect(beginCount).toBe(1);

		ctx.cleanup();
	});

	test("SQLITE_BUSY on COMMIT is retried (not the injected failure case)", () => {
		const ctx = setup();

		// Simulate: first COMMIT throws SQLITE_BUSY (which IS busy),
		// then second COMMIT succeeds.
		let commitAttempts = 0;
		const original = ctx.runDb.connection;
		const retryingWrapper: SqliteConnection = {
			exec(sql: string): void {
				if (normalizeSql(sql) === "COMMIT") {
					commitAttempts++;
					if (commitAttempts === 1) {
						throw new Error("SQLITE_BUSY: database is locked");
					}
				}
				original.exec(sql);
			},
			prepare(sql: string): SqliteStatement {
				return original.prepare(sql);
			},
			close(): void {
				original.close();
			},
		};

		const result = bootstrapNewRunAtomic({
			db: retryingWrapper,
			runId: RUN_ID,
			orchestratorName: ORCH_NAME,
			nowEpochMs: NOW_EPOCH,
			nowIso: NOW_ISO,
			leaseDurationMs: LEASE_MS,
			leaseClockEpochMs: () => NOW_EPOCH,
			initialState: makeInitialState(),
			stateSchemaVersion: STATE_SCHEMA_VERSION,
			contentionDeadlineMs: CONTENTION_DEADLINE_MS,
		});

		// The first COMMIT threw BUSY, the second succeeded.
		expect(commitAttempts).toBeGreaterThanOrEqual(2);
		expect(result.kind).toBe("BOOTSTRAPPED");

		if (result.kind === "BOOTSTRAPPED") {
			releaseOwnership({
				db: ctx.runDb.connection,
				handle: result.handle,
			});
		}

		ctx.cleanup();
	});
});

// ---------------------------------------------------------------------------
// Regression — the renamed test E still passes with its new name
// ---------------------------------------------------------------------------

describe("active ownership conflict (former DB_FAILURE test)", () => {
	test("second bootstrap on held DB returns ACTIVE_CONFLICT, no handle", () => {
		const ctx = setup();
		try {
			const first = bootstrapNewRunAtomic({
				db: ctx.runDb.connection,
				runId: RUN_ID,
				orchestratorName: ORCH_NAME,
				nowEpochMs: NOW_EPOCH,
				nowIso: NOW_ISO,
				leaseDurationMs: LEASE_MS,
				leaseClockEpochMs: () => NOW_EPOCH,
				initialState: makeInitialState(),
				stateSchemaVersion: STATE_SCHEMA_VERSION,
				contentionDeadlineMs: CONTENTION_DEADLINE_MS,
			});
			expect(first.kind).toBe("BOOTSTRAPPED");
			if (first.kind !== "BOOTSTRAPPED") return;

			// Don't release — ownership is HELD.

			const result = bootstrapNewRunAtomic({
				db: ctx.runDb.connection,
				runId: RUN_ID,
				orchestratorName: ORCH_NAME,
				nowEpochMs: NOW_EPOCH,
				nowIso: NOW_ISO,
				leaseDurationMs: LEASE_MS,
				leaseClockEpochMs: () => NOW_EPOCH,
				initialState: makeInitialState(),
				stateSchemaVersion: STATE_SCHEMA_VERSION,
				contentionDeadlineMs: CONTENTION_DEADLINE_MS,
			});

			expect(result.kind).toBe("ACTIVE_CONFLICT");
			expect(result).not.toHaveProperty("handle");

			releaseOwnership({
				db: ctx.runDb.connection,
				handle: first.handle,
			});
		} finally {
			ctx.cleanup();
		}
	});
});
