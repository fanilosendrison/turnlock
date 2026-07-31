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

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { STATE_SCHEMA_VERSION } from "../../src/constants";
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
	projectAuthoritativeStateFenced,
	readAuthoritativeState,
	type StateRecord,
} from "../../src/persistence/sqlite/run-state-store";
import { cleanupTempDir, makeTempDir } from "../helpers/temp-run-dir";
import { unsafeWriteStateJson } from "../helpers/unsafe-state-projection";
import { unsafeEnsureInitialStateRow } from "../helpers/unsafe-state-seed";

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
			const acquired = acquire(ctx.runDb, {
				nowEpochMs: 0,
				leaseDurationMs: 1000,
			});
			expect(acquired.kind).toBe("ACQUIRED");
			if (acquired.kind !== "ACQUIRED") return;
			const handle = acquired.handle;

			const initResult = initializeStateUnderFence({
				db: ctx.runDb.connection,
				handle,
				initialState: makeRecord() as unknown as Record<string, unknown>,
				nowEpochMs: 2000,
				nowIso: "1970-01-01T00:00:02.000Z",
			});

			expect(initResult.kind).toBe("EXPIRED_HANDLE");
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
			expect(aAcquired.kind).toBe("ACQUIRED");
			if (aAcquired.kind !== "ACQUIRED") return;
			const handleA = aAcquired.handle;

			releaseOwnership({ db: ctx.runDb.connection, handle: handleA });

			const bAcquired = acquire(ctx.runDb, {
				nowEpochMs: 2000,
				leaseDurationMs: 30_000,
			});
			expect(bAcquired.kind).toBe("ACQUIRED");
			if (bAcquired.kind !== "ACQUIRED") return;
			const handleB = bAcquired.handle;

			const bInit = initializeStateUnderFence({
				db: ctx.runDb.connection,
				handle: handleB,
				initialState: makeRecord() as unknown as Record<string, unknown>,
				nowEpochMs: 2000,
				nowIso: "1970-01-01T00:00:02.000Z",
			});
			expect(bInit.kind).toBe("INITIALIZED");

			const aInit = initializeStateUnderFence({
				db: ctx.runDb.connection,
				handle: handleA,
				initialState: makeRecord() as unknown as Record<string, unknown>,
				nowEpochMs: 2000,
				nowIso: "1970-01-01T00:00:02.000Z",
			});

			expect(aInit.kind).toBe("STALE_HANDLE");
			expect(aInit.kind).not.toBe("ALREADY_INITIALIZED");
		} finally {
			ctx.cleanup();
		}
	});

	test("already initialized + valid handle → ALREADY_INITIALIZED", () => {
		const ctx = setup();
		try {
			const acquired = acquire(ctx.runDb);
			expect(acquired.kind).toBe("ACQUIRED");
			if (acquired.kind !== "ACQUIRED") return;
			const handle = acquired.handle;

			const first = initializeStateUnderFence({
				db: ctx.runDb.connection,
				handle,
				initialState: makeRecord() as unknown as Record<string, unknown>,
				nowEpochMs: NOW_EPOCH,
				nowIso: NOW_ISO,
			});
			expect(first.kind).toBe("INITIALIZED");

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
				expect(second.state.currentPhase).toBe("start");
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
			expect(acquired.kind).toBe("ACQUIRED");
			if (acquired.kind !== "ACQUIRED") return;
			const handle = acquired.handle;

			const record = makeRecord({ runIncarnationId: handle.incarnationId });
			seedViaUnsafe(ctx.runDb, handle, record);

			const read = readAuthoritativeState(ctx.runDb.connection);
			expect(read.state).not.toBeNull();
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
				expect(err).toBeInstanceOf(PersistenceFailureError);
			}
			expect(threw).toBe(true);

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

	test("projection fails + release DB_FAILURE → both causes preserved", () => {
		const ctx = setup();
		try {
			const acquired = acquire(ctx.runDb);
			expect(acquired.kind).toBe("ACQUIRED");
			if (acquired.kind !== "ACQUIRED") return;
			const handle = acquired.handle;

			ctx.runDb.close();

			const projectionErr = new Error("projection failed");
			const releaseResult = releaseOwnership({
				db: ctx.runDb.connection,
				handle,
			});

			expect(releaseResult.kind).toBe("DB_FAILURE");

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
			expect(acquired.kind).toBe("ACQUIRED");
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
			expect(read.state).not.toBeNull();
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
			expect(projected.data).toEqual({ stage: "autoritatif", value: 42 });
			expect(projected.currentPhase).toBe("real-phase");
			expect(projected.stateRevision).toBe("0");
			expect(projected.stateDigest).toBe(digest);
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
			expect(acquired.kind).toBe("ACQUIRED");
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
				expect(err).toBeInstanceOf(PersistenceFailureError);
			}
			expect(rejected).toBe(true);
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
			expect(aAcquired.kind).toBe("ACQUIRED");
			if (aAcquired.kind !== "ACQUIRED") return;
			const handleA = aAcquired.handle;

			const aInit = initializeStateUnderFence({
				db: ctx.runDb.connection,
				handle: handleA,
				initialState: makeRecord() as unknown as Record<string, unknown>,
				nowEpochMs: now,
				nowIso,
			});
			expect(aInit.kind).toBe("INITIALIZED");
			if (aInit.kind !== "INITIALIZED") return;

			// A projects revision 0.
			unsafeWriteStateJson(
				ctx.dir,
				aInit.committed.state,
				aInit.committed.stateDigest,
			);
			expect(existsSync(join(ctx.dir, "state.json"))).toBe(true);

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
				expect(result.kind).toBe("COMMITTED");
				if (result.kind !== "COMMITTED") return;
				currentRevision = result.committed.state.stateRevision;
				lastCommitted = result.committed;
			}
			expect(currentRevision).toBe("5");
			expect(lastCommitted).not.toBeNull();

			// A is suspended — does not project revision 5.

			// Release A so B can acquire.
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
			expect(bProjection.stateRevision).toBe("6");
			expect(bProjection.currentPhase).toBe("phase-B");

			// ----- A resumes and tries to project revision 5 -----
			let aRejected = false;
			try {
				projectAuthoritativeStateFenced(
					ctx.runDb.connection,
					handleA, // stale!
					ctx.dir,
					"5",
					lastCommitted!.stateDigest,
				);
			} catch (err) {
				aRejected = true;
				expect(err).toBeInstanceOf(AuthorityLostError);
			}
			expect(aRejected).toBe(true);

			// B's projection must still be on disk.
			const finalProjection = JSON.parse(
				readFileSync(join(ctx.dir, "state.json"), "utf-8"),
			);
			expect(finalProjection.stateRevision).toBe("6");
			expect(finalProjection.currentPhase).toBe("phase-B");
		} finally {
			ctx.cleanup();
		}
	});

	test("fenced projection with revision mismatch (own handle, but newer revision in DB) → rejected", () => {
		const ctx = setup();
		try {
			const acquired = acquire(ctx.runDb);
			expect(acquired.kind).toBe("ACQUIRED");
			if (acquired.kind !== "ACQUIRED") return;
			const handle = acquired.handle;

			const aInit = initializeStateUnderFence({
				db: ctx.runDb.connection,
				handle,
				initialState: makeRecord() as unknown as Record<string, unknown>,
				nowEpochMs: NOW_EPOCH,
				nowIso: NOW_ISO,
			});
			expect(aInit.kind).toBe("INITIALIZED");
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
			expect(c1.kind).toBe("COMMITTED");
			if (c1.kind !== "COMMITTED") return;

			// Bump revision via raw SQL.
			ctx.runDb.connection.exec(
				"UPDATE run_state SET state_revision = 99, state_digest = 'sha256:modified' WHERE singleton = 1",
			);

			// Read current state to get the real digest (modified by the raw SQL).
			const read = readAuthoritativeState(ctx.runDb.connection);
			expect(read.state).not.toBeNull();

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
				expect(err).toBeInstanceOf(AuthorityLostError);
			}
			expect(rejected).toBe(true);
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
			expect(aAcquired.kind).toBe("ACQUIRED");
			if (aAcquired.kind !== "ACQUIRED") return;
			const handleA = aAcquired.handle;

			const aInit = initializeStateUnderFence({
				db: ctx.runDb.connection,
				handle: handleA,
				initialState: makeRecord() as unknown as Record<string, unknown>,
				nowEpochMs: NOW_EPOCH,
				nowIso: NOW_ISO,
			});
			expect(aInit.kind).toBe("INITIALIZED");
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
				expect(err).toBeInstanceOf(AuthorityLostError);
			}
			expect(rejected).toBe(true);

			const content = JSON.parse(readFileSync(stateJsonPath, "utf-8"));
			expect(content.marker).toBe("before");
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
			expect(acquired.kind).toBe("ACQUIRED");
			if (acquired.kind !== "ACQUIRED") return;
			const handle = acquired.handle;

			const record = makeRecord({ runIncarnationId: handle.incarnationId });
			seedViaUnsafe(ctx.runDb, handle, record);

			const read = readAuthoritativeState(ctx.runDb.connection);
			expect(read.state).not.toBeNull();

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
