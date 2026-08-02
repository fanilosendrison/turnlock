import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
	PENDING_INITIAL_DISPATCH_STATE_FIELD,
	PENDING_INITIAL_DISPATCH_VERSION,
	PENDING_INITIAL_DISPATCH_VERSION_STATE_FIELD,
	STATE_SCHEMA_VERSION,
} from "../../src/constants";
import { bunSqliteDriver } from "../../src/persistence/sqlite/bun-sqlite-driver";
import {
	acquireOwnership,
	releaseOwnership,
} from "../../src/persistence/sqlite/ownership";
import {
	bootstrapNewRunAtomic,
	migrateLegacyRunAtomic,
} from "../../src/persistence/sqlite/run-bootstrap";
import { openRunDatabase } from "../../src/persistence/sqlite/run-database";
import {
	claimInitialDispatchUnderFence,
	readAuthoritativeState,
} from "../../src/persistence/sqlite/run-state-store";
import { cleanupTempDir, makeTempDir } from "../helpers/temp-run-dir";

const NOW_EPOCH_MS = 1_704_067_200_000;
const NOW_ISO = "2024-01-01T00:00:00.000Z";
const LEASE_DURATION_MS = 30 * 60 * 1000;

function makeInitialState(runId: string): Record<string, unknown> {
	return {
		schemaVersion: STATE_SCHEMA_VERSION,
		runId,
		orchestratorName: "initial-dispatch-marker-test",
		startedAt: NOW_ISO,
		startedAtEpochMs: NOW_EPOCH_MS,
		lastTransitionAt: NOW_ISO,
		lastTransitionAtEpochMs: NOW_EPOCH_MS,
		currentPhase: "start",
		phasesExecuted: 0,
		accumulatedDurationMs: 0,
		data: { source: "test" },
		usedLabels: [],
		[PENDING_INITIAL_DISPATCH_STATE_FIELD]: true,
		[PENDING_INITIAL_DISPATCH_VERSION_STATE_FIELD]:
			PENDING_INITIAL_DISPATCH_VERSION,
	};
}

describe("pending initial dispatch persistence marker", () => {
	test("new-run state exposes durable pending-dispatch evidence", () => {
		const dir = makeTempDir("initial-dispatch-marker-");
		const runDb = openRunDatabase({
			driver: bunSqliteDriver,
			dbPath: join(dir, "turnlock.sqlite3"),
			busyTimeoutMs: 500,
		});
		try {
			const result = bootstrapNewRunAtomic({
				db: runDb.connection,
				runId: "01HX0000000000000000000011",
				orchestratorName: "initial-dispatch-marker-test",
				nowEpochMs: NOW_EPOCH_MS,
				nowIso: NOW_ISO,
				leaseDurationMs: LEASE_DURATION_MS,
				leaseClockEpochMs: () => NOW_EPOCH_MS,
				initialState: makeInitialState("01HX0000000000000000000011"),
				stateSchemaVersion: STATE_SCHEMA_VERSION,
				contentionDeadlineMs: 2_000,
			});
			expect(result.kind).toBe("BOOTSTRAPPED");
			if (result.kind !== "BOOTSTRAPPED") return;

			const read = readAuthoritativeState(runDb.connection);
			expect(read.pendingInitialDispatch).toBe(true);
			expect(read.state?.stateRevision).toBe("0");

			const claim = claimInitialDispatchUnderFence({
				db: runDb.connection,
				handle: result.handle,
				leaseClockEpochMs: () => NOW_EPOCH_MS,
			});
			expect(claim.kind).toBe("CLAIMED");
			if (claim.kind !== "CLAIMED") return;
			expect(claim.committed.state.stateRevision).toBe("1");

			const claimedRead = readAuthoritativeState(runDb.connection);
			expect(claimedRead.pendingInitialDispatch).toBe(false);
			expect(claimedRead.state?.stateRevision).toBe("1");
			const rawClaimedState = runDb.connection
				.prepare("SELECT state_json FROM run_state WHERE singleton = 1")
				.get() as { state_json: string };
			const parsedClaimedState = JSON.parse(
				rawClaimedState.state_json,
			) as Record<string, unknown>;
			expect(parsedClaimedState).not.toHaveProperty(
				PENDING_INITIAL_DISPATCH_STATE_FIELD,
			);
			expect(parsedClaimedState).not.toHaveProperty(
				PENDING_INITIAL_DISPATCH_VERSION_STATE_FIELD,
			);

			releaseOwnership({ db: runDb.connection, handle: result.handle });
		} finally {
			runDb.close();
			cleanupTempDir(dir);
		}
	});

	test("legacy migration strips forged pending-dispatch evidence", () => {
		const dir = makeTempDir("legacy-dispatch-marker-");
		const runDb = openRunDatabase({
			driver: bunSqliteDriver,
			dbPath: join(dir, "turnlock.sqlite3"),
			busyTimeoutMs: 500,
		});
		try {
			const result = migrateLegacyRunAtomic({
				db: runDb.connection,
				runId: "01HX0000000000000000000012",
				orchestratorName: "initial-dispatch-marker-test",
				nowEpochMs: NOW_EPOCH_MS,
				nowIso: NOW_ISO,
				leaseDurationMs: LEASE_DURATION_MS,
				leaseClockEpochMs: () => NOW_EPOCH_MS,
				legacyState: makeInitialState("01HX0000000000000000000012"),
				legacyStartedAtEpochMs: NOW_EPOCH_MS - 10_000,
				legacyStartedAt: "2023-12-31T23:59:50.000Z",
				legacyLastTransitionAtEpochMs: NOW_EPOCH_MS - 5_000,
				legacyLastTransitionAt: "2023-12-31T23:59:55.000Z",
				stateSchemaVersion: STATE_SCHEMA_VERSION,
				contentionDeadlineMs: 2_000,
			});
			expect(result.kind).toBe("MIGRATED");
			if (result.kind !== "MIGRATED") return;

			const read = readAuthoritativeState(runDb.connection);
			expect(read.pendingInitialDispatch).toBe(false);
			const rawMigratedState = runDb.connection
				.prepare("SELECT state_json FROM run_state WHERE singleton = 1")
				.get() as { state_json: string };
			const parsedMigratedState = JSON.parse(
				rawMigratedState.state_json,
			) as Record<string, unknown>;
			expect(parsedMigratedState).not.toHaveProperty(
				PENDING_INITIAL_DISPATCH_STATE_FIELD,
			);
			expect(parsedMigratedState).not.toHaveProperty(
				PENDING_INITIAL_DISPATCH_VERSION_STATE_FIELD,
			);
			releaseOwnership({ db: runDb.connection, handle: result.handle });
		} finally {
			runDb.close();
			cleanupTempDir(dir);
		}
	});

	test("claim is fenced against a successor ownership handle", () => {
		const dir = makeTempDir("initial-dispatch-claim-fence-");
		const runId = "01HX0000000000000000000013";
		const runDb = openRunDatabase({
			driver: bunSqliteDriver,
			dbPath: join(dir, "turnlock.sqlite3"),
			busyTimeoutMs: 500,
		});
		try {
			const result = bootstrapNewRunAtomic({
				db: runDb.connection,
				runId,
				orchestratorName: "initial-dispatch-marker-test",
				nowEpochMs: NOW_EPOCH_MS,
				nowIso: NOW_ISO,
				leaseDurationMs: LEASE_DURATION_MS,
				leaseClockEpochMs: () => NOW_EPOCH_MS,
				initialState: makeInitialState(runId),
				stateSchemaVersion: STATE_SCHEMA_VERSION,
				contentionDeadlineMs: 2_000,
			});
			expect(result.kind).toBe("BOOTSTRAPPED");
			if (result.kind !== "BOOTSTRAPPED") return;

			expect(
				releaseOwnership({ db: runDb.connection, handle: result.handle }).kind,
			).toBe("SUCCESS");
			const successor = acquireOwnership({
				db: runDb.connection,
				runId,
				orchestratorName: "initial-dispatch-marker-test",
				nowEpochMs: NOW_EPOCH_MS + 1,
				nowIso: "2024-01-01T00:00:00.001Z",
				leaseDurationMs: LEASE_DURATION_MS,
				leaseClockEpochMs: () => NOW_EPOCH_MS + 1,
				contentionDeadlineMs: 2_000,
			});
			expect(successor.kind).toBe("ACQUIRED");
			if (successor.kind !== "ACQUIRED") return;

			const claim = claimInitialDispatchUnderFence({
				db: runDb.connection,
				handle: result.handle,
				leaseClockEpochMs: () => NOW_EPOCH_MS + 1,
			});
			expect(claim.kind).toBe("STALE_HANDLE");
			const read = readAuthoritativeState(runDb.connection);
			expect(read.pendingInitialDispatch).toBe(true);
			expect(read.state?.stateRevision).toBe("0");

			releaseOwnership({ db: runDb.connection, handle: successor.handle });
		} finally {
			runDb.close();
			cleanupTempDir(dir);
		}
	});

	test("unversioned markers from a prior binary are not claimable after upgrade", () => {
		const dir = makeTempDir("legacy-initial-dispatch-marker-");
		const runDb = openRunDatabase({
			driver: bunSqliteDriver,
			dbPath: join(dir, "turnlock.sqlite3"),
			busyTimeoutMs: 500,
		});
		try {
			const unversionedState = makeInitialState("01HX0000000000000000000013");
			delete unversionedState[PENDING_INITIAL_DISPATCH_VERSION_STATE_FIELD];
			const result = bootstrapNewRunAtomic({
				db: runDb.connection,
				runId: "01HX0000000000000000000013",
				orchestratorName: "initial-dispatch-marker-test",
				nowEpochMs: NOW_EPOCH_MS,
				nowIso: NOW_ISO,
				leaseDurationMs: LEASE_DURATION_MS,
				leaseClockEpochMs: () => NOW_EPOCH_MS,
				initialState: unversionedState,
				stateSchemaVersion: STATE_SCHEMA_VERSION,
				contentionDeadlineMs: 2_000,
			});
			expect(result.kind).toBe("BOOTSTRAPPED");
			if (result.kind !== "BOOTSTRAPPED") return;

			const read = readAuthoritativeState(runDb.connection);
			expect(read.pendingInitialDispatch).toBe(false);
			releaseOwnership({ db: runDb.connection, handle: result.handle });
		} finally {
			runDb.close();
			cleanupTempDir(dir);
		}
	});
});
