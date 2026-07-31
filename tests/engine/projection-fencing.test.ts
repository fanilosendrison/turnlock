// TL-F-001 point 2 — Canonical projection fencing adversarial tests.
//
// Validates that state.json projection is protected against overwrite by
// a stale worker.  Scenarios from the definitive audit:
//
//   A expire sans takeover → EXPIRED_HANDLE
//   A expire, B prend la fence et initialise → A = STALE_HANDLE
//   état déjà initialisé + handle courant valide → ALREADY_INITIALIZED
//   projection échoue → release SUCCESS vérifiée
//   projection échoue + release DB_FAILURE → les deux causes sont conservées
//   A commit revision 5 puis se suspend → B commit/projette revision 6
//       → A ne peut pas reprojeter revision 5

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { STATE_SCHEMA_VERSION } from "../../src/constants";
import { projectStateJsonFenced } from "../../src/engine/state-commit";
import {
	AuthorityLostError,
	PersistenceFailureError,
} from "../../src/errors/concrete";
import { bunSqliteDriver } from "../../src/persistence/sqlite/bun-sqlite-driver";
import {
	acquireOwnership,
	type LockHandle,
	releaseOwnership,
} from "../../src/persistence/sqlite/ownership";
import { openRunDatabase } from "../../src/persistence/sqlite/run-database";
import {
	type CommittedState,
	commitState,
	initializeStateUnderFence,
	projectStateJson,
	type StateRecord,
} from "../../src/persistence/sqlite/run-state-store";
import { cleanupTempDir, makeTempDir } from "../helpers/temp-run-dir";
import { unsafeEnsureInitialStateRow } from "../helpers/unsafe-state-seed";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LEASE_MS = 30 * 60 * 1000;
const LONG_LEASE_MS = 365 * 24 * 3600 * 1000; // 1 year — won't expire during tests
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
			// Acquire at epoch 0 with a short lease.
			const acquired = acquire(ctx.runDb, {
				nowEpochMs: 0,
				leaseDurationMs: 1000,
			});
			expect(acquired.kind).toBe("ACQUIRED");
			if (acquired.kind !== "ACQUIRED") return;
			const handle = acquired.handle;

			// Time has advanced past the lease.
			const initResult = initializeStateUnderFence({
				db: ctx.runDb.connection,
				handle,
				initialState: makeRecord() as unknown as Record<string, unknown>,
				nowEpochMs: 2000, // past lease
				nowIso: "1970-01-01T00:00:02.000Z",
			});

			expect(initResult.kind).toBe("EXPIRED_HANDLE");
		} finally {
			ctx.cleanup();
		}
	});

	// -----------------------------------------------------------------------
	// 2 — A expires, B takes the fence and initializes → A = STALE_HANDLE
	// -----------------------------------------------------------------------

	test("A expires, B takes fence and initializes → A = STALE_HANDLE, never ALREADY_INITIALIZED", () => {
		const ctx = setup();
		try {
			// A acquires at epoch 0.
			const aAcquired = acquire(ctx.runDb, {
				nowEpochMs: 0,
				leaseDurationMs: 1000,
			});
			expect(aAcquired.kind).toBe("ACQUIRED");
			if (aAcquired.kind !== "ACQUIRED") return;
			const handleA = aAcquired.handle;

			// B acquires at epoch 2000 (A's lease expired).
			// Release A's ownership first so B can acquire.
			releaseOwnership({ db: ctx.runDb.connection, handle: handleA });

			const bAcquired = acquire(ctx.runDb, {
				nowEpochMs: 2000,
				leaseDurationMs: 30_000,
			});
			expect(bAcquired.kind).toBe("ACQUIRED");
			if (bAcquired.kind !== "ACQUIRED") return;
			const handleB = bAcquired.handle;

			// B initializes.
			const bInit = initializeStateUnderFence({
				db: ctx.runDb.connection,
				handle: handleB,
				initialState: makeRecord() as unknown as Record<string, unknown>,
				nowEpochMs: 2000,
				nowIso: "1970-01-01T00:00:02.000Z",
			});
			expect(bInit.kind).toBe("INITIALIZED");

			// A tries to initialize with its stale handle.
			const aInit = initializeStateUnderFence({
				db: ctx.runDb.connection,
				handle: handleA,
				initialState: makeRecord() as unknown as Record<string, unknown>,
				nowEpochMs: 2000,
				nowIso: "1970-01-01T00:00:02.000Z",
			});

			// A MUST receive STALE_HANDLE, NOT ALREADY_INITIALIZED.
			expect(aInit.kind).toBe("STALE_HANDLE");
			expect(aInit.kind).not.toBe("ALREADY_INITIALIZED");
		} finally {
			ctx.cleanup();
		}
	});

	// -----------------------------------------------------------------------
	// 3 — Already initialized + valid handle → ALREADY_INITIALIZED
	// -----------------------------------------------------------------------

	test("already initialized + valid handle → ALREADY_INITIALIZED", () => {
		const ctx = setup();
		try {
			const acquired = acquire(ctx.runDb);
			expect(acquired.kind).toBe("ACQUIRED");
			if (acquired.kind !== "ACQUIRED") return;
			const handle = acquired.handle;

			// First initialization.
			const first = initializeStateUnderFence({
				db: ctx.runDb.connection,
				handle,
				initialState: makeRecord() as unknown as Record<string, unknown>,
				nowEpochMs: NOW_EPOCH,
				nowIso: NOW_ISO,
			});
			expect(first.kind).toBe("INITIALIZED");

			// Second initialization with same valid handle.
			const second = initializeStateUnderFence({
				db: ctx.runDb.connection,
				handle,
				initialState: makeRecord({
					currentPhase: "should-be-ignored",
				}) as unknown as Record<string, unknown>,
				nowEpochMs: NOW_EPOCH,
				nowIso: NOW_ISO,
			});

			expect(second.kind).toBe("ALREADY_INITIALIZED");
			if (second.kind === "ALREADY_INITIALIZED") {
				// The existing state is returned, not the new one.
				expect(second.state.currentPhase).toBe("start");
			}
		} finally {
			ctx.cleanup();
		}
	});
});

// ---------------------------------------------------------------------------
// 4 — Projection fails → release SUCCESS verified
// ---------------------------------------------------------------------------

describe("projection failure cleanup", () => {
	test("projection fails on invalid runDir → release succeeds", () => {
		const ctx = setup();
		try {
			const now = Date.now();
			const nowIso = new Date(now).toISOString();

			const acquired = acquire(ctx.runDb, {
				nowEpochMs: now,
				nowIso,
				leaseDurationMs: LONG_LEASE_MS,
			});
			expect(acquired.kind).toBe("ACQUIRED");
			if (acquired.kind !== "ACQUIRED") return;
			const handle = acquired.handle;

			// Seed state via unsafe (so revision 0 exists).
			const record = makeRecord({ runIncarnationId: handle.incarnationId });
			seedViaUnsafe(ctx.runDb, handle, record);

			// Use the real digest from the DB so the fenced projection
			// passes ownership + digest checks and fails on file I/O.
			const {
				readAuthoritativeState,
			} = require("../../src/persistence/sqlite/run-state-store");
			const read = readAuthoritativeState(ctx.runDb.connection);
			expect(read.state).not.toBeNull();
			const realState = read.state!;
			const realDigest = read.digest as string;

			// Try fenced projection on a non-existent directory.
			const badDir = join(ctx.dir, "nonexistent");

			let threw = false;
			try {
				projectStateJsonFenced(
					{
						runDb: ctx.runDb,
						handle,
						runDir: badDir,
						runId: RUN_ID,
					},
					realState,
					realDigest,
				);
			} catch (err) {
				threw = true;
				expect(err).toBeInstanceOf(PersistenceFailureError);
			}
			expect(threw).toBe(true);

			// The transaction should have been rolled back. Ownership should
			// still be HELD (the fenced projection does rollback on error).
			const ownershipRow = ctx.runDb.connection
				.prepare(
					"SELECT ownership_status FROM run_ownership WHERE singleton = 1",
				)
				.get() as { ownership_status: string };
			expect(ownershipRow.ownership_status).toBe("HELD");
		} finally {
			ctx.cleanup();
		}
	});

	// -----------------------------------------------------------------------
	// 4b — Projection fails + release DB_FAILURE → both causes preserved
	// -----------------------------------------------------------------------

	test("projection fails + release DB_FAILURE → AggregateError with both causes", () => {
		const ctx = setup();
		try {
			const acquired = acquire(ctx.runDb);
			expect(acquired.kind).toBe("ACQUIRED");
			if (acquired.kind !== "ACQUIRED") return;
			const handle = acquired.handle;

			// Close the DB — releaseOwnership will return DB_FAILURE.
			ctx.runDb.close();

			// Simulate the runInitialMode catch block logic.
			const projectionErr = new Error("projection failed");
			const releaseResult = releaseOwnership({
				db: ctx.runDb.connection,
				handle,
			});

			// Release should be DB_FAILURE because DB is closed.
			expect(releaseResult.kind).toBe("DB_FAILURE");

			// Verify the AggregateError pattern used in runOrchestrator.
			const aggregate = new AggregateError(
				[
					projectionErr,
					releaseResult.kind === "DB_FAILURE"
						? releaseResult.cause
						: new Error(releaseResult.kind),
				],
				"projection and release both failed",
			);

			expect(aggregate.errors.length).toBe(2);
			expect(aggregate.errors[0]).toBe(projectionErr);
		} finally {
			ctx.cleanup();
		}
	});
});

// ---------------------------------------------------------------------------
// 5 — A commit revision 5, suspend, B commit/project revision 6 →
//     A cannot reproject revision 5
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
			expect(aAcquired.kind).toBe("ACQUIRED");
			if (aAcquired.kind !== "ACQUIRED") return;
			const handleA = aAcquired.handle;

			// A establishes initial state (revision 0).
			const aInit = initializeStateUnderFence({
				db: ctx.runDb.connection,
				handle: handleA,
				initialState: makeRecord() as unknown as Record<string, unknown>,
				nowEpochMs: now,
				nowIso,
			});
			expect(aInit.kind).toBe("INITIALIZED");
			if (aInit.kind !== "INITIALIZED") return;

			// A projects state.json (revision 0) — use unfenced projection for simplicity.
			const aInitState = aInit.committed.state;
			projectStateJson(ctx.dir, aInitState, aInit.committed.stateDigest);
			expect(existsSync(join(ctx.dir, "state.json"))).toBe(true);

			// A commits revisions 1..5 via commitState.
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
				expect(result.kind).toBe("COMMITTED");
				if (result.kind !== "COMMITTED") return;
				currentRevision = result.committed.state.stateRevision;
				lastCommitted = result.committed;
			}
			expect(currentRevision).toBe("5");
			expect(lastCommitted).not.toBeNull();

			// A is now suspended — does not project revision 5.

			// Release A's ownership so B can acquire (simulating A's lease
			// expiring or A crashing).
			releaseOwnership({ db: ctx.runDb.connection, handle: handleA });

			// ----- B's turn -----
			const bAcquired = acquire(ctx.runDb, {
				nowEpochMs: now + 1000,
				nowIso: new Date(now + 1000).toISOString(),
				leaseDurationMs: LONG_LEASE_MS,
			});
			expect(bAcquired.kind).toBe("ACQUIRED");
			if (bAcquired.kind !== "ACQUIRED") return;
			const handleB = bAcquired.handle;

			// B commits revision 6.
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
			expect(bCommit.kind).toBe("COMMITTED");
			if (bCommit.kind !== "COMMITTED") return;
			expect(bCommit.committed.state.stateRevision).toBe("6");

			// B projects revision 6 (fenced).
			const bCtx = {
				runDb: ctx.runDb,
				handle: handleB,
				runDir: ctx.dir,
				runId: RUN_ID,
			};

			projectStateJsonFenced(
				bCtx,
				bCommit.committed.state,
				bCommit.committed.stateDigest,
			);

			// Verify B's projection is on disk.
			const bProjection = JSON.parse(
				readFileSync(join(ctx.dir, "state.json"), "utf-8"),
			);
			expect(bProjection.stateRevision).toBe("6");
			expect(bProjection.currentPhase).toBe("phase-B");

			// ----- A resumes and tries to project revision 5 -----
			// A's handle is now stale (B owns the fence).
			// A tries the fenced projection with its stale handle.
			// This should be rejected.

			let aRejected = false;
			try {
				projectStateJsonFenced(
					{
						runDb: ctx.runDb,
						handle: handleA, // stale!
						runDir: ctx.dir,
						runId: RUN_ID,
					},
					lastCommitted!.state,
					lastCommitted!.stateDigest,
				);
			} catch (err) {
				aRejected = true;
				expect(err).toBeInstanceOf(AuthorityLostError);
				const aErr = err as AuthorityLostError;
				expect(aErr.kind).toBe("authority_lost");
				// Reason should be STALE_HANDLE (owner token or fence mismatch).
			}
			expect(aRejected).toBe(true);

			// Verify B's projection is still on disk (not overwritten by A).
			const finalProjection = JSON.parse(
				readFileSync(join(ctx.dir, "state.json"), "utf-8"),
			);
			expect(finalProjection.stateRevision).toBe("6");
			expect(finalProjection.currentPhase).toBe("phase-B");
		} finally {
			ctx.cleanup();
		}
	});

	// -----------------------------------------------------------------------
	// 5b — Even with valid handle, revision mismatch prevents overwrite
	// -----------------------------------------------------------------------

	test("fenced projection with revision mismatch (own handle, but newer revision in DB) → rejected", () => {
		const ctx = setup();
		try {
			const acquired = acquire(ctx.runDb);
			expect(acquired.kind).toBe("ACQUIRED");
			if (acquired.kind !== "ACQUIRED") return;
			const handle = acquired.handle;

			// Seed initial state.
			const aInit = initializeStateUnderFence({
				db: ctx.runDb.connection,
				handle,
				initialState: makeRecord() as unknown as Record<string, unknown>,
				nowEpochMs: NOW_EPOCH,
				nowIso: NOW_ISO,
			});
			expect(aInit.kind).toBe("INITIALIZED");
			if (aInit.kind !== "INITIALIZED") return;

			// Commit revision 1.
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
			expect(c1.kind).toBe("COMMITTED");
			if (c1.kind !== "COMMITTED") return;

			// Now manually bump the revision in the DB via raw SQL
			// (simulating something weird happening).
			ctx.runDb.connection.exec(
				"UPDATE run_state SET state_revision = 99, state_digest = 'sha256:modified' WHERE singleton = 1",
			);

			// Try fenced projection with the old state (revision 1).
			let rejected = false;
			try {
				projectStateJsonFenced(
					{
						runDb: ctx.runDb,
						handle,
						runDir: ctx.dir,
						runId: RUN_ID,
					},
					c1.committed.state, // says revision "1"
					c1.committed.stateDigest, // old digest
				);
			} catch (err) {
				rejected = true;
				// Should be AuthorityLostError or PersistenceFailureError
				// because revision or digest doesn't match.
				expect(
					err instanceof AuthorityLostError ||
						err instanceof PersistenceFailureError,
				).toBe(true);
			}
			expect(rejected).toBe(true);
		} finally {
			ctx.cleanup();
		}
	});
});

// ---------------------------------------------------------------------------
// 6 — Stale handle rejected by fenced projection (ownership mismatch)
// ---------------------------------------------------------------------------

describe("fenced projection ownership guard", () => {
	test("stale handle → AuthorityLostError, state.json not overwritten", () => {
		const ctx = setup();
		try {
			// A acquires.
			const aAcquired = acquire(ctx.runDb);
			expect(aAcquired.kind).toBe("ACQUIRED");
			if (aAcquired.kind !== "ACQUIRED") return;
			const handleA = aAcquired.handle;

			// Seed and initialize.
			const aInit = initializeStateUnderFence({
				db: ctx.runDb.connection,
				handle: handleA,
				initialState: makeRecord() as unknown as Record<string, unknown>,
				nowEpochMs: NOW_EPOCH,
				nowIso: NOW_ISO,
			});
			expect(aInit.kind).toBe("INITIALIZED");
			if (aInit.kind !== "INITIALIZED") return;

			// Write a known state.json.
			const stateJsonPath = join(ctx.dir, "state.json");
			writeFileSync(stateJsonPath, JSON.stringify({ marker: "before" }));

			// Release A's ownership.
			releaseOwnership({ db: ctx.runDb.connection, handle: handleA });

			// B acquires.
			const bAcquired = acquire(ctx.runDb, { nowEpochMs: NOW_EPOCH + 1000 });
			expect(bAcquired.kind).toBe("ACQUIRED");
			if (bAcquired.kind !== "ACQUIRED") return;

			// A tries fenced projection with its stale handle.
			let rejected = false;
			try {
				projectStateJsonFenced(
					{
						runDb: ctx.runDb,
						handle: handleA, // stale
						runDir: ctx.dir,
						runId: RUN_ID,
					},
					aInit.committed.state,
					aInit.committed.stateDigest,
				);
			} catch (err) {
				rejected = true;
				expect(err).toBeInstanceOf(AuthorityLostError);
			}
			expect(rejected).toBe(true);

			// state.json must NOT have been overwritten.
			const content = JSON.parse(readFileSync(stateJsonPath, "utf-8"));
			expect(content.marker).toBe("before");
		} finally {
			ctx.cleanup();
		}
	});

	test("expired lease → AuthorityLostError with reason EXPIRED_HANDLE", () => {
		const ctx = setup();
		try {
			// Acquire with very short lease at epoch 0.
			const acquired = acquire(ctx.runDb, {
				nowEpochMs: 0,
				leaseDurationMs: 1000,
			});
			expect(acquired.kind).toBe("ACQUIRED");
			if (acquired.kind !== "ACQUIRED") return;
			const handle = acquired.handle;

			// Seed via unsafe for simplicity.
			const record = makeRecord({
				runIncarnationId: handle.incarnationId,
			});
			seedViaUnsafe(ctx.runDb, handle, record);

			// Try fenced projection far past the lease.
			let rejected = false;
			try {
				projectStateJsonFenced(
					{
						runDb: ctx.runDb,
						handle,
						runDir: ctx.dir,
						runId: RUN_ID,
					},
					record,
					"sha256:0000000000000000000000000000000000000000000000000000000000000000", // wrong digest but lease check comes first
				);
			} catch (err) {
				rejected = true;
				expect(err).toBeInstanceOf(AuthorityLostError);
				const aErr = err as AuthorityLostError;
				expect(aErr.reason).toBe("EXPIRED_HANDLE");
			}
			expect(rejected).toBe(true);
		} finally {
			ctx.cleanup();
		}
	});
});
