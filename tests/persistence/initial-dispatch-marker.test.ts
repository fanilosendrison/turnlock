import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
	PENDING_INITIAL_DISPATCH_STATE_FIELD,
	STATE_SCHEMA_VERSION,
} from "../../src/constants";
import { bunSqliteDriver } from "../../src/persistence/sqlite/bun-sqlite-driver";
import { releaseOwnership } from "../../src/persistence/sqlite/ownership";
import {
	bootstrapNewRunAtomic,
	migrateLegacyRunAtomic,
} from "../../src/persistence/sqlite/run-bootstrap";
import { openRunDatabase } from "../../src/persistence/sqlite/run-database";
import { readAuthoritativeState } from "../../src/persistence/sqlite/run-state-store";
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
			releaseOwnership({ db: runDb.connection, handle: result.handle });
		} finally {
			runDb.close();
			cleanupTempDir(dir);
		}
	});
});
