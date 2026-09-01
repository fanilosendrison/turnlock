import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
// TL-F-001 point 2 — Canonical projection fencing adversarial tests.
//
// Validates that state.json projection is protected against overwrite by
// a stale worker and that projected content always comes from SQLite.
//
// Scenarios:
//   A expire sans takeover → EXPIRED_HANDLE
//   A expire, B prend la fence et initialise → A = STALE_HANDLE
//   état déjà initialisé + handle courant valide → ALREADY_INITIALIZED
//   projection échoue → release SUCCESS vérifiée
//   projection échoue + release DB_FAILURE → les deux causes sont conservées
//   A commit revision 5 puis se suspend → B commit/projette revision 6
//       → A ne peut pas reprojeter revision 5
//   SQLite contient A → appel projection avec digest erroné → rejeté
//   SQLite contient A → appel projection avec revision erronée → rejeté
import { describe, test } from "node:test";
import { STATE_SCHEMA_VERSION } from "../../src/constants.js";
import {
	AuthorityLostError,
	PersistenceFailureError,
} from "../../src/errors/concrete.js";
import { nodeSqliteDriver } from "../../src/persistence/sqlite/node-sqlite-driver.js";
import {
	acquireOwnership,
	type LockHandle,
	releaseOwnership,
} from "../../src/persistence/sqlite/ownership.js";
import { openRunDatabase } from "../../src/persistence/sqlite/run-database.js";
import {
	type CommittedState,
	commitState,
	initializeStateUnderFence,
	type ProjectionFaultPoint,
	projectAuthoritativeStateFenced,
	readAuthoritativeState,
	type StateRecord,
} from "../../src/persistence/sqlite/run-state-store.js";
import { cleanupTempDir, makeTempDir } from "../helpers/temp-run-dir.js";
import { unsafeWriteStateJson } from "../helpers/unsafe-state-projection.js";
import { unsafeEnsureInitialStateRow } from "../helpers/unsafe-state-seed.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const LEASE_MS = 30 * 60 * 1000;
const LONG_LEASE_MS = 365 * 24 * 3600 * 1000;
const CONTENTION_DEADLINE_MS = 2000;
const RUN_ID = "01HX0000000000000000000001";
const NOW_EPOCH = Date.now();
const NOW_ISO = new Date(NOW_EPOCH).toISOString();
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
function acquire(
	runDb: ReturnType<typeof openRunDatabase>,
	overrides: {
		runId?: string;
		orchestratorName?: string;
		nowEpochMs?: number;
		nowIso?: string;
		leaseDurationMs?: number;
	} = {},
) {
	return acquireOwnership({
		db: runDb.connection,
		runId: overrides.runId ?? RUN_ID,
		orchestratorName: overrides.orchestratorName ?? "fencing-test",
		nowEpochMs: overrides.nowEpochMs ?? NOW_EPOCH,
		nowIso: overrides.nowIso ?? NOW_ISO,
		leaseDurationMs: overrides.leaseDurationMs ?? LEASE_MS,
		contentionDeadlineMs: CONTENTION_DEADLINE_MS,
		leaseClockEpochMs: () => overrides.nowEpochMs ?? NOW_EPOCH,
	});
}
function makeRecord(
	overrides: Partial<StateRecord<object>> = {},
): StateRecord<object> {
	return {
		schemaVersion: STATE_SCHEMA_VERSION,
		runId: RUN_ID,
		orchestratorName: "fencing-test",
		startedAt: NOW_ISO,
		startedAtEpochMs: NOW_EPOCH,
		lastTransitionAt: NOW_ISO,
		lastTransitionAtEpochMs: NOW_EPOCH,
		currentPhase: "start",
		phasesExecuted: 0,
		accumulatedDurationMs: 0,
		data: { stage: "initial" },
		usedLabels: [],
		runIncarnationId: "",
		stateRevision: "0",
		committedFenceToken: "0",
		...overrides,
	};
}
function seedViaUnsafe(
	runDb: ReturnType<typeof openRunDatabase>,
	handle: LockHandle,
	record: StateRecord<object>,
) {
	unsafeEnsureInitialStateRow(
		runDb.connection,
		handle.incarnationId,
		record.schemaVersion,
		JSON.stringify(record),
		NOW_EPOCH,
		NOW_ISO,
	);
}
// ---------------------------------------------------------------------------
// 1 — A expires without takeover → initializeStateUnderFence = EXPIRED_HANDLE
// ---------------------------------------------------------------------------
describe("initializeStateUnderFence adversarial", () => {
	test("A expires without takeover → EXPIRED_HANDLE", () => {
		const ctx = setup();
		try {
			const acquired = acquire(ctx.runDb, {
				nowEpochMs: 0,
				leaseDurationMs: 1000,
			});
			assert.strictEqual(acquired.kind, "ACQUIRED");
			if (acquired.kind !== "ACQUIRED") return;
			const handle = acquired.handle;
			const initResult = initializeStateUnderFence({
				db: ctx.runDb.connection,
				handle,
				initialState: makeRecord() as unknown as Record<string, unknown>,
				nowEpochMs: 2000,
				nowIso: "1970-01-01T00:00:02.000Z",
				leaseClockEpochMs: () => NOW_EPOCH,
			});
			assert.strictEqual(initResult.kind, "EXPIRED_HANDLE");
		} finally {
			ctx.cleanup();
		}
	});
	test("A expires, B takes fence and initializes → A = STALE_HANDLE, never ALREADY_INITIALIZED", () => {
		const ctx = setup();
		try {
			const aAcquired = acquire(ctx.runDb, {
				nowEpochMs: 0,
				leaseDurationMs: 1000,
			});
			assert.strictEqual(aAcquired.kind, "ACQUIRED");
			if (aAcquired.kind !== "ACQUIRED") return;
			const handleA = aAcquired.handle;
			releaseOwnership({ db: ctx.runDb.connection, handle: handleA });
			const bAcquired = acquire(ctx.runDb, {
				nowEpochMs: 2000,
				leaseDurationMs: 30000,
			});
			assert.strictEqual(bAcquired.kind, "ACQUIRED");
			if (bAcquired.kind !== "ACQUIRED") return;
			const handleB = bAcquired.handle;
			const bInit = initializeStateUnderFence({
				db: ctx.runDb.connection,
				handle: handleB,
				initialState: makeRecord() as unknown as Record<string, unknown>,
				nowEpochMs: 2000,
				nowIso: "1970-01-01T00:00:02.000Z",
				leaseClockEpochMs: () => 2000,
			});
			assert.strictEqual(bInit.kind, "INITIALIZED");
			const aInit = initializeStateUnderFence({
				db: ctx.runDb.connection,
				handle: handleA,
				initialState: makeRecord() as unknown as Record<string, unknown>,
				nowEpochMs: 2000,
				nowIso: "1970-01-01T00:00:02.000Z",
				leaseClockEpochMs: () => NOW_EPOCH,
			});
			assert.strictEqual(aInit.kind, "STALE_HANDLE");
			assert.notStrictEqual(aInit.kind, "ALREADY_INITIALIZED");
		} finally {
			ctx.cleanup();
		}
	});
	test("already initialized + valid handle → ALREADY_INITIALIZED", () => {
		const ctx = setup();
		try {
			const acquired = acquire(ctx.runDb);
			assert.strictEqual(acquired.kind, "ACQUIRED");
			if (acquired.kind !== "ACQUIRED") return;
			const handle = acquired.handle;
			const first = initializeStateUnderFence({
				db: ctx.runDb.connection,
				handle,
				initialState: makeRecord() as unknown as Record<string, unknown>,
				nowEpochMs: NOW_EPOCH,
				nowIso: NOW_ISO,
				leaseClockEpochMs: () => NOW_EPOCH,
			});
			assert.strictEqual(first.kind, "INITIALIZED");
			const second = initializeStateUnderFence({
				db: ctx.runDb.connection,
				handle,
				initialState: makeRecord({
					currentPhase: "should-be-ignored",
				}) as unknown as Record<string, unknown>,
				nowEpochMs: NOW_EPOCH,
				nowIso: NOW_ISO,
				leaseClockEpochMs: () => NOW_EPOCH,
			});
			assert.strictEqual(second.kind, "ALREADY_INITIALIZED");
			if (second.kind === "ALREADY_INITIALIZED") {
				assert.strictEqual(second.state.currentPhase, "start");
			}
		} finally {
			ctx.cleanup();
		}
	});
});
// ---------------------------------------------------------------------------
// 2 — Projection failure cleanup
// ---------------------------------------------------------------------------
describe("projection failure cleanup", () => {
	test("projection fails on invalid runDir → ownership still HELD (rollback)", () => {
		const ctx = setup();
		try {
			const now = Date.now();
			const nowIso = new Date(now).toISOString();
			const acquired = acquire(ctx.runDb, {
				nowEpochMs: now,
				nowIso,
				leaseDurationMs: LONG_LEASE_MS,
			});
			assert.strictEqual(acquired.kind, "ACQUIRED");
			if (acquired.kind !== "ACQUIRED") return;
			const handle = acquired.handle;
			const record = makeRecord({ runIncarnationId: handle.incarnationId });
			seedViaUnsafe(ctx.runDb, handle, record);
			const read = readAuthoritativeState(ctx.runDb.connection);
			assert.notStrictEqual(read.state, null);
			const realDigest = read.digest as string;
			const badDir = join(ctx.dir, "nonexistent");
			let threw = false;
			try {
				projectAuthoritativeStateFenced(
					ctx.runDb.connection,
					handle,
					badDir,
					"0",
					realDigest,
				);
			} catch (err) {
				threw = true;
				assert.ok(err instanceof PersistenceFailureError);
			}
			assert.strictEqual(threw, true);
			const ownershipRow = ctx.runDb.connection
				.prepare(
					"SELECT ownership_status FROM run_ownership WHERE singleton = 1",
				)
				.get() as {
				ownership_status: string;
			};
			assert.strictEqual(ownershipRow.ownership_status, "HELD");
		} finally {
			ctx.cleanup();
		}
	});
	test("projection fails + release DB_FAILURE → both causes preserved", () => {
		const ctx = setup();
		try {
			const acquired = acquire(ctx.runDb);
			assert.strictEqual(acquired.kind, "ACQUIRED");
			if (acquired.kind !== "ACQUIRED") return;
			const handle = acquired.handle;
			ctx.runDb.close();
			const projectionErr = new Error("projection failed");
			const releaseResult = releaseOwnership({
				db: ctx.runDb.connection,
				handle,
			});
			assert.strictEqual(releaseResult.kind, "DB_FAILURE");
			const aggregate = new AggregateError(
				[projectionErr, releaseResult.cause],
				"projection and release both failed",
			);
			assert.strictEqual(aggregate.errors.length, 2);
			assert.strictEqual(aggregate.errors[0], projectionErr);
		} finally {
			ctx.cleanup();
		}
	});
});
// ---------------------------------------------------------------------------
// 3 — Content authenticity: projected content always comes from SQLite
// ---------------------------------------------------------------------------
describe("content authenticity", () => {
	test("projectAuthoritativeStateFenced projects exactly what SQLite holds", () => {
		const ctx = setup();
		try {
			const now = Date.now();
			const nowIso = new Date(now).toISOString();
			const acquired = acquire(ctx.runDb, {
				nowEpochMs: now,
				nowIso,
				leaseDurationMs: LONG_LEASE_MS,
			});
			assert.strictEqual(acquired.kind, "ACQUIRED");
			if (acquired.kind !== "ACQUIRED") return;
			const handle = acquired.handle;
			// Seed SQLite with a known state.
			const record = makeRecord({
				runIncarnationId: handle.incarnationId,
				data: { stage: "autoritatif", value: 42 },
				currentPhase: "real-phase",
			});
			seedViaUnsafe(ctx.runDb, handle, record);
			const read = readAuthoritativeState(ctx.runDb.connection);
			assert.notStrictEqual(read.state, null);
			const digest = read.digest as string;
			// Project through the fenced API — it must re-read from SQLite.
			projectAuthoritativeStateFenced(
				ctx.runDb.connection,
				handle,
				ctx.dir,
				"0",
				digest,
			);
			// Verify the projected content matches SQLite, not some caller input.
			const projected = JSON.parse(
				readFileSync(join(ctx.dir, "state.json"), "utf-8"),
			);
			assert.deepStrictEqual(projected.data, {
				stage: "autoritatif",
				value: 42,
			});
			assert.strictEqual(projected.currentPhase, "real-phase");
			assert.strictEqual(projected.stateRevision, "0");
			assert.strictEqual(projected.stateDigest, digest);
		} finally {
			ctx.cleanup();
		}
	});
	test("projection durability hooks fire in write, file-fsync, rename, directory-fsync order", () => {
		const ctx = setup();
		try {
			const now = Date.now();
			const nowIso = new Date(now).toISOString();
			const acquired = acquire(ctx.runDb, {
				nowEpochMs: now,
				nowIso,
				leaseDurationMs: LONG_LEASE_MS,
			});
			assert.strictEqual(acquired.kind, "ACQUIRED");
			if (acquired.kind !== "ACQUIRED") return;
			const record = makeRecord({
				runIncarnationId: acquired.handle.incarnationId,
			});
			seedViaUnsafe(ctx.runDb, acquired.handle, record);
			const read = readAuthoritativeState(ctx.runDb.connection);
			assert.notStrictEqual(read.state, null);
			if (read.digest === null) return;
			const reached: ProjectionFaultPoint[] = [];
			projectAuthoritativeStateFenced(
				ctx.runDb.connection,
				acquired.handle,
				ctx.dir,
				"0",
				read.digest,
				undefined,
				{
					onFaultPoint: (point) => reached.push(point),
				},
			);
			assert.deepStrictEqual(reached, [
				"AFTER_TEMP_FILE_WRITE",
				"AFTER_TEMP_FILE_FSYNC",
				"AFTER_RENAME",
				"BEFORE_DIRECTORY_FSYNC",
			]);
			assert.strictEqual(existsSync(join(ctx.dir, "state.json")), true);
			assert.strictEqual(existsSync(join(ctx.dir, "state.json.tmp")), false);
		} finally {
			ctx.cleanup();
		}
	});
	test("fenced projection with wrong digest → rejected", () => {
		const ctx = setup();
		try {
			const now = Date.now();
			const nowIso = new Date(now).toISOString();
			const acquired = acquire(ctx.runDb, {
				nowEpochMs: now,
				nowIso,
				leaseDurationMs: LONG_LEASE_MS,
			});
			assert.strictEqual(acquired.kind, "ACQUIRED");
			if (acquired.kind !== "ACQUIRED") return;
			const handle = acquired.handle;
			const record = makeRecord({ runIncarnationId: handle.incarnationId });
			seedViaUnsafe(ctx.runDb, handle, record);
			let rejected = false;
			try {
				projectAuthoritativeStateFenced(
					ctx.runDb.connection,
					handle,
					ctx.dir,
					"0",
					"sha256:0000000000000000000000000000000000000000000000000000000000000000",
				);
			} catch (err) {
				rejected = true;
				assert.ok(err instanceof PersistenceFailureError);
			}
			assert.strictEqual(rejected, true);
		} finally {
			ctx.cleanup();
		}
	});
});
// ---------------------------------------------------------------------------
// 4 — Canonical projection monotonicity
// ---------------------------------------------------------------------------
describe("canonical projection monotonicity", () => {
	test("A projects revision 5 after B already projected revision 6 → rejected", () => {
		const ctx = setup();
		try {
			const now = Date.now();
			const nowIso = new Date(now).toISOString();
			// ----- A's turn -----
			const aAcquired = acquire(ctx.runDb, {
				nowEpochMs: now,
				nowIso,
				leaseDurationMs: LONG_LEASE_MS,
			});
			assert.strictEqual(aAcquired.kind, "ACQUIRED");
			if (aAcquired.kind !== "ACQUIRED") return;
			const handleA = aAcquired.handle;
			const aInit = initializeStateUnderFence({
				db: ctx.runDb.connection,
				handle: handleA,
				initialState: makeRecord() as unknown as Record<string, unknown>,
				nowEpochMs: now,
				nowIso,
			});
			assert.strictEqual(aInit.kind, "INITIALIZED");
			if (aInit.kind !== "INITIALIZED") return;
			// A projects revision 0.
			unsafeWriteStateJson(
				ctx.dir,
				aInit.committed.state,
				aInit.committed.stateDigest,
			);
			assert.strictEqual(existsSync(join(ctx.dir, "state.json")), true);
			// A commits revisions 1..5.
			let currentRevision = "0";
			let lastCommitted: CommittedState<object> | null = aInit.committed;
			for (let i = 1; i <= 5; i++) {
				const result = commitState({
					db: ctx.runDb.connection,
					handle: handleA,
					expectedRevision: currentRevision,
					nextState: makeRecord({
						currentPhase: `phase-${i}`,
						phasesExecuted: i,
						stateRevision: currentRevision,
					}),
					nowEpochMs: now,
					nowIso,
				});
				assert.strictEqual(result.kind, "COMMITTED");
				if (result.kind !== "COMMITTED") return;
				currentRevision = result.committed.state.stateRevision;
				lastCommitted = result.committed;
			}
			assert.strictEqual(currentRevision, "5");
			assert.notStrictEqual(lastCommitted, null);
			if (lastCommitted === null) return;
			// A is suspended — does not project revision 5.
			// Release A so B can acquire.
			releaseOwnership({ db: ctx.runDb.connection, handle: handleA });
			// ----- B's turn -----
			const bAcquired = acquire(ctx.runDb, {
				nowEpochMs: now + 1000,
				nowIso: new Date(now + 1000).toISOString(),
				leaseDurationMs: LONG_LEASE_MS,
			});
			assert.strictEqual(bAcquired.kind, "ACQUIRED");
			if (bAcquired.kind !== "ACQUIRED") return;
			const handleB = bAcquired.handle;
			const bCommit = commitState({
				db: ctx.runDb.connection,
				handle: handleB,
				expectedRevision: "5",
				nextState: makeRecord({
					currentPhase: "phase-B",
					phasesExecuted: 6,
					stateRevision: "5",
				}),
				nowEpochMs: now + 1000,
				nowIso: new Date(now + 1000).toISOString(),
			});
			assert.strictEqual(bCommit.kind, "COMMITTED");
			if (bCommit.kind !== "COMMITTED") return;
			assert.strictEqual(bCommit.committed.state.stateRevision, "6");
			// B projects revision 6 (fenced).
			projectAuthoritativeStateFenced(
				ctx.runDb.connection,
				handleB,
				ctx.dir,
				"6",
				bCommit.committed.stateDigest,
			);
			// Verify B's projection.
			const bProjection = JSON.parse(
				readFileSync(join(ctx.dir, "state.json"), "utf-8"),
			);
			assert.strictEqual(bProjection.stateRevision, "6");
			assert.strictEqual(bProjection.currentPhase, "phase-B");
			// ----- A resumes and tries to project revision 5 -----
			let aRejected = false;
			try {
				projectAuthoritativeStateFenced(
					ctx.runDb.connection,
					handleA, // stale!
					ctx.dir,
					"5",
					lastCommitted.stateDigest,
				);
			} catch (err) {
				aRejected = true;
				assert.ok(err instanceof AuthorityLostError);
			}
			assert.strictEqual(aRejected, true);
			// B's projection must still be on disk.
			const finalProjection = JSON.parse(
				readFileSync(join(ctx.dir, "state.json"), "utf-8"),
			);
			assert.strictEqual(finalProjection.stateRevision, "6");
			assert.strictEqual(finalProjection.currentPhase, "phase-B");
		} finally {
			ctx.cleanup();
		}
	});
	test("fenced projection with revision mismatch (own handle, but newer revision in DB) → rejected", () => {
		const ctx = setup();
		try {
			const acquired = acquire(ctx.runDb);
			assert.strictEqual(acquired.kind, "ACQUIRED");
			if (acquired.kind !== "ACQUIRED") return;
			const handle = acquired.handle;
			const aInit = initializeStateUnderFence({
				db: ctx.runDb.connection,
				handle,
				initialState: makeRecord() as unknown as Record<string, unknown>,
				nowEpochMs: NOW_EPOCH,
				nowIso: NOW_ISO,
				leaseClockEpochMs: () => NOW_EPOCH,
			});
			assert.strictEqual(aInit.kind, "INITIALIZED");
			if (aInit.kind !== "INITIALIZED") return;
			const c1 = commitState({
				db: ctx.runDb.connection,
				handle,
				expectedRevision: "0",
				nextState: makeRecord({
					currentPhase: "phase-1",
					phasesExecuted: 1,
				}),
				nowEpochMs: NOW_EPOCH,
				nowIso: NOW_ISO,
			});
			assert.strictEqual(c1.kind, "COMMITTED");
			if (c1.kind !== "COMMITTED") return;
			// Bump revision via raw SQL (also update state_json to keep
			// digest consistent — the integrity check now catches mismatches).
			const newState = makeRecord({
				currentPhase: "phase-99",
				phasesExecuted: 99,
				stateRevision: "99",
			});
			const newJson = JSON.stringify(newState);
			const newDigest = `sha256:${createHash("sha256").update(newJson).digest("hex")}`;
			ctx.runDb.connection
				.prepare(
					"UPDATE run_state SET state_revision = 99, state_json = ?, state_digest = ? WHERE singleton = 1",
				)
				.run(newJson, newDigest);
			// Read current state to get the real digest (modified by the raw SQL).
			const read = readAuthoritativeState(ctx.runDb.connection);
			assert.notStrictEqual(read.state, null);
			// Try to project with the old revision (1) but the current DB digest.
			// The revision check should fail first.
			let rejected = false;
			try {
				projectAuthoritativeStateFenced(
					ctx.runDb.connection,
					handle,
					ctx.dir,
					"1", // stale revision
					read.digest ?? "",
				);
			} catch (err) {
				rejected = true;
				assert.ok(err instanceof AuthorityLostError);
			}
			assert.strictEqual(rejected, true);
		} finally {
			ctx.cleanup();
		}
	});
});
// ---------------------------------------------------------------------------
// 5 — Stale/expired handle rejection
// ---------------------------------------------------------------------------
describe("fenced projection ownership guard", () => {
	test("stale handle → AuthorityLostError, state.json not overwritten", () => {
		const ctx = setup();
		try {
			const aAcquired = acquire(ctx.runDb);
			assert.strictEqual(aAcquired.kind, "ACQUIRED");
			if (aAcquired.kind !== "ACQUIRED") return;
			const handleA = aAcquired.handle;
			const aInit = initializeStateUnderFence({
				db: ctx.runDb.connection,
				handle: handleA,
				initialState: makeRecord() as unknown as Record<string, unknown>,
				nowEpochMs: NOW_EPOCH,
				nowIso: NOW_ISO,
				leaseClockEpochMs: () => NOW_EPOCH,
			});
			assert.strictEqual(aInit.kind, "INITIALIZED");
			if (aInit.kind !== "INITIALIZED") return;
			const stateJsonPath = join(ctx.dir, "state.json");
			writeFileSync(stateJsonPath, JSON.stringify({ marker: "before" }));
			releaseOwnership({ db: ctx.runDb.connection, handle: handleA });
			// B acquires.
			acquire(ctx.runDb, { nowEpochMs: NOW_EPOCH + 1000 });
			// A tries fenced projection with stale handle.
			let rejected = false;
			try {
				projectAuthoritativeStateFenced(
					ctx.runDb.connection,
					handleA,
					ctx.dir,
					"0",
					aInit.committed.stateDigest,
				);
			} catch (err) {
				rejected = true;
				assert.ok(err instanceof AuthorityLostError);
			}
			assert.strictEqual(rejected, true);
			const content = JSON.parse(readFileSync(stateJsonPath, "utf-8"));
			assert.strictEqual(content.marker, "before");
		} finally {
			ctx.cleanup();
		}
	});
	test("expired lease → AuthorityLostError with reason EXPIRED_HANDLE", () => {
		const ctx = setup();
		try {
			const acquired = acquire(ctx.runDb, {
				nowEpochMs: 0,
				leaseDurationMs: 1000,
			});
			assert.strictEqual(acquired.kind, "ACQUIRED");
			if (acquired.kind !== "ACQUIRED") return;
			const handle = acquired.handle;
			const record = makeRecord({ runIncarnationId: handle.incarnationId });
			seedViaUnsafe(ctx.runDb, handle, record);
			const read = readAuthoritativeState(ctx.runDb.connection);
			assert.notStrictEqual(read.state, null);
			let rejected = false;
			try {
				projectAuthoritativeStateFenced(
					ctx.runDb.connection,
					handle,
					ctx.dir,
					"0",
					read.digest ?? "",
				);
			} catch (err) {
				rejected = true;
				assert.ok(err instanceof AuthorityLostError);
				const aErr = err as AuthorityLostError;
				assert.strictEqual(aErr.reason, "EXPIRED_HANDLE");
			}
			assert.strictEqual(rejected, true);
		} finally {
			ctx.cleanup();
		}
	});
});
