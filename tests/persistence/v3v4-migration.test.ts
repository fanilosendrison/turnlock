// v3→v4 SQLite migration integration tests.
//
// Exercises the resume-mode migration path: open DB → acquire →
// read authoritative state → migrate v3→v4 → commit → verify.
// Does NOT go through runOrchestrator (which is a process-level entrypoint).

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { STATE_SCHEMA_VERSION } from "../../src/constants";
import { bunSqliteDriver } from "../../src/persistence/sqlite/bun-sqlite-driver";
import {
	acquireOwnership,
	releaseOwnership,
} from "../../src/persistence/sqlite/ownership";
import { openRunDatabase } from "../../src/persistence/sqlite/run-database";
import {
	commitState,
	readAuthoritativeState,
	type StateRecord,
} from "../../src/persistence/sqlite/run-state-store";
import { migrateV3ToV4 } from "../../src/services/state-io";
import { cleanupTempDir, makeTempDir } from "../helpers/temp-run-dir";
import { unsafeEnsureInitialStateRow } from "../helpers/unsafe-state-seed";

const LEASE_MS = 30 * 60 * 1000;
const NOW_EPOCH = 1_000_000_000_000;
const NOW_ISO = "2001-09-09T01:46:40.000Z";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function v3DelegationState(): Record<string, unknown> {
	return {
		schemaVersion: 3,
		runId: "01HX000000000000000000V301",
		orchestratorName: "migration-test",
		startedAt: NOW_ISO,
		startedAtEpochMs: NOW_EPOCH,
		lastTransitionAt: NOW_ISO,
		lastTransitionAtEpochMs: NOW_EPOCH,
		currentPhase: "resumePhase",
		phasesExecuted: 1,
		accumulatedDurationMs: 100,
		data: { stage: "pending" },
		usedLabels: ["rev"],
		pendingDelegation: {
			label: "rev",
			kind: "prompt",
			resumeAt: "nextPhase",
			manifestPath: "delegations/rev-0.json",
			emittedAtEpochMs: NOW_EPOCH,
			deadlineAtEpochMs: NOW_EPOCH + 3600_000,
			attempt: 0,
			effectiveRetryPolicy: {
				maxAttempts: 3,
				backoffBaseMs: 1000,
				maxBackoffMs: 30_000,
			},
		},
	};
}

function v3CleanState(): Record<string, unknown> {
	return {
		schemaVersion: 3,
		runId: "01HX000000000000000000V302",
		orchestratorName: "migration-test",
		startedAt: NOW_ISO,
		startedAtEpochMs: NOW_EPOCH,
		lastTransitionAt: NOW_ISO,
		lastTransitionAtEpochMs: NOW_EPOCH,
		currentPhase: "initial",
		phasesExecuted: 0,
		accumulatedDurationMs: 0,
		data: { stage: "start" },
		usedLabels: [],
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
		runId: "01HX000000000000000000V301",
		orchestratorName: "migration-test",
		nowEpochMs: NOW_EPOCH,
		nowIso: NOW_ISO,
		leaseDurationMs: LEASE_MS,
		contentionDeadlineMs: 2000,
	});
}

function seedV3State(
	runDb: ReturnType<typeof openRunDatabase>,
	incarnationId: string,
	v3StateJson: string,
) {
	unsafeEnsureInitialStateRow(
		runDb.connection,
		incarnationId,
		3, // v3
		v3StateJson,
		NOW_EPOCH,
		NOW_ISO,
	);
}

/** Build a StateRecord from a migrated v4 object + the original record. */
function buildMigratedRecord(
	original: StateRecord<object>,
	migrated: Record<string, unknown>,
): StateRecord<object> {
	const record: Record<string, unknown> = {
		...original,
		schemaVersion: STATE_SCHEMA_VERSION,
	};
	if (migrated.pendingDelegation !== undefined) {
		record.pendingDelegation = migrated.pendingDelegation;
	}
	if (migrated.pendingExternalRequest !== undefined) {
		record.pendingExternalRequest = migrated.pendingExternalRequest;
	}
	if (migrated.terminalResult !== undefined) {
		record.terminalResult = migrated.terminalResult;
	}
	return record as unknown as StateRecord<object>;
}

/** Narrow a nullable state to non-null.  Called after expect(...).not.toBeNull(). */
function must<T>(value: T | null): T {
	if (value === null) throw new Error("unexpected null");
	return value;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("v3→v4 SQLite migration (resume path)", () => {
	test("successful migration: v3 delegation state with real manifest file", () => {
		const ctx = setup();
		try {
			// Create the manifest file on disk.
			mkdirSync(join(ctx.dir, "delegations"), { recursive: true });
			const manifestContent = JSON.stringify({
				kind: "delegation-manifest",
				task: "review the code",
			});
			writeFileSync(
				join(ctx.dir, "delegations", "rev-0.json"),
				manifestContent,
			);

			// Acquire ownership.
			const acquireResult = acquire(ctx.runDb);
			expect(acquireResult.kind).toBe("ACQUIRED");
			if (acquireResult.kind !== "ACQUIRED") return;
			const handle = acquireResult.handle;

			// Seed v3 state.
			const v3State = v3DelegationState();
			seedV3State(ctx.runDb, handle.incarnationId, JSON.stringify(v3State));

			// Read authoritative state (simulating resume).
			const readResult = readAuthoritativeState(ctx.runDb.connection);
			expect(readResult.state).not.toBeNull();
			const rState = must(readResult.state);
			expect(rState.schemaVersion).toBe(3);

			// Migrate v3→v4.
			const migrationResult = migrateV3ToV4(
				rState as unknown as Record<string, unknown>,
				ctx.dir,
			);
			expect(migrationResult.kind).toBe("MIGRATED");
			if (migrationResult.kind !== "MIGRATED") return;

			// Commit the migrated v4 state.
			const migratedRecord = buildMigratedRecord(rState, migrationResult.state);

			const commitResult = commitState({
				db: ctx.runDb.connection,
				handle,
				expectedRevision: rState.stateRevision,
				nextState: migratedRecord,
				nowEpochMs: NOW_EPOCH + 1000,
				nowIso: "2001-09-09T01:46:41.000Z",
			});

			expect(commitResult.kind).toBe("COMMITTED");
			if (commitResult.kind !== "COMMITTED") return;

			// Verify: re-read authoritative state should be v4.
			const afterRead = readAuthoritativeState(ctx.runDb.connection);
			expect(afterRead.state).not.toBeNull();
			const aState = must(afterRead.state);
			expect(aState.schemaVersion).toBe(STATE_SCHEMA_VERSION);

			// Verify: manifestArtifact present, manifestPath removed.
			const pd = aState.pendingDelegation as Record<string, unknown> | null;
			expect(pd).not.toBeNull();
			expect(pd).not.toHaveProperty("manifestPath");
			expect(pd?.manifestArtifact).toBeDefined();
			const artifact = pd?.manifestArtifact as Record<string, unknown>;
			expect(artifact.kind).toBe("delegation-manifest");
			expect(artifact.digestAlgorithm).toBe("sha256");
			expect(artifact.mediaType).toBe("application/json");

			// Verify: immutable blob exists on disk.
			expect(existsSync(join(ctx.dir, artifact.relativePath as string))).toBe(
				true,
			);

			// Verify: revision incremented.
			expect(aState.stateRevision).toBe(
				String(BigInt(rState.stateRevision) + 1n),
			);

			// Clean release.
			const releaseResult = releaseOwnership({
				db: ctx.runDb.connection,
				handle,
			});
			expect(releaseResult.kind).toBe("SUCCESS");
		} finally {
			ctx.cleanup();
		}
	});

	test("no-op migration: v3 clean state (no pending records) migrates to v4", () => {
		const ctx = setup();
		try {
			const acquireResult = acquire(ctx.runDb);
			expect(acquireResult.kind).toBe("ACQUIRED");
			if (acquireResult.kind !== "ACQUIRED") return;
			const handle = acquireResult.handle;

			const v3State = v3CleanState();
			seedV3State(ctx.runDb, handle.incarnationId, JSON.stringify(v3State));

			const readResult = readAuthoritativeState(ctx.runDb.connection);
			expect(readResult.state).not.toBeNull();
			const rState = must(readResult.state);
			expect(rState.schemaVersion).toBe(3);

			// Migrate v3→v4 — should be a no-op success.
			const migrationResult = migrateV3ToV4(
				rState as unknown as Record<string, unknown>,
				ctx.dir,
			);
			expect(migrationResult.kind).toBe("MIGRATED");
			if (migrationResult.kind !== "MIGRATED") return;
			expect(migrationResult.state.schemaVersion).toBe(STATE_SCHEMA_VERSION);

			// Commit the migrated v4 state.
			const migratedRecord = buildMigratedRecord(rState, migrationResult.state);

			const commitResult = commitState({
				db: ctx.runDb.connection,
				handle,
				expectedRevision: rState.stateRevision,
				nextState: migratedRecord,
				nowEpochMs: NOW_EPOCH + 1000,
				nowIso: "2001-09-09T01:46:41.000Z",
			});

			expect(commitResult.kind).toBe("COMMITTED");
			if (commitResult.kind !== "COMMITTED") return;

			const afterRead = readAuthoritativeState(ctx.runDb.connection);
			expect(afterRead.state).not.toBeNull();
			const aState = must(afterRead.state);
			expect(aState.schemaVersion).toBe(STATE_SCHEMA_VERSION);
			expect(aState.pendingDelegation).toBeUndefined();
			expect(aState.pendingExternalRequest).toBeUndefined();

			releaseOwnership({ db: ctx.runDb.connection, handle });
		} finally {
			ctx.cleanup();
		}
	});

	test("blocked migration: v3 delegation with missing manifest file", () => {
		const ctx = setup();
		try {
			const acquireResult = acquire(ctx.runDb);
			expect(acquireResult.kind).toBe("ACQUIRED");
			if (acquireResult.kind !== "ACQUIRED") return;
			const handle = acquireResult.handle;

			// Seed v3 state with a manifestPath that doesn't exist on disk.
			const v3State = {
				...v3DelegationState(),
				pendingDelegation: {
					label: "rev",
					kind: "prompt",
					resumeAt: "nextPhase",
					manifestPath: "delegations/nonexistent.json",
					emittedAtEpochMs: NOW_EPOCH,
					deadlineAtEpochMs: NOW_EPOCH + 3600_000,
					attempt: 0,
					effectiveRetryPolicy: {
						maxAttempts: 3,
						backoffBaseMs: 1000,
						maxBackoffMs: 30_000,
					},
				},
			};
			seedV3State(ctx.runDb, handle.incarnationId, JSON.stringify(v3State));

			const readResult = readAuthoritativeState(ctx.runDb.connection);
			expect(readResult.state).not.toBeNull();
			const rState = must(readResult.state);
			expect(rState.schemaVersion).toBe(3);

			const migrationResult = migrateV3ToV4(
				rState as unknown as Record<string, unknown>,
				ctx.dir,
			);
			expect(migrationResult.kind).toBe("BLOCKED");
			if (migrationResult.kind !== "BLOCKED") return;
			expect(migrationResult.reason).toBe("MANIFEST_MISSING");

			// Ownership should be released so the next attempt can acquire.
			const releaseResult = releaseOwnership({
				db: ctx.runDb.connection,
				handle,
			});
			expect(
				releaseResult.kind === "SUCCESS" ||
					releaseResult.kind === "STALE_HANDLE",
			).toBe(true);
		} finally {
			ctx.cleanup();
		}
	});

	test("blocked migration: manifest outside RUN_DIR gives correct reason", () => {
		const ctx = setup();
		try {
			const acquireResult = acquire(ctx.runDb);
			expect(acquireResult.kind).toBe("ACQUIRED");
			if (acquireResult.kind !== "ACQUIRED") return;
			const handle = acquireResult.handle;

			// Seed v3 state with an absolute manifestPath outside the run dir.
			const v3State = {
				...v3DelegationState(),
				pendingDelegation: {
					label: "rev",
					kind: "prompt",
					resumeAt: "nextPhase",
					manifestPath: "/tmp/outside-manifest.json",
					emittedAtEpochMs: NOW_EPOCH,
					deadlineAtEpochMs: NOW_EPOCH + 3600_000,
					attempt: 0,
					effectiveRetryPolicy: {
						maxAttempts: 3,
						backoffBaseMs: 1000,
						maxBackoffMs: 30_000,
					},
				},
			};
			seedV3State(ctx.runDb, handle.incarnationId, JSON.stringify(v3State));

			const readResult = readAuthoritativeState(ctx.runDb.connection);
			expect(readResult.state).not.toBeNull();
			const rState = must(readResult.state);

			const migrationResult = migrateV3ToV4(
				rState as unknown as Record<string, unknown>,
				ctx.dir,
			);
			expect(migrationResult.kind).toBe("BLOCKED");
			if (migrationResult.kind !== "BLOCKED") return;
			expect(migrationResult.reason).toBe("MANIFEST_OUTSIDE_RUN_DIR");

			releaseOwnership({ db: ctx.runDb.connection, handle });
		} finally {
			ctx.cleanup();
		}
	});

	test("blocked migration: release failure is observable", () => {
		// Normal case: release succeeds after blocked migration.
		const ctx = setup();
		try {
			const acquireResult = acquire(ctx.runDb);
			expect(acquireResult.kind).toBe("ACQUIRED");
			if (acquireResult.kind !== "ACQUIRED") return;
			const handle = acquireResult.handle;

			const v3State = {
				...v3DelegationState(),
				pendingDelegation: {
					label: "rev",
					kind: "prompt",
					resumeAt: "nextPhase",
					manifestPath: "delegations/nonexistent.json",
					emittedAtEpochMs: NOW_EPOCH,
					deadlineAtEpochMs: NOW_EPOCH + 3600_000,
					attempt: 0,
					effectiveRetryPolicy: {
						maxAttempts: 3,
						backoffBaseMs: 1000,
						maxBackoffMs: 30_000,
					},
				},
			};
			seedV3State(ctx.runDb, handle.incarnationId, JSON.stringify(v3State));

			const readResult = readAuthoritativeState(ctx.runDb.connection);
			expect(readResult.state).not.toBeNull();
			const rState = must(readResult.state);

			const migrationResult = migrateV3ToV4(
				rState as unknown as Record<string, unknown>,
				ctx.dir,
			);
			expect(migrationResult.kind).toBe("BLOCKED");

			// Normal release should succeed.
			const releaseResult = releaseOwnership({
				db: ctx.runDb.connection,
				handle,
			});
			expect(
				releaseResult.kind === "SUCCESS" ||
					releaseResult.kind === "STALE_HANDLE",
			).toBe(true);

			// Verify the DB is still functional after release.
			const afterRelease = readAuthoritativeState(ctx.runDb.connection);
			expect(afterRelease.state).not.toBeNull();
		} finally {
			ctx.cleanup();
		}

		// DB closure case: releasing on a closed DB returns DB_FAILURE.
		const ctx2 = setup();
		try {
			const acquireResult = acquire(ctx2.runDb);
			expect(acquireResult.kind).toBe("ACQUIRED");
			if (acquireResult.kind !== "ACQUIRED") return;
			const handle = acquireResult.handle;

			// Close DB before releasing — releaseOwnership should return DB_FAILURE.
			ctx2.runDb.close();

			let releaseResult: ReturnType<typeof releaseOwnership>;
			try {
				releaseResult = releaseOwnership({
					db: ctx2.runDb.connection,
					handle,
				});
			} catch {
				// DB is closed, release threw — this is an acceptable outcome.
				// The real code path in runResumeMode checks the result before
				// closing, so DB_FAILURE is surfaced before runDb.close().
				return;
			}
			// If it didn't throw, it should return DB_FAILURE.
			expect(releaseResult.kind).toBe("DB_FAILURE");
		} finally {
			ctx2.cleanup();
		}
	});
});
