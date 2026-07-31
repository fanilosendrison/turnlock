// Lot 3 — authoritative state store tests.
//
// Covers: initial state creation, commit with valid handle, stale handle,
// expired handle, revision conflict, read back, state.json projection.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { bunSqliteDriver } from "../../src/persistence/sqlite/bun-sqlite-driver";
import { acquireOwnership } from "../../src/persistence/sqlite/ownership";
import { openRunDatabase } from "../../src/persistence/sqlite/run-database";
import {
	commitState,
	projectStateJson,
	readAuthoritativeState,
	type StateRecord,
} from "../../src/persistence/sqlite/run-state-store";
import { cleanupTempDir, makeTempDir } from "../helpers/temp-run-dir";
import { unsafeEnsureInitialStateRow } from "../helpers/unsafe-state-seed";

const LEASE_MS = 30 * 60 * 1000;
const NOW_EPOCH = 1_000_000_000_000;
const NOW_ISO = "2001-09-09T01:46:40.000Z";
const CONTENTION_DEADLINE_MS = 2_000;

interface TestData {
	stage: string;
	count: number;
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

function acquire(runDb: ReturnType<typeof openRunDatabase>) {
	return acquireOwnership({
		db: runDb.connection,
		runId: "01HX0000000000000000000001",
		orchestratorName: "test-state",
		nowEpochMs: NOW_EPOCH,
		nowIso: NOW_ISO,
		leaseDurationMs: LEASE_MS,
		contentionDeadlineMs: CONTENTION_DEADLINE_MS,
	});
}

function makeInitialState(): StateRecord<TestData> {
	return {
		schemaVersion: 4,
		runId: "01HX0000000000000000000001",
		orchestratorName: "test-state",
		startedAt: NOW_ISO,
		startedAtEpochMs: NOW_EPOCH,
		lastTransitionAt: NOW_ISO,
		lastTransitionAtEpochMs: NOW_EPOCH,
		currentPhase: "start",
		phasesExecuted: 0,
		accumulatedDurationMs: 0,
		data: { stage: "initial", count: 0 },
		usedLabels: [],
		runIncarnationId: "",
		stateRevision: "0",
		committedFenceToken: "0",
	};
}

describe("run-state-store", () => {
	test("initial state row is created and readable", () => {
		const ctx = setup();
		try {
			const result = acquire(ctx.runDb);
			expect(result.kind).toBe("ACQUIRED");
			if (result.kind !== "ACQUIRED") return;

			unsafeEnsureInitialStateRow(
				ctx.runDb.connection,
				result.handle.incarnationId,
				4,
				JSON.stringify(makeInitialState()),
				NOW_EPOCH,
				NOW_ISO,
			);

			const read = readAuthoritativeState<TestData>(ctx.runDb.connection);
			expect(read.state).not.toBeNull();
			if (read.state === null) return;
			expect(read.state.data).toEqual({ stage: "initial", count: 0 });
			expect(read.state.stateRevision).toBe("0");
			expect(read.digest).toMatch(/^sha256:/);
		} finally {
			ctx.cleanup();
		}
	});

	test("commit increments revision and persists new state", () => {
		const ctx = setup();
		try {
			const result = acquire(ctx.runDb);
			expect(result.kind).toBe("ACQUIRED");
			if (result.kind !== "ACQUIRED") return;

			const initial = makeInitialState();
			unsafeEnsureInitialStateRow(
				ctx.runDb.connection,
				result.handle.incarnationId,
				4,
				JSON.stringify(initial),
				NOW_EPOCH,
				NOW_ISO,
			);

			const next = {
				...initial,
				currentPhase: "next",
				phasesExecuted: 1,
				data: { stage: "modified", count: 1 },
			};

			const commitResult = commitState({
				db: ctx.runDb.connection,
				handle: result.handle,
				expectedRevision: "0",
				nextState: next,
				nowEpochMs: NOW_EPOCH,
				nowIso: NOW_ISO,
			});
			expect(commitResult.kind).toBe("COMMITTED");
			if (commitResult.kind !== "COMMITTED") return;
			expect(commitResult.committed.state.data).toEqual({
				stage: "modified",
				count: 1,
			});
			expect(commitResult.committed.state.stateRevision).toBe("1");
		} finally {
			ctx.cleanup();
		}
	});

	test("revision conflict is detected", () => {
		const ctx = setup();
		try {
			const result = acquire(ctx.runDb);
			expect(result.kind).toBe("ACQUIRED");
			if (result.kind !== "ACQUIRED") return;

			const initial = makeInitialState();
			unsafeEnsureInitialStateRow(
				ctx.runDb.connection,
				result.handle.incarnationId,
				4,
				JSON.stringify(initial),
				NOW_EPOCH,
				NOW_ISO,
			);

			const first = commitState({
				db: ctx.runDb.connection,
				handle: result.handle,
				expectedRevision: "0",
				nextState: { ...initial, currentPhase: "first" },
				nowEpochMs: NOW_EPOCH,
				nowIso: NOW_ISO,
			});
			expect(first.kind).toBe("COMMITTED");

			// Try with stale revision.
			const second = commitState({
				db: ctx.runDb.connection,
				handle: result.handle,
				expectedRevision: "0", // stale — now at revision 1
				nextState: { ...initial, currentPhase: "second" },
				nowEpochMs: NOW_EPOCH,
				nowIso: NOW_ISO,
			});
			expect(second.kind).toBe("REVISION_CONFLICT");
		} finally {
			ctx.cleanup();
		}
	});

	test("stale handle is rejected during commit", () => {
		const ctx = setup();
		try {
			const result = acquire(ctx.runDb);
			expect(result.kind).toBe("ACQUIRED");
			if (result.kind !== "ACQUIRED") return;

			const initial = makeInitialState();
			unsafeEnsureInitialStateRow(
				ctx.runDb.connection,
				result.handle.incarnationId,
				4,
				JSON.stringify(initial),
				NOW_EPOCH,
				NOW_ISO,
			);

			// Manually release to invalidate handle.
			ctx.runDb.connection.exec(
				`UPDATE run_ownership
				 SET ownership_status = 'FREE',
				     owner_token = NULL,
				     owner_pid = NULL
				 WHERE singleton = 1`,
			);

			const commitResult = commitState({
				db: ctx.runDb.connection,
				handle: result.handle,
				expectedRevision: "0",
				nextState: { ...initial, currentPhase: "next" },
				nowEpochMs: NOW_EPOCH,
				nowIso: NOW_ISO,
			});
			expect(commitResult.kind).toBe("STALE_HANDLE");
		} finally {
			ctx.cleanup();
		}
	});

	test("state.json projection is written and round-trips", () => {
		const ctx = setup();
		try {
			const result = acquire(ctx.runDb);
			expect(result.kind).toBe("ACQUIRED");
			if (result.kind !== "ACQUIRED") return;

			const initial = makeInitialState();
			unsafeEnsureInitialStateRow(
				ctx.runDb.connection,
				result.handle.incarnationId,
				4,
				JSON.stringify(initial),
				NOW_EPOCH,
				NOW_ISO,
			);

			const next = {
				...initial,
				currentPhase: "step-2",
				phasesExecuted: 1,
				data: { stage: "projection-test", count: 42 },
			};

			const commitResult = commitState({
				db: ctx.runDb.connection,
				handle: result.handle,
				expectedRevision: "0",
				nextState: next,
				nowEpochMs: NOW_EPOCH,
				nowIso: NOW_ISO,
			});
			expect(commitResult.kind).toBe("COMMITTED");
			if (commitResult.kind !== "COMMITTED") return;

			projectStateJson(
				ctx.dir,
				commitResult.committed.state,
				commitResult.committed.stateDigest,
			);

			const statePath = join(ctx.dir, "state.json");
			expect(existsSync(statePath)).toBe(true);
			const raw = readFileSync(statePath, "utf-8");
			const parsed = JSON.parse(raw);
			expect(parsed.data).toEqual({ stage: "projection-test", count: 42 });
			expect(parsed.stateRevision).toBe("1");
			expect(parsed.runIncarnationId).toBe(result.handle.incarnationId);
			expect(parsed.stateDigest).toMatch(/^sha256:/);
			expect(existsSync(join(ctx.dir, "state.json.tmp"))).toBe(false);
		} finally {
			ctx.cleanup();
		}
	});

	test("repeated commits produce monotonic revisions", () => {
		const ctx = setup();
		try {
			const result = acquire(ctx.runDb);
			expect(result.kind).toBe("ACQUIRED");
			if (result.kind !== "ACQUIRED") return;

			const initial = makeInitialState();
			unsafeEnsureInitialStateRow(
				ctx.runDb.connection,
				result.handle.incarnationId,
				4,
				JSON.stringify(initial),
				NOW_EPOCH,
				NOW_ISO,
			);

			const revisions: string[] = [];
			let current = initial;
			let currentRevision = "0";

			for (let i = 1; i <= 5; i++) {
				current = {
					...current,
					currentPhase: `phase-${i}`,
					phasesExecuted: i,
				};
				const cr = commitState({
					db: ctx.runDb.connection,
					handle: result.handle,
					expectedRevision: currentRevision,
					nextState: current,
					nowEpochMs: NOW_EPOCH,
					nowIso: NOW_ISO,
				});
				expect(cr.kind).toBe("COMMITTED");
				if (cr.kind === "COMMITTED") {
					revisions.push(cr.committed.state.stateRevision);
					currentRevision = cr.committed.state.stateRevision;
				}
			}

			expect(revisions).toEqual(["1", "2", "3", "4", "5"]);
		} finally {
			ctx.cleanup();
		}
	});
});
