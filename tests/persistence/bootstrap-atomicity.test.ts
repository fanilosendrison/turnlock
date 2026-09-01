import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
// Bootstrap atomicity tests — TL-F-001 point 4.
//
// Verifies that incarnation + ownership + state are established in a single
// BEGIN IMMEDIATE ... COMMIT, or not at all.  No partial state is observable
// after any bootstrap or migration attempt.
//
// The "bootstrap primitive fault injection" and "legacy migration primitive
// fault injection" sections prove atomicity by injecting exceptions at every
// pre-commit boundary inside the REAL bootstrap / migration primitives, then
// verifying complete rollback with zero observable rows.
import { describe, test } from "node:test";
import { STATE_SCHEMA_VERSION } from "../../src/constants.js";
import { nodeSqliteDriver } from "../../src/persistence/sqlite/node-sqlite-driver.js";
import {
	acquireOwnership,
	type LockHandle,
	releaseOwnership,
} from "../../src/persistence/sqlite/ownership.js";
import {
	bootstrapNewRunAtomic,
	type CommittedState,
	migrateLegacyRunAtomic,
} from "../../src/persistence/sqlite/run-bootstrap.js";
import {
	type BootstrapFaultPoint,
	bootstrapNewRunAtomicCore,
	InjectedBootstrapFailure,
	migrateLegacyRunAtomicCore,
} from "../../src/persistence/sqlite/run-bootstrap-core.js";
import { openRunDatabase } from "../../src/persistence/sqlite/run-database.js";
import { readAuthoritativeState } from "../../src/persistence/sqlite/run-state-store.js";
import { cleanupTempDir, makeTempDir } from "../helpers/temp-run-dir.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const LEASE_MS = 30 * 60 * 1000;
const NOW_EPOCH = 1000000000000;
const NOW_ISO = "2001-09-09T01:46:40.000Z";
const CONTENTION_DEADLINE_MS = 2000;
const RUN_ID = "01HX0000000000000000000001";
const ORCH_NAME = "bootstrap-atomicity-test";
const PRE_COMMIT_FAULT_POINTS: BootstrapFaultPoint[] = [
	"AFTER_BEGIN",
	"AFTER_INCARNATION_WRITE",
	"AFTER_OWNERSHIP_WRITE",
	"AFTER_STATE_WRITE",
	"BEFORE_COMMIT",
];
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
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
		.get() as {
		cnt: number;
	};
	const own = runDb.connection
		.prepare("SELECT COUNT(*) AS cnt FROM run_ownership")
		.get() as {
		cnt: number;
	};
	const state = runDb.connection
		.prepare("SELECT COUNT(*) AS cnt FROM run_state")
		.get() as {
		cnt: number;
	};
	assert.strictEqual(inc.cnt, 0);
	assert.strictEqual(own.cnt, 0);
	assert.strictEqual(state.cnt, 0);
}
function assertFullyEstablished(
	runDb: ReturnType<typeof openRunDatabase>,
	handle: LockHandle,
	committed: CommittedState,
) {
	// incarnation
	const incRow = runDb.connection
		.prepare(
			"SELECT incarnation_id, run_id, orchestrator_name FROM run_incarnation WHERE singleton = 1",
		)
		.get() as
		| {
				incarnation_id: string;
				run_id: string;
				orchestrator_name: string;
		  }
		| undefined;
	assert.notStrictEqual(incRow, undefined);
	assert.strictEqual(incRow!.incarnation_id, handle.incarnationId);
	assert.strictEqual(incRow!.run_id, RUN_ID);
	// ownership
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
	assert.notStrictEqual(ownRow, undefined);
	assert.strictEqual(ownRow!.ownership_status, "HELD");
	assert.strictEqual(ownRow!.owner_token, handle.ownerToken);
	const ownFence =
		typeof ownRow!.fence_token === "bigint"
			? ownRow!.fence_token
			: BigInt(ownRow!.fence_token);
	assert.strictEqual(ownFence, handle.fenceToken);
	// state
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
	assert.notStrictEqual(stateRow, undefined);
	assert.strictEqual(stateRow!.committed_by_owner_token, handle.ownerToken);
	const stateFence =
		typeof stateRow!.committed_by_fence_token === "bigint"
			? stateRow!.committed_by_fence_token
			: BigInt(stateRow!.committed_by_fence_token);
	assert.strictEqual(stateFence, handle.fenceToken);
	const rev =
		typeof stateRow!.state_revision === "bigint"
			? stateRow!.state_revision
			: BigInt(stateRow!.state_revision);
	assert.strictEqual(rev, 0n);
	// committed state
	assert.strictEqual(committed.stateRevision, "0");
	assert.strictEqual(committed.committedFenceToken, String(handle.fenceToken));
	assert.strictEqual(committed.incarnationId, handle.incarnationId);
}
// ---------------------------------------------------------------------------
// Test A — Bootstrap réussi
// ---------------------------------------------------------------------------
describe("bootstrap atomicity", () => {
	test("A — bootstrap réussi: all three tables populated, handle valid", () => {
		const ctx = setup();
		try {
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
			assert.strictEqual(result.kind, "BOOTSTRAPPED");
			if (result.kind !== "BOOTSTRAPPED") return;
			assert.strictEqual(result.handle.fenceToken, 1n);
			assertFullyEstablished(ctx.runDb, result.handle, result.committed);
			// Verify state can be read back.
			const authRead = readAuthoritativeState(ctx.runDb.connection);
			assert.notStrictEqual(authRead.state, null);
			assert.strictEqual(authRead.state!.stateRevision, "0");
			assert.strictEqual(
				authRead.state!.runIncarnationId,
				result.handle.incarnationId,
			);
			// Clean release.
			releaseOwnership({
				db: ctx.runDb.connection,
				handle: result.handle,
			});
		} finally {
			ctx.cleanup();
		}
	});
	// -----------------------------------------------------------------------
	// Test B — Already established DB with active owner produces ACTIVE_CONFLICT
	// -----------------------------------------------------------------------
	test("B — DB fully established with active owner → ACTIVE_CONFLICT", () => {
		const ctx = setup();
		try {
			// First bootstrap.
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
			assert.strictEqual(first.kind, "BOOTSTRAPPED");
			if (first.kind !== "BOOTSTRAPPED") return;
			// Second bootstrap on the same DB while lease is active.
			const second = bootstrapNewRunAtomic({
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
			// Should report active conflict (via the already-established
			// path detecting the active owner).
			assert.strictEqual(second.kind, "ACTIVE_CONFLICT");
			// Clean release.
			releaseOwnership({
				db: ctx.runDb.connection,
				handle: first.handle,
			});
		} finally {
			ctx.cleanup();
		}
	});
	// -----------------------------------------------------------------------
	// Test C — Bootstrap on already established (FREE) DB
	// -----------------------------------------------------------------------
	test("C — DB already established but FREE → ALREADY_ESTABLISHED", () => {
		const ctx = setup();
		try {
			// First bootstrap.
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
			assert.strictEqual(first.kind, "BOOTSTRAPPED");
			if (first.kind !== "BOOTSTRAPPED") return;
			// Release.
			releaseOwnership({
				db: ctx.runDb.connection,
				handle: first.handle,
			});
			// Second bootstrap on FREE DB.
			const second = bootstrapNewRunAtomic({
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
			assert.strictEqual(second.kind, "ALREADY_ESTABLISHED");
		} finally {
			ctx.cleanup();
		}
	});
	// -----------------------------------------------------------------------
	// Test D — Idempotent: repeated bootstrap on same run returns
	//         ALREADY_ESTABLISHED when already held
	// -----------------------------------------------------------------------
	test("D — repeated bootstrap with active lease → ACTIVE_CONFLICT", () => {
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
			assert.strictEqual(first.kind, "BOOTSTRAPPED");
			if (first.kind !== "BOOTSTRAPPED") return;
			// DB already established AND held → ACTIVE_CONFLICT.
			const second = bootstrapNewRunAtomic({
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
			assert.strictEqual(second.kind, "ACTIVE_CONFLICT");
			releaseOwnership({
				db: ctx.runDb.connection,
				handle: first.handle,
			});
		} finally {
			ctx.cleanup();
		}
	});
	// -----------------------------------------------------------------------
	// Test E — Active ownership conflict returns no handle
	//
	// NOTE: This test verifies that a second bootstrap attempt on an
	// already-owned DB returns ACTIVE_CONFLICT without publishing a
	// LockHandle.  It does NOT test DB_FAILURE from a real COMMIT error.
	// For real COMMIT failure tests, see bootstrap-commit-failure.test.ts.
	// -----------------------------------------------------------------------
	test("E — active ownership conflict returns no handle", () => {
		const ctx = setup();
		try {
			// First bootstrap to populate the DB.
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
			assert.strictEqual(first.kind, "BOOTSTRAPPED");
			if (first.kind !== "BOOTSTRAPPED") return;
			// Don't release — ownership is HELD.
			// Second bootstrap attempt with active owner.
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
			// Must return ACTIVE_CONFLICT, not BOOTSTRAPPED, and no handle.
			assert.strictEqual(result.kind, "ACTIVE_CONFLICT");
			assert.ok(!("handle" in Object(result)));
			releaseOwnership({
				db: ctx.runDb.connection,
				handle: first.handle,
			});
		} finally {
			ctx.cleanup();
		}
	});
});
// ---------------------------------------------------------------------------
// Fault injection tests
// ---------------------------------------------------------------------------
describe("bootstrap atomicity — fault injection", () => {
	// -----------------------------------------------------------------------
	// Test F — Schema-only DB is recoverable
	// -----------------------------------------------------------------------
	test("F — schema-only DB: bootstrap succeeds on second attempt", () => {
		const ctx = setup();
		// Simulate: close and reopen (schema-only state).
		ctx.runDb.close();
		const reopened = openRunDatabase({
			driver: nodeSqliteDriver,
			dbPath: ctx.dbPath,
			busyTimeoutMs: 500,
		});
		try {
			// Verify empty.
			assertTablesEmpty(reopened);
			// Bootstrap should succeed.
			const result = bootstrapNewRunAtomic({
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
			assert.strictEqual(result.kind, "BOOTSTRAPPED");
			if (result.kind !== "BOOTSTRAPPED") return;
			assertFullyEstablished(reopened, result.handle, result.committed);
			releaseOwnership({
				db: reopened.connection,
				handle: result.handle,
			});
		} finally {
			reopened.close();
			ctx.cleanup();
		}
	});
	// -----------------------------------------------------------------------
	// Test G — Low-level SQLite: uncommitted transaction rolled back
	//
	// NOTE: This test manually executes BEGIN/INSERT/ROLLBACK as raw SQL.
	// It proves SQLite rollback semantics, NOT that bootstrapNewRunAtomic
	// correctly handles its own error path.  For proof that the real
	// primitive rolls back on injected failures, see the
	// "bootstrap primitive fault injection" section below.
	// -----------------------------------------------------------------------
	test("G — SQLite low-level: uncommitted transaction rolled back explicitly", () => {
		const ctx = setup();
		// Simulate a partial bootstrap failure: BEGIN, insert some rows,
		// then ROLLBACK.  This is exactly what bootstrapNewRunAtomic does
		// when an error occurs before COMMIT.
		ctx.runDb.connection.exec("BEGIN IMMEDIATE");
		ctx.runDb.connection.exec(`INSERT INTO run_incarnation (singleton, run_id, incarnation_id, orchestrator_name, created_at_epoch_ms, created_at_iso)
			 VALUES (1, '${RUN_ID}', 'fake-inc', '${ORCH_NAME}', ${NOW_EPOCH}, '${NOW_ISO}')`);
		ctx.runDb.connection.exec(`INSERT INTO run_ownership (singleton, incarnation_id, ownership_status, fence_token)
			 VALUES (1, 'fake-inc', 'HELD', 1)`);
		// Simulate error → ROLLBACK.
		ctx.runDb.connection.exec("ROLLBACK");
		// Verify no rows are visible after rollback.
		assertTablesEmpty(ctx.runDb);
		// Bootstrap should succeed on the same connection.
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
		assert.strictEqual(result.kind, "BOOTSTRAPPED");
		if (result.kind !== "BOOTSTRAPPED") return;
		assertFullyEstablished(ctx.runDb, result.handle, result.committed);
		releaseOwnership({
			db: ctx.runDb.connection,
			handle: result.handle,
		});
		ctx.cleanup();
	});
	// -----------------------------------------------------------------------
	// Test H — Incarnation-only DB: bootstrap FORBIDDEN, migration recovers
	// -----------------------------------------------------------------------
	test("H — incarnation-only partial DB: bootstrapNewRunAtomic rejects", () => {
		const ctx = setup();
		// Simulate old implementation: incarnation present, ownership FREE,
		// no state row.  Use acquireOwnership then release to set this up.
		const acq = acquireOwnership({
			db: ctx.runDb.connection,
			runId: RUN_ID,
			orchestratorName: ORCH_NAME,
			nowEpochMs: NOW_EPOCH,
			nowIso: NOW_ISO,
			leaseDurationMs: LEASE_MS,
			contentionDeadlineMs: CONTENTION_DEADLINE_MS,
			leaseClockEpochMs: () => NOW_EPOCH,
		});
		assert.strictEqual(acq.kind, "ACQUIRED");
		if (acq.kind !== "ACQUIRED") return;
		// Release (leaves incarnation + FREE ownership, no state).
		releaseOwnership({ db: ctx.runDb.connection, handle: acq.handle });
		// Verify: incarnation exists, ownership is FREE, state absent.
		const incCnt = ctx.runDb.connection
			.prepare("SELECT COUNT(*) AS cnt FROM run_incarnation")
			.get() as {
			cnt: number;
		};
		assert.strictEqual(incCnt.cnt, 1);
		const stateCnt = ctx.runDb.connection
			.prepare("SELECT COUNT(*) AS cnt FROM run_state")
			.get() as {
			cnt: number;
		};
		assert.strictEqual(stateCnt.cnt, 0);
		// bootstrapNewRunAtomic must reject partial DB — config.initialState
		// is not a valid recovery source for an old partial incarnation.
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
		assert.strictEqual(result.kind, "INCOMPLETE_EXISTING_BOOTSTRAP");
		// Verify state still absent — rollback preserved.
		const stateCntAfter = ctx.runDb.connection
			.prepare("SELECT COUNT(*) AS cnt FROM run_state")
			.get() as {
			cnt: number;
		};
		assert.strictEqual(stateCntAfter.cnt, 0);
		ctx.cleanup();
	});
	test("H2 — incarnation-only partial DB: migrateLegacyRunAtomic recovers", () => {
		const ctx = setup();
		// Same setup: partial DB with incarnation + FREE ownership, no state.
		const acq = acquireOwnership({
			db: ctx.runDb.connection,
			runId: RUN_ID,
			orchestratorName: ORCH_NAME,
			nowEpochMs: NOW_EPOCH,
			nowIso: NOW_ISO,
			leaseDurationMs: LEASE_MS,
			contentionDeadlineMs: CONTENTION_DEADLINE_MS,
			leaseClockEpochMs: () => NOW_EPOCH,
		});
		assert.strictEqual(acq.kind, "ACQUIRED");
		if (acq.kind !== "ACQUIRED") return;
		releaseOwnership({ db: ctx.runDb.connection, handle: acq.handle });
		// migrateLegacyRunAtomic with a validated legacy state CAN recover.
		const legacyState = makeInitialState({ currentPhase: "legacy-recovered" });
		const result = migrateLegacyRunAtomic({
			db: ctx.runDb.connection,
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
		assert.strictEqual(result.kind, "MIGRATED");
		if (result.kind !== "MIGRATED") return;
		// Tests H2 — incarnation exists already (from prior acquireOwnership).
		// Migration must reuse the existing incarnation, not replace it.
		const incRow = ctx.runDb.connection
			.prepare("SELECT incarnation_id FROM run_incarnation WHERE singleton = 1")
			.get() as {
			incarnation_id: string;
		};
		assert.notStrictEqual(incRow.incarnation_id, RUN_ID);
		// fence_token increments from 1 to 2.
		assert.strictEqual(result.handle.fenceToken, 2n);
		// State was recovered from legacy source.
		const authRead = readAuthoritativeState(ctx.runDb.connection);
		assert.notStrictEqual(authRead.state, null);
		assert.strictEqual(authRead.state!.currentPhase, "legacy-recovered");
		releaseOwnership({ db: ctx.runDb.connection, handle: result.handle });
		ctx.cleanup();
	});
	// -----------------------------------------------------------------------
	// Test I — Owned-no-state DB (old impl: ownership HELD, no state)
	// -----------------------------------------------------------------------
	test("I — owned-no-state DB with active lease → INCOMPLETE_EXISTING_BOOTSTRAP", () => {
		const ctx = setup();
		// Acquire ownership (leaves: incarnation + HELD ownership, no state).
		const acq = acquireOwnership({
			db: ctx.runDb.connection,
			runId: RUN_ID,
			orchestratorName: ORCH_NAME,
			nowEpochMs: NOW_EPOCH,
			nowIso: NOW_ISO,
			leaseDurationMs: LEASE_MS,
			contentionDeadlineMs: CONTENTION_DEADLINE_MS,
			leaseClockEpochMs: () => NOW_EPOCH,
		});
		assert.strictEqual(acq.kind, "ACQUIRED");
		if (acq.kind !== "ACQUIRED") return;
		// DON'T release — ownership is HELD, no state row.
		// Verify state absent.
		const stateCnt = ctx.runDb.connection
			.prepare("SELECT COUNT(*) AS cnt FROM run_state")
			.get() as {
			cnt: number;
		};
		assert.strictEqual(stateCnt.cnt, 0);
		// Bootstrap on this DB with active lease.
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
		// Should report incomplete bootstrap (ownership held, no state).
		assert.strictEqual(result.kind, "INCOMPLETE_EXISTING_BOOTSTRAP");
		// Verify state still absent — rollback preserved.
		const stateCntAfter = ctx.runDb.connection
			.prepare("SELECT COUNT(*) AS cnt FROM run_state")
			.get() as {
			cnt: number;
		};
		assert.strictEqual(stateCntAfter.cnt, 0);
		releaseOwnership({ db: ctx.runDb.connection, handle: acq.handle });
		ctx.cleanup();
	});
	// -----------------------------------------------------------------------
	// Test J — Owned-no-state DB with expired lease: bootstrap rejects,
	//         migrateLegacyRunAtomic recovers
	// -----------------------------------------------------------------------
	test("J — owned-no-state DB with expired lease: bootstrapNewRunAtomic rejects", () => {
		const ctx = setup();
		// Acquire ownership with epoch 0 (immediately expired relative to NOW_EPOCH).
		const acq = acquireOwnership({
			db: ctx.runDb.connection,
			runId: RUN_ID,
			orchestratorName: ORCH_NAME,
			nowEpochMs: 0,
			nowIso: "1970-01-01T00:00:00.000Z",
			leaseDurationMs: 1000,
			contentionDeadlineMs: CONTENTION_DEADLINE_MS,
			leaseClockEpochMs: () => 0,
		});
		assert.strictEqual(acq.kind, "ACQUIRED");
		if (acq.kind !== "ACQUIRED") return;
		// State absent.
		const stateCnt = ctx.runDb.connection
			.prepare("SELECT COUNT(*) AS cnt FROM run_state")
			.get() as {
			cnt: number;
		};
		assert.strictEqual(stateCnt.cnt, 0);
		// bootstrapNewRunAtomic rejects — config.initialState is not
		// a valid recovery source for an incomplete DB.
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
		assert.strictEqual(result.kind, "INCOMPLETE_EXISTING_BOOTSTRAP");
		// State still absent — rollback preserved.
		const stateCntAfter = ctx.runDb.connection
			.prepare("SELECT COUNT(*) AS cnt FROM run_state")
			.get() as {
			cnt: number;
		};
		assert.strictEqual(stateCntAfter.cnt, 0);
		// Cleanup: release the stale ownership so the DB can be reused.
		releaseOwnership({ db: ctx.runDb.connection, handle: acq.handle });
		ctx.cleanup();
	});
	test("J2 — owned-no-state DB with expired lease: migrateLegacyRunAtomic recovers", () => {
		const ctx = setup();
		// Same expired partial DB setup.
		const acq = acquireOwnership({
			db: ctx.runDb.connection,
			runId: RUN_ID,
			orchestratorName: ORCH_NAME,
			nowEpochMs: 0,
			nowIso: "1970-01-01T00:00:00.000Z",
			leaseDurationMs: 1000,
			contentionDeadlineMs: CONTENTION_DEADLINE_MS,
			leaseClockEpochMs: () => 0,
		});
		assert.strictEqual(acq.kind, "ACQUIRED");
		if (acq.kind !== "ACQUIRED") return;
		// migrateLegacyRunAtomic recovers from validated legacy state.
		const legacyState = makeInitialState({
			currentPhase: "recovered-via-migration",
		});
		const result = migrateLegacyRunAtomic({
			db: ctx.runDb.connection,
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
		assert.strictEqual(result.kind, "MIGRATED");
		if (result.kind !== "MIGRATED") return;
		// fence should have incremented (was 1, now 2).
		assert.strictEqual(result.handle.fenceToken, 2n);
		// State recovered from legacy source.
		const authRead = readAuthoritativeState(ctx.runDb.connection);
		assert.notStrictEqual(authRead.state, null);
		assert.strictEqual(authRead.state!.currentPhase, "recovered-via-migration");
		releaseOwnership({ db: ctx.runDb.connection, handle: result.handle });
		ctx.cleanup();
	});
});
// ---------------------------------------------------------------------------
// Bootstrap primitive fault injection
// ---------------------------------------------------------------------------
// Proves that an exception injected INSIDE the real bootstrapNewRunAtomicCore
// at each pre-commit boundary results in complete rollback: zero observable
// rows in all three tables, no LockHandle returned, and the DB is immediately
// reusable for a fresh bootstrap.
function makeDeterministicIdGenerator(): () => string {
	let counter = 0;
	return (): string => {
		counter++;
		return `test-id-${String(counter).padStart(4, "0")}`;
	};
}
describe("bootstrap primitive fault injection", () => {
	for (const point of PRE_COMMIT_FAULT_POINTS) {
		test(`rollback at ${point} — zero rows, no handle, re-bootstrap succeeds`, () => {
			const ctx = setup();
			try {
				const result = bootstrapNewRunAtomicCore(
					{
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
					},
					{
						generateId: makeDeterministicIdGenerator(),
						onFaultPoint(p: BootstrapFaultPoint) {
							if (p === point) {
								throw new InjectedBootstrapFailure(p);
							}
						},
					},
				);
				// Must not report BOOTSTRAPPED.
				assert.notStrictEqual(result.kind, "BOOTSTRAPPED");
				assert.strictEqual(result.kind, "DB_FAILURE");
				// Must not return a handle.
				assert.ok(!("handle" in Object(result)));
				if (result.kind === "DB_FAILURE") {
					assert.ok(result.cause instanceof InjectedBootstrapFailure);
					assert.strictEqual(
						(result.cause as InjectedBootstrapFailure).point,
						point,
					);
				}
				// Close and reopen — verify all three tables are empty.
				ctx.runDb.close();
				const reopened = openRunDatabase({
					driver: nodeSqliteDriver,
					dbPath: ctx.dbPath,
					busyTimeoutMs: 500,
				});
				try {
					assertTablesEmpty(reopened);
					// Re-bootstrap on the reopened DB must succeed.
					const second = bootstrapNewRunAtomic({
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
					assert.strictEqual(second.kind, "BOOTSTRAPPED");
					if (second.kind === "BOOTSTRAPPED") {
						assertFullyEstablished(reopened, second.handle, second.committed);
						releaseOwnership({
							db: reopened.connection,
							handle: second.handle,
						});
					}
				} finally {
					reopened.close();
				}
			} finally {
				// runDb may already be closed; best-effort cleanup.
				try {
					ctx.runDb.close();
				} catch {
					/* ok */
				}
				ctx.cleanup();
			}
		});
	}
});
// ---------------------------------------------------------------------------
// Legacy migration primitive fault injection
// ---------------------------------------------------------------------------
// Same proof for migrateLegacyRunAtomicCore — injected exception at each
// pre-commit boundary leaves zero rows, no LockHandle, and the legacy
// state.json unchanged byte-for-byte.
describe("legacy migration primitive fault injection", () => {
	const legacyState = makeInitialState({
		currentPhase: "legacy-phase",
		phasesExecuted: 5,
	});
	for (const point of PRE_COMMIT_FAULT_POINTS) {
		test(`rollback at ${point} — zero rows, no handle, state.json intact, re-migration succeeds`, () => {
			const ctx = setup();
			// Write a real legacy state.json file to capture its bytes.
			const stateJsonPath = join(ctx.dir, "state.json");
			const stateJsonBytes = Buffer.from(JSON.stringify(legacyState), "utf-8");
			writeFileSync(stateJsonPath, stateJsonBytes);
			try {
				const result = migrateLegacyRunAtomicCore(
					{
						db: ctx.runDb.connection,
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
					},
					{
						generateId: makeDeterministicIdGenerator(),
						onFaultPoint(p: BootstrapFaultPoint) {
							if (p === point) {
								throw new InjectedBootstrapFailure(p);
							}
						},
					},
				);
				// Must not report MIGRATED.
				assert.notStrictEqual(result.kind, "MIGRATED");
				assert.strictEqual(result.kind, "DB_FAILURE");
				// Must not return a handle.
				assert.ok(!("handle" in Object(result)));
				if (result.kind === "DB_FAILURE") {
					assert.ok(result.cause instanceof InjectedBootstrapFailure);
					assert.strictEqual(
						(result.cause as InjectedBootstrapFailure).point,
						point,
					);
				}
				// Close and reopen — verify all three tables are empty.
				ctx.runDb.close();
				const reopened = openRunDatabase({
					driver: nodeSqliteDriver,
					dbPath: ctx.dbPath,
					busyTimeoutMs: 500,
				});
				try {
					assertTablesEmpty(reopened);
					// Verify state.json is unchanged byte-for-byte.
					const currentBytes = readFileSync(stateJsonPath);
					assert.strictEqual(currentBytes.equals(stateJsonBytes), true);
					// Re-migration on the reopened DB must succeed.
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
					assert.strictEqual(second.kind, "MIGRATED");
					if (second.kind === "MIGRATED") {
						assertFullyEstablished(reopened, second.handle, second.committed);
						releaseOwnership({
							db: reopened.connection,
							handle: second.handle,
						});
					}
				} finally {
					reopened.close();
				}
			} finally {
				try {
					ctx.runDb.close();
				} catch {
					/* ok */
				}
				ctx.cleanup();
			}
		});
	}
});
// ---------------------------------------------------------------------------
// Post-commit hook structural verification
// ---------------------------------------------------------------------------
// AFTER_COMMIT_BEFORE_HANDLE fires after COMMIT succeeds but before the
// LockHandle is built.  This test only verifies the hook IS called — it does
// NOT throw (post-commit failures cannot be rolled back and will be proven
// by real-process crash tests in a later lot).
describe("post-commit hook", () => {
	test("AFTER_COMMIT_BEFORE_HANDLE is called after successful COMMIT", () => {
		const ctx = setup();
		let postCommitCalled = false;
		try {
			const result = bootstrapNewRunAtomicCore(
				{
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
				},
				{
					generateId: makeDeterministicIdGenerator(),
					onFaultPoint(p: BootstrapFaultPoint) {
						if (p === "AFTER_COMMIT_BEFORE_HANDLE") {
							postCommitCalled = true;
						}
					},
				},
			);
			assert.strictEqual(postCommitCalled, true);
			assert.strictEqual(result.kind, "BOOTSTRAPPED");
			if (result.kind === "BOOTSTRAPPED") {
				releaseOwnership({
					db: ctx.runDb.connection,
					handle: result.handle,
				});
			}
		} finally {
			ctx.cleanup();
		}
	});
	test("AFTER_COMMIT_BEFORE_HANDLE fires for migration too", () => {
		const ctx = setup();
		let postCommitCalled = false;
		const legacyState = makeInitialState({ currentPhase: "post-commit-test" });
		try {
			const result = migrateLegacyRunAtomicCore(
				{
					db: ctx.runDb.connection,
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
				},
				{
					generateId: makeDeterministicIdGenerator(),
					onFaultPoint(p: BootstrapFaultPoint) {
						if (p === "AFTER_COMMIT_BEFORE_HANDLE") {
							postCommitCalled = true;
						}
					},
				},
			);
			assert.strictEqual(postCommitCalled, true);
			assert.strictEqual(result.kind, "MIGRATED");
			if (result.kind === "MIGRATED") {
				releaseOwnership({
					db: ctx.runDb.connection,
					handle: result.handle,
				});
			}
		} finally {
			ctx.cleanup();
		}
	});
});
// ---------------------------------------------------------------------------
// Legacy migration atomicity tests
// ---------------------------------------------------------------------------
describe("legacy migration atomicity", () => {
	test("K — migration réussie: all three tables populated, handle valid", () => {
		const ctx = setup();
		const legacyState = {
			schemaVersion: STATE_SCHEMA_VERSION,
			runId: RUN_ID,
			orchestratorName: ORCH_NAME,
			startedAt: "2020-01-01T00:00:00.000Z",
			startedAtEpochMs: 1577836800000,
			lastTransitionAt: "2020-01-01T00:01:00.000Z",
			lastTransitionAtEpochMs: 1577836860000,
			currentPhase: "legacy-phase",
			phasesExecuted: 5,
			accumulatedDurationMs: 10000,
			data: { stage: "legacy" },
			usedLabels: ["old-label"],
		};
		const result = migrateLegacyRunAtomic({
			db: ctx.runDb.connection,
			runId: RUN_ID,
			orchestratorName: ORCH_NAME,
			nowEpochMs: NOW_EPOCH,
			nowIso: NOW_ISO,
			leaseDurationMs: LEASE_MS,
			leaseClockEpochMs: () => NOW_EPOCH,
			legacyState,
			legacyStartedAtEpochMs: 1577836800000,
			legacyStartedAt: "2020-01-01T00:00:00.000Z",
			legacyLastTransitionAtEpochMs: 1577836860000,
			legacyLastTransitionAt: "2020-01-01T00:01:00.000Z",
			stateSchemaVersion: STATE_SCHEMA_VERSION,
			contentionDeadlineMs: CONTENTION_DEADLINE_MS,
		});
		assert.strictEqual(result.kind, "MIGRATED");
		if (result.kind !== "MIGRATED") return;
		assertFullyEstablished(ctx.runDb, result.handle, result.committed);
		// Verify legacy timestamps preserved.
		const incRow = ctx.runDb.connection
			.prepare(
				"SELECT created_at_epoch_ms, created_at_iso FROM run_incarnation WHERE singleton = 1",
			)
			.get() as {
			created_at_epoch_ms: number;
			created_at_iso: string;
		};
		assert.strictEqual(incRow.created_at_epoch_ms, 1577836800000);
		assert.strictEqual(incRow.created_at_iso, "2020-01-01T00:00:00.000Z");
		// Verify ownership uses current time.
		const ownRow = ctx.runDb.connection
			.prepare(
				"SELECT acquired_at_epoch_ms, lease_until_epoch_ms FROM run_ownership WHERE singleton = 1",
			)
			.get() as {
			acquired_at_epoch_ms: number;
			lease_until_epoch_ms: number;
		};
		assert.strictEqual(ownRow.acquired_at_epoch_ms, NOW_EPOCH);
		assert.strictEqual(ownRow.lease_until_epoch_ms, NOW_EPOCH + LEASE_MS);
		// Verify state preserves legacy data.
		const authRead = readAuthoritativeState(ctx.runDb.connection);
		assert.notStrictEqual(authRead.state, null);
		assert.strictEqual(authRead.state!.currentPhase, "legacy-phase");
		assert.strictEqual(authRead.state!.phasesExecuted, 5);
		// Verify startedAt and lastTransitionAt are distinct and preserved.
		assert.strictEqual(authRead.state!.startedAt, "2020-01-01T00:00:00.000Z");
		assert.strictEqual(authRead.state!.startedAtEpochMs, 1577836800000);
		assert.strictEqual(
			authRead.state!.lastTransitionAt,
			"2020-01-01T00:01:00.000Z",
		);
		assert.strictEqual(authRead.state!.lastTransitionAtEpochMs, 1577836860000);
		releaseOwnership({ db: ctx.runDb.connection, handle: result.handle });
		ctx.cleanup();
	});
	test("L — migration on already established DB → ALREADY_ESTABLISHED", () => {
		const ctx = setup();
		const legacyState = makeInitialState();
		const first = migrateLegacyRunAtomic({
			db: ctx.runDb.connection,
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
		assert.strictEqual(first.kind, "MIGRATED");
		if (first.kind !== "MIGRATED") return;
		// Release before second attempt.
		releaseOwnership({ db: ctx.runDb.connection, handle: first.handle });
		// Second migration on the same DB.
		const second = migrateLegacyRunAtomic({
			db: ctx.runDb.connection,
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
		assert.strictEqual(second.kind, "ALREADY_ESTABLISHED");
		ctx.cleanup();
	});
	test("M — migration with active owner → ACTIVE_CONFLICT", () => {
		const ctx = setup();
		const legacyState = makeInitialState();
		const first = migrateLegacyRunAtomic({
			db: ctx.runDb.connection,
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
		assert.strictEqual(first.kind, "MIGRATED");
		if (first.kind !== "MIGRATED") return;
		// Don't release — ownership HELD.
		// Second migration — should detect active conflict.
		const second = migrateLegacyRunAtomic({
			db: ctx.runDb.connection,
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
		assert.strictEqual(second.kind, "ACTIVE_CONFLICT");
		releaseOwnership({ db: ctx.runDb.connection, handle: first.handle });
		ctx.cleanup();
	});
});
// ---------------------------------------------------------------------------
// Old implementation partial DB handling
// ---------------------------------------------------------------------------
describe("old implementation partial DB handling", () => {
	test("N — incarnation+ownership present, state absent, no state.json → INCOMPLETE_BOOTSTRAP", () => {
		const ctx = setup();
		// Manually create the old-implementation artifact:
		// incarnation + HELD ownership, no state row.
		ctx.runDb.connection.exec("BEGIN IMMEDIATE");
		ctx.runDb.connection.exec(`INSERT INTO run_incarnation (singleton, run_id, incarnation_id, orchestrator_name, created_at_epoch_ms, created_at_iso)
			 VALUES (1, '${RUN_ID}', 'old-inc', '${ORCH_NAME}', ${NOW_EPOCH}, '${NOW_ISO}')`);
		ctx.runDb.connection.exec(`INSERT INTO run_ownership (singleton, incarnation_id, ownership_status, owner_token, owner_pid, fence_token, acquired_at_epoch_ms, lease_until_epoch_ms)
			 VALUES (1, 'old-inc', 'HELD', 'old-token', 99999, 1, ${NOW_EPOCH}, ${NOW_EPOCH + LEASE_MS})`);
		ctx.runDb.connection.exec("COMMIT");
		// Verify state absent.
		const stateCnt = ctx.runDb.connection
			.prepare("SELECT COUNT(*) AS cnt FROM run_state")
			.get() as {
			cnt: number;
		};
		assert.strictEqual(stateCnt.cnt, 0);
		// Bootstrap should fail-closed.
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
		assert.strictEqual(result.kind, "INCOMPLETE_EXISTING_BOOTSTRAP");
		if (result.kind === "INCOMPLETE_EXISTING_BOOTSTRAP") {
			assert.ok(result.details.includes("INCOMPLETE_BOOTSTRAP"));
			assert.ok(result.details.includes("recovery forbidden"));
		}
		// Verify no state was created, ownership unchanged.
		const stateCntAfter = ctx.runDb.connection
			.prepare("SELECT COUNT(*) AS cnt FROM run_state")
			.get() as {
			cnt: number;
		};
		assert.strictEqual(stateCntAfter.cnt, 0);
		const ownRow = ctx.runDb.connection
			.prepare(
				"SELECT fence_token, ownership_status FROM run_ownership WHERE singleton = 1",
			)
			.get() as {
			fence_token: number | bigint;
			ownership_status: string;
		};
		assert.strictEqual(ownRow.ownership_status, "HELD");
		const fence =
			typeof ownRow.fence_token === "bigint"
				? ownRow.fence_token
				: BigInt(ownRow.fence_token);
		assert.strictEqual(fence, 1n); // Not reset.
		ctx.cleanup();
	});
	test("O — schema-only DB with no state.json: bootstrap succeeds", () => {
		const ctx = setup();
		// Schema-only: close and reopen.
		ctx.runDb.close();
		const reopened = openRunDatabase({
			driver: nodeSqliteDriver,
			dbPath: ctx.dbPath,
			busyTimeoutMs: 500,
		});
		try {
			assertTablesEmpty(reopened);
			const result = bootstrapNewRunAtomic({
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
			assert.strictEqual(result.kind, "BOOTSTRAPPED");
			if (result.kind !== "BOOTSTRAPPED") return;
			releaseOwnership({
				db: reopened.connection,
				handle: result.handle,
			});
		} finally {
			reopened.close();
			ctx.cleanup();
		}
	});
});
// ---------------------------------------------------------------------------
// State consistency checks
// ---------------------------------------------------------------------------
describe("state consistency", () => {
	test("P — revision starts at 0", () => {
		const ctx = setup();
		try {
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
			assert.strictEqual(result.kind, "BOOTSTRAPPED");
			if (result.kind !== "BOOTSTRAPPED") return;
			assert.strictEqual(result.committed.stateRevision, "0");
			releaseOwnership({
				db: ctx.runDb.connection,
				handle: result.handle,
			});
		} finally {
			ctx.cleanup();
		}
	});
	test("Q — fenceToken starts at 1 for fresh bootstrap", () => {
		const ctx = setup();
		try {
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
			assert.strictEqual(result.kind, "BOOTSTRAPPED");
			if (result.kind !== "BOOTSTRAPPED") return;
			assert.strictEqual(result.handle.fenceToken, 1n);
			assert.strictEqual(result.committed.committedFenceToken, "1");
			releaseOwnership({
				db: ctx.runDb.connection,
				handle: result.handle,
			});
		} finally {
			ctx.cleanup();
		}
	});
	test("R — committed_by_owner_token matches handle.ownerToken", () => {
		const ctx = setup();
		try {
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
			assert.strictEqual(result.kind, "BOOTSTRAPPED");
			if (result.kind !== "BOOTSTRAPPED") return;
			const stateRow = ctx.runDb.connection
				.prepare(
					"SELECT committed_by_owner_token, committed_by_fence_token FROM run_state WHERE singleton = 1",
				)
				.get() as {
				committed_by_owner_token: string;
				committed_by_fence_token: number | bigint;
			};
			assert.strictEqual(
				stateRow.committed_by_owner_token,
				result.handle.ownerToken,
			);
			const fence =
				typeof stateRow.committed_by_fence_token === "bigint"
					? stateRow.committed_by_fence_token
					: BigInt(stateRow.committed_by_fence_token);
			assert.strictEqual(fence, result.handle.fenceToken);
			releaseOwnership({
				db: ctx.runDb.connection,
				handle: result.handle,
			});
		} finally {
			ctx.cleanup();
		}
	});
});
// ---------------------------------------------------------------------------
// Incarnation identity tests (TL-F-001 — Option B)
// ---------------------------------------------------------------------------
describe("incarnation identity", () => {
	// -----------------------------------------------------------------------
	// Test S — migration creates an incarnation distinct from runId
	// -----------------------------------------------------------------------
	test("S — migration creates incarnation distinct from runId", () => {
		const ctx = setup();
		const legacyState = makeInitialState({ currentPhase: "test-s" });
		const result = migrateLegacyRunAtomic({
			db: ctx.runDb.connection,
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
		assert.strictEqual(result.kind, "MIGRATED");
		if (result.kind !== "MIGRATED") return;
		// The incarnation must be a new Turnlock-generated identity,
		// not the legacy runId.
		assert.notStrictEqual(result.handle.incarnationId, RUN_ID);
		releaseOwnership({ db: ctx.runDb.connection, handle: result.handle });
		ctx.cleanup();
	});
	// -----------------------------------------------------------------------
	// Test T — three-table coherence after migration
	// -----------------------------------------------------------------------
	test("T — three-table coherence after migration", () => {
		const ctx = setup();
		const legacyState = makeInitialState({ currentPhase: "test-t" });
		const result = migrateLegacyRunAtomic({
			db: ctx.runDb.connection,
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
		assert.strictEqual(result.kind, "MIGRATED");
		if (result.kind !== "MIGRATED") return;
		const handle = result.handle;
		// run_incarnation
		const incRow = ctx.runDb.connection
			.prepare(
				"SELECT run_id, incarnation_id FROM run_incarnation WHERE singleton = 1",
			)
			.get() as {
			run_id: string;
			incarnation_id: string;
		};
		assert.strictEqual(incRow.run_id, RUN_ID);
		assert.strictEqual(incRow.incarnation_id, handle.incarnationId);
		// run_ownership
		const ownRow = ctx.runDb.connection
			.prepare("SELECT incarnation_id FROM run_ownership WHERE singleton = 1")
			.get() as {
			incarnation_id: string;
		};
		assert.strictEqual(ownRow.incarnation_id, handle.incarnationId);
		// run_state
		const stateRow = ctx.runDb.connection
			.prepare("SELECT incarnation_id FROM run_state WHERE singleton = 1")
			.get() as {
			incarnation_id: string;
		};
		assert.strictEqual(stateRow.incarnation_id, handle.incarnationId);
		releaseOwnership({ db: ctx.runDb.connection, handle });
		ctx.cleanup();
	});
	// -----------------------------------------------------------------------
	// Test U — committed state returns the same incarnation as handle
	// -----------------------------------------------------------------------
	test("U — committed state incarnation matches handle", () => {
		const ctx = setup();
		const legacyState = makeInitialState({ currentPhase: "test-u" });
		const result = migrateLegacyRunAtomic({
			db: ctx.runDb.connection,
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
		assert.strictEqual(result.kind, "MIGRATED");
		if (result.kind !== "MIGRATED") return;
		// committed.incarnationId must equal handle.incarnationId.
		assert.strictEqual(
			result.committed.incarnationId,
			result.handle.incarnationId,
		);
		// committed.state.runIncarnationId must also match.
		assert.strictEqual(
			result.committed.state.runIncarnationId,
			result.handle.incarnationId,
		);
		releaseOwnership({ db: ctx.runDb.connection, handle: result.handle });
		ctx.cleanup();
	});
	// -----------------------------------------------------------------------
	// Test V — two independent migrations of the same runId produce different
	//          incarnations (same logical identity ≠ same physical incarnation)
	// -----------------------------------------------------------------------
	test("V — two independent migrations produce distinct incarnations", () => {
		const ctx1 = setup();
		const ctx2 = setup();
		try {
			const legacyState = makeInitialState({ currentPhase: "test-v" });
			const first = migrateLegacyRunAtomic({
				db: ctx1.runDb.connection,
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
			assert.strictEqual(first.kind, "MIGRATED");
			if (first.kind !== "MIGRATED") return;
			const second = migrateLegacyRunAtomic({
				db: ctx2.runDb.connection,
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
			assert.strictEqual(second.kind, "MIGRATED");
			if (second.kind !== "MIGRATED") return;
			// Same logical runId, but distinct physical incarnations.
			assert.notStrictEqual(
				first.handle.incarnationId,
				second.handle.incarnationId,
			);
			releaseOwnership({
				db: ctx1.runDb.connection,
				handle: first.handle,
			});
			releaseOwnership({
				db: ctx2.runDb.connection,
				handle: second.handle,
			});
		} finally {
			ctx1.cleanup();
			ctx2.cleanup();
		}
	});
	// -----------------------------------------------------------------------
	// Test W — existing incarnation preserved during recovery
	// -----------------------------------------------------------------------
	test("W — existing incarnation preserved during migration recovery", () => {
		const ctx = setup();
		// Pre-establish an incarnation via acquireOwnership.
		const acq = acquireOwnership({
			db: ctx.runDb.connection,
			runId: RUN_ID,
			orchestratorName: ORCH_NAME,
			nowEpochMs: NOW_EPOCH,
			nowIso: NOW_ISO,
			leaseDurationMs: LEASE_MS,
			contentionDeadlineMs: CONTENTION_DEADLINE_MS,
			leaseClockEpochMs: () => NOW_EPOCH,
		});
		assert.strictEqual(acq.kind, "ACQUIRED");
		if (acq.kind !== "ACQUIRED") return;
		const preExistingIncarnation = acq.handle.incarnationId;
		// Release to FREE the ownership.
		releaseOwnership({ db: ctx.runDb.connection, handle: acq.handle });
		// Verify state absent — partial DB (incarnation + FREE ownership).
		const stateCnt = ctx.runDb.connection
			.prepare("SELECT COUNT(*) AS cnt FROM run_state")
			.get() as {
			cnt: number;
		};
		assert.strictEqual(stateCnt.cnt, 0);
		// Migrate — this must reuse the existing incarnation.
		const legacyState = makeInitialState({ currentPhase: "test-w" });
		const result = migrateLegacyRunAtomic({
			db: ctx.runDb.connection,
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
		assert.strictEqual(result.kind, "MIGRATED");
		if (result.kind !== "MIGRATED") return;
		// The handle must reflect the persisted incarnation, not a new one.
		assert.strictEqual(result.handle.incarnationId, preExistingIncarnation);
		// Verify the row itself.
		const incRow = ctx.runDb.connection
			.prepare("SELECT incarnation_id FROM run_incarnation WHERE singleton = 1")
			.get() as {
			incarnation_id: string;
		};
		assert.strictEqual(incRow.incarnation_id, preExistingIncarnation);
		releaseOwnership({ db: ctx.runDb.connection, handle: result.handle });
		ctx.cleanup();
	});
	// -----------------------------------------------------------------------
	// Test X — candidate is stable across a real SQLITE_BUSY retry
	// -----------------------------------------------------------------------
	//
	// A second connection holds a write transaction.  The first
	// BEGIN IMMEDIATE fails with SQLITE_BUSY.  We intercept db.exec
	// to release the blocker on the *second* call to BEGIN IMMEDIATE,
	// so the retry loop inside migrateLegacyRunAtomic succeeds on
	// attempt 2.  A deterministic idGenerator proves exactly 2 calls
	// (ownerToken + incarnationCandidate) regardless of retries.
	test("X — incarnation candidate stable across real SQLITE_BUSY retry", () => {
		const ctx = setup();
		let counter = 0;
		const idGenerator = (): string => {
			counter++;
			return `test-inc-${String(counter).padStart(4, "0")}`;
		};
		// Open a second connection to the same DB file to hold a
		// write transaction, forcing SQLITE_BUSY on the first
		// BEGIN IMMEDIATE of the main connection.
		const blockerDb = nodeSqliteDriver.open(ctx.dbPath);
		// Close and reopen the main connection with busy_timeout=0
		// so BEGIN IMMEDIATE fails INSTANTLY when the blocker holds
		// the write lock.
		ctx.runDb.close();
		const reopened = openRunDatabase({
			driver: nodeSqliteDriver,
			dbPath: ctx.dbPath,
			busyTimeoutMs: 0,
		});
		// Intercept db.exec: on the second BEGIN IMMEDIATE call,
		// release the blocker first so the retry succeeds.
		let beginAttempts = 0;
		const originalExec = reopened.connection.exec.bind(reopened.connection);
		reopened.connection.exec = (sql: string) => {
			if (sql === "BEGIN IMMEDIATE") {
				beginAttempts++;
				if (beginAttempts >= 2) {
					// Release the blocker before the retry attempt.
					blockerDb.exec("ROLLBACK");
				}
			}
			return originalExec(sql);
		};
		try {
			// Hold a write transaction on the blocker connection.
			blockerDb.exec("BEGIN IMMEDIATE");
			const legacyState = makeInitialState({ currentPhase: "test-x" });
			const result = migrateLegacyRunAtomicCore(
				{
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
				},
				{ generateId: idGenerator },
			);
			// Must have succeeded after the retry.
			assert.strictEqual(result.kind, "MIGRATED");
			if (result.kind !== "MIGRATED") {
				reopened.close();
				blockerDb.close();
				ctx.cleanup();
				return;
			}
			// First BEGIN IMMEDIATE failed with SQLITE_BUSY.
			assert.ok(beginAttempts >= 2);
			// Proof: the generator was called exactly twice — once for
			// ownerToken, once for incarnationCandidate.  If it were
			// called per retry, counter would be ≥ 3.
			assert.strictEqual(counter, 2);
			// The incarnation in the handle must equal the incarnation
			// in the DB.
			const incRow = reopened.connection
				.prepare(
					"SELECT incarnation_id FROM run_incarnation WHERE singleton = 1",
				)
				.get() as {
				incarnation_id: string;
			};
			assert.strictEqual(result.handle.incarnationId, incRow.incarnation_id);
			// The incarnation is the deterministic candidate, not runId.
			assert.strictEqual(result.handle.incarnationId, "test-inc-0002");
			assert.notStrictEqual(result.handle.incarnationId, RUN_ID);
			releaseOwnership({
				db: reopened.connection,
				handle: result.handle,
			});
		} finally {
			try {
				blockerDb.exec("ROLLBACK");
			} catch {
				/* already released */
			}
			reopened.close();
			blockerDb.close();
			ctx.cleanup();
		}
	});
});
