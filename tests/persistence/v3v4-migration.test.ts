import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
// v3→v4 SQLite migration integration tests.
//
// Exercises the resume-mode migration path: open DB → acquire →
// read authoritative state → migrate v3→v4 → commit → verify.
// Does NOT go through runOrchestrator (which is a process-level entrypoint).
import { describe, test } from "node:test";
import { STATE_SCHEMA_VERSION } from "../../src/constants.js";
import { nodeSqliteDriver } from "../../src/persistence/sqlite/node-sqlite-driver.js";
import {
	acquireOwnership,
	releaseOwnership,
} from "../../src/persistence/sqlite/ownership.js";
import { openRunDatabase } from "../../src/persistence/sqlite/run-database.js";
import {
	commitState,
	readAuthoritativeState,
	type StateRecord,
} from "../../src/persistence/sqlite/run-state-store.js";
import { migrateV3ToV4 } from "../../src/services/state-io.js";
import {
	buildEntrypointSource,
	countProtocolBlocks,
	createE2EWorkspace,
	parseSingleProtocolBlock,
	readJsonFile,
} from "../helpers/e2e-process.js";
import { cleanupTempDir, makeTempDir } from "../helpers/temp-run-dir.js";
import { unsafeEnsureInitialStateRow } from "../helpers/unsafe-state-seed.js";

const LEASE_MS = 30 * 60 * 1000;
const NOW_EPOCH = 1000000000000;
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
			deadlineAtEpochMs: NOW_EPOCH + 3600000,
			attempt: 0,
			effectiveRetryPolicy: {
				maxAttempts: 3,
				backoffBaseMs: 1000,
				maxBackoffMs: 30000,
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
function acquire(runDb: ReturnType<typeof openRunDatabase>) {
	return acquireOwnership({
		db: runDb.connection,
		runId: "01HX000000000000000000V301",
		orchestratorName: "migration-test",
		nowEpochMs: NOW_EPOCH,
		nowIso: NOW_ISO,
		leaseDurationMs: LEASE_MS,
		contentionDeadlineMs: 2000,
		leaseClockEpochMs: () => NOW_EPOCH,
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
/** Narrow a nullable state after the explicit non-null assertion. */
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
			assert.strictEqual(acquireResult.kind, "ACQUIRED");
			if (acquireResult.kind !== "ACQUIRED") return;
			const handle = acquireResult.handle;
			// Seed v3 state.
			const v3State = v3DelegationState();
			seedV3State(ctx.runDb, handle.incarnationId, JSON.stringify(v3State));
			// Read authoritative state (simulating resume).
			const readResult = readAuthoritativeState(ctx.runDb.connection);
			assert.notStrictEqual(readResult.state, null);
			const rState = must(readResult.state);
			assert.strictEqual(rState.schemaVersion, 3);
			// Migrate v3→v4.
			const migrationResult = migrateV3ToV4(
				rState as unknown as Record<string, unknown>,
				ctx.dir,
			);
			assert.strictEqual(migrationResult.kind, "MIGRATED");
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
				leaseClockEpochMs: () => NOW_EPOCH,
			});
			assert.strictEqual(commitResult.kind, "COMMITTED");
			if (commitResult.kind !== "COMMITTED") return;
			// Verify: re-read authoritative state should be v4.
			const afterRead = readAuthoritativeState(ctx.runDb.connection);
			assert.notStrictEqual(afterRead.state, null);
			const aState = must(afterRead.state);
			assert.strictEqual(aState.schemaVersion, STATE_SCHEMA_VERSION);
			// Verify: manifestArtifact present, manifestPath removed.
			const pd = aState.pendingDelegation as Record<string, unknown> | null;
			assert.notStrictEqual(pd, null);
			assert.ok(!("manifestPath" in Object(pd)));
			assert.notStrictEqual(pd?.manifestArtifact, undefined);
			const artifact = pd?.manifestArtifact as Record<string, unknown>;
			assert.strictEqual(artifact.kind, "delegation-manifest");
			assert.strictEqual(artifact.digestAlgorithm, "sha256");
			assert.strictEqual(artifact.mediaType, "application/json");
			// Verify: immutable blob exists on disk.
			assert.strictEqual(
				existsSync(join(ctx.dir, artifact.relativePath as string)),
				true,
			);
			// Verify: revision incremented.
			assert.strictEqual(
				aState.stateRevision,
				String(BigInt(rState.stateRevision) + 1n),
			);
			// Clean release.
			const releaseResult = releaseOwnership({
				db: ctx.runDb.connection,
				handle,
			});
			assert.strictEqual(releaseResult.kind, "SUCCESS");
		} finally {
			ctx.cleanup();
		}
	});
	test("no-op migration: v3 clean state (no pending records) migrates to v4", () => {
		const ctx = setup();
		try {
			const acquireResult = acquire(ctx.runDb);
			assert.strictEqual(acquireResult.kind, "ACQUIRED");
			if (acquireResult.kind !== "ACQUIRED") return;
			const handle = acquireResult.handle;
			const v3State = v3CleanState();
			seedV3State(ctx.runDb, handle.incarnationId, JSON.stringify(v3State));
			const readResult = readAuthoritativeState(ctx.runDb.connection);
			assert.notStrictEqual(readResult.state, null);
			const rState = must(readResult.state);
			assert.strictEqual(rState.schemaVersion, 3);
			// Migrate v3→v4 — should be a no-op success.
			const migrationResult = migrateV3ToV4(
				rState as unknown as Record<string, unknown>,
				ctx.dir,
			);
			assert.strictEqual(migrationResult.kind, "MIGRATED");
			if (migrationResult.kind !== "MIGRATED") return;
			assert.strictEqual(
				migrationResult.state.schemaVersion,
				STATE_SCHEMA_VERSION,
			);
			// Commit the migrated v4 state.
			const migratedRecord = buildMigratedRecord(rState, migrationResult.state);
			const commitResult = commitState({
				db: ctx.runDb.connection,
				handle,
				expectedRevision: rState.stateRevision,
				nextState: migratedRecord,
				nowEpochMs: NOW_EPOCH + 1000,
				nowIso: "2001-09-09T01:46:41.000Z",
				leaseClockEpochMs: () => NOW_EPOCH,
			});
			assert.strictEqual(commitResult.kind, "COMMITTED");
			if (commitResult.kind !== "COMMITTED") return;
			const afterRead = readAuthoritativeState(ctx.runDb.connection);
			assert.notStrictEqual(afterRead.state, null);
			const aState = must(afterRead.state);
			assert.strictEqual(aState.schemaVersion, STATE_SCHEMA_VERSION);
			assert.strictEqual(aState.pendingDelegation, undefined);
			assert.strictEqual(aState.pendingExternalRequest, undefined);
			releaseOwnership({ db: ctx.runDb.connection, handle });
		} finally {
			ctx.cleanup();
		}
	});
	test("blocked migration: v3 delegation with missing manifest file", () => {
		const ctx = setup();
		try {
			const acquireResult = acquire(ctx.runDb);
			assert.strictEqual(acquireResult.kind, "ACQUIRED");
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
					deadlineAtEpochMs: NOW_EPOCH + 3600000,
					attempt: 0,
					effectiveRetryPolicy: {
						maxAttempts: 3,
						backoffBaseMs: 1000,
						maxBackoffMs: 30000,
					},
				},
			};
			seedV3State(ctx.runDb, handle.incarnationId, JSON.stringify(v3State));
			const readResult = readAuthoritativeState(ctx.runDb.connection);
			assert.notStrictEqual(readResult.state, null);
			const rState = must(readResult.state);
			assert.strictEqual(rState.schemaVersion, 3);
			const migrationResult = migrateV3ToV4(
				rState as unknown as Record<string, unknown>,
				ctx.dir,
			);
			assert.strictEqual(migrationResult.kind, "BLOCKED");
			if (migrationResult.kind !== "BLOCKED") return;
			assert.strictEqual(migrationResult.reason, "MANIFEST_MISSING");
			// Ownership should be released so the next attempt can acquire.
			const releaseResult = releaseOwnership({
				db: ctx.runDb.connection,
				handle,
			});
			assert.strictEqual(
				releaseResult.kind === "SUCCESS" ||
					releaseResult.kind === "STALE_HANDLE",
				true,
			);
		} finally {
			ctx.cleanup();
		}
	});
	test("blocked migration: manifest outside RUN_DIR gives correct reason", () => {
		const ctx = setup();
		try {
			const acquireResult = acquire(ctx.runDb);
			assert.strictEqual(acquireResult.kind, "ACQUIRED");
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
					deadlineAtEpochMs: NOW_EPOCH + 3600000,
					attempt: 0,
					effectiveRetryPolicy: {
						maxAttempts: 3,
						backoffBaseMs: 1000,
						maxBackoffMs: 30000,
					},
				},
			};
			seedV3State(ctx.runDb, handle.incarnationId, JSON.stringify(v3State));
			const readResult = readAuthoritativeState(ctx.runDb.connection);
			assert.notStrictEqual(readResult.state, null);
			const rState = must(readResult.state);
			const migrationResult = migrateV3ToV4(
				rState as unknown as Record<string, unknown>,
				ctx.dir,
			);
			assert.strictEqual(migrationResult.kind, "BLOCKED");
			if (migrationResult.kind !== "BLOCKED") return;
			assert.strictEqual(migrationResult.reason, "MANIFEST_OUTSIDE_RUN_DIR");
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
			assert.strictEqual(acquireResult.kind, "ACQUIRED");
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
					deadlineAtEpochMs: NOW_EPOCH + 3600000,
					attempt: 0,
					effectiveRetryPolicy: {
						maxAttempts: 3,
						backoffBaseMs: 1000,
						maxBackoffMs: 30000,
					},
				},
			};
			seedV3State(ctx.runDb, handle.incarnationId, JSON.stringify(v3State));
			const readResult = readAuthoritativeState(ctx.runDb.connection);
			assert.notStrictEqual(readResult.state, null);
			const rState = must(readResult.state);
			const migrationResult = migrateV3ToV4(
				rState as unknown as Record<string, unknown>,
				ctx.dir,
			);
			assert.strictEqual(migrationResult.kind, "BLOCKED");
			// Normal release should succeed.
			const releaseResult = releaseOwnership({
				db: ctx.runDb.connection,
				handle,
			});
			assert.strictEqual(
				releaseResult.kind === "SUCCESS" ||
					releaseResult.kind === "STALE_HANDLE",
				true,
			);
			// Verify the DB is still functional after release.
			const afterRelease = readAuthoritativeState(ctx.runDb.connection);
			assert.notStrictEqual(afterRelease.state, null);
		} finally {
			ctx.cleanup();
		}
		// DB closure case: releasing on a closed DB returns DB_FAILURE.
		const ctx2 = setup();
		try {
			const acquireResult = acquire(ctx2.runDb);
			assert.strictEqual(acquireResult.kind, "ACQUIRED");
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
			assert.strictEqual(releaseResult.kind, "DB_FAILURE");
		} finally {
			ctx2.cleanup();
		}
	});
});
// ---------------------------------------------------------------------------
// End-to-end: full runOrchestrator --resume chain
// ---------------------------------------------------------------------------
//
// These tests go through the real runOrchestrator process-level entrypoint
// and exercise the complete chain when the DB already exists with a v3 state:
//
//   v3 authoritative state in SQLite (state_revision = 0)
//   → runOrchestrator --resume
//   → readAuthoritativeState → migrateV3ToV4 → commit v4 (state_revision = 1)
//   → projection → identity checks → setup
//   → runHandleResume → enterDispatchLoopWithResults
//   → business / terminal transition (state_revision = 2)
//
// The legacy path (no DB → readStateSnapshot → seed → resume) is also
// covered: the migration happens inside readStateSnapshot, which would
// mask bugs in the hot migration path inside the try block.
//
// These tests would have caught the double-release and error-classification
// bugs that the unit-level migration tests (above) could not detect.
describe("v3→v4 migration via runOrchestrator --resume (E2E)", () => {
	const NOW_EPOCH = 1000000000000;
	const NOW_ISO = "2001-09-09T01:46:40.000Z";
	const LEASE_MS = 30 * 60 * 1000;
	const CONTENTION_DEADLINE_MS = 2000;
	/** Build a v3 state object (pending delegation with manifestPath). */
	function v3DelegationState(runId: string, orchestratorName: string) {
		return {
			schemaVersion: 3,
			runId,
			orchestratorName,
			startedAt: NOW_ISO,
			startedAtEpochMs: NOW_EPOCH,
			lastTransitionAt: NOW_ISO,
			lastTransitionAtEpochMs: NOW_EPOCH,
			currentPhase: "fanout",
			phasesExecuted: 1,
			accumulatedDurationMs: 100,
			data: { approved: false, reviewed: false },
			usedLabels: ["review"],
			pendingDelegation: {
				label: "review",
				kind: "prompt",
				resumeAt: "collect",
				manifestPath: "delegations/review-0.json",
				emittedAtEpochMs: NOW_EPOCH,
				deadlineAtEpochMs: NOW_EPOCH + 600000,
				attempt: 0,
				effectiveRetryPolicy: {
					maxAttempts: 3,
					backoffBaseMs: 1000,
					maxBackoffMs: 30000,
				},
			},
		};
	}
	test("full chain via dbExists: v3 in SQLite → migration commit (rev 1) → terminal (rev 2)", async () => {
		const workspace = createE2EWorkspace("v3v4-e2e-");
		const orchestratorName = "e2e-v3v4";
		const runId = "01HX0000000000000000000V3E";
		try {
			// 1. Write the entrypoint.
			const entrypoint = workspace.writeEntrypoint(
				"v3v4-e2e.ts",
				buildEntrypointSource(`
interface State { approved: boolean; reviewed: boolean }

await runOrchestrator<State>({
	name: ${JSON.stringify(orchestratorName)},
	initial: "fanout",
	initialState: { approved: false, reviewed: false },
	resumeCommand: (runId: string) => \`node \${import.meta.filename} --run-id \${runId} --resume\`,
	phases: {
		fanout: definePhase<State>(async (_state, io) =>
			io.delegatePrompt("review the code", "collect", { reviewed: false })
		),
		collect: definePhase<State>(async (_state, io) => {
			const result = io.consumePendingResult(z.object({ approved: z.boolean() }));
			return io.done({ approved: result.approved, reviewed: true });
		}),
	},
});
`),
			);
			// 2. Manually construct the run directory.
			const runDir = join(workspace.runDirRoot, orchestratorName, runId);
			mkdirSync(runDir, { recursive: true });
			mkdirSync(join(runDir, "delegations"), { recursive: true });
			mkdirSync(join(runDir, "results"), { recursive: true });
			mkdirSync(join(runDir, "artifacts", "sha256"), { recursive: true });
			mkdirSync(join(runDir, "external-requests"), { recursive: true });
			mkdirSync(join(runDir, "external-results"), { recursive: true });
			mkdirSync(join(runDir, "accepted-external-resolutions"), {
				recursive: true,
			});
			// 3. Write the manifest file (referenced by manifestPath).
			const manifestContent = JSON.stringify({
				kind: "delegation-manifest",
				task: "review the code",
			});
			writeFileSync(
				join(runDir, "delegations", "review-0.json"),
				manifestContent,
			);
			// 4. Write the result file so runHandleResume can consume it.
			writeFileSync(
				join(runDir, "results", "review-0.json"),
				JSON.stringify({ approved: true }),
			);
			// 5. Pre-seed a SQLite DB containing a v3 authoritative state row.
			//    This forces runResumeMode into the dbExists=true path, where
			//    readAuthoritativeState returns v3 and migrateV3ToV4 + commitState
			//    execute inside the big try block.
			const dbPath = join(runDir, "turnlock.sqlite3");
			const seedDb = openRunDatabase({
				driver: nodeSqliteDriver,
				dbPath,
				busyTimeoutMs: 500,
			});
			// Pre-create incarnation.
			seedDb.connection
				.prepare(`INSERT INTO run_incarnation
					 (singleton, run_id, incarnation_id, orchestrator_name,
					  created_at_epoch_ms, created_at_iso)
					 VALUES (1, ?, ?, ?, ?, ?)`)
				.run(runId, runId, orchestratorName, NOW_EPOCH, NOW_ISO);
			// Acquire ownership (needed for ensureInitialStateRow fence).
			const acquireResult = acquireOwnership({
				db: seedDb.connection,
				runId,
				orchestratorName,
				nowEpochMs: NOW_EPOCH,
				nowIso: NOW_ISO,
				leaseDurationMs: LEASE_MS,
				contentionDeadlineMs: CONTENTION_DEADLINE_MS,
				leaseClockEpochMs: () => NOW_EPOCH,
			});
			assert.strictEqual(acquireResult.kind, "ACQUIRED");
			if (acquireResult.kind !== "ACQUIRED") return;
			// Seed the v3 state directly into SQLite (NOT through
			// seedLegacyStateToSqlite which would migrate first).
			const v3State = v3DelegationState(runId, orchestratorName);
			unsafeEnsureInitialStateRow(
				seedDb.connection,
				acquireResult.handle.incarnationId,
				3, // v3 schema version
				JSON.stringify(v3State),
				NOW_EPOCH,
				NOW_ISO,
			);
			// Verify the seeded state is v3.
			const preCheck = readAuthoritativeState(seedDb.connection);
			assert.ok(preCheck.state !== null);
			assert.strictEqual(preCheck.state.schemaVersion, 3);
			assert.strictEqual(preCheck.state.stateRevision, "0");
			// Release ownership so the resume process can acquire.
			releaseOwnership({
				db: seedDb.connection,
				handle: acquireResult.handle,
			});
			// Force a WAL checkpoint before close.
			seedDb.connection.exec("PRAGMA wal_checkpoint(TRUNCATE)");
			seedDb.close();
			// 6. Run the orchestrator in resume mode.
			const result = await workspace.runEntrypoint(
				entrypoint,
				["--resume", "--run-id", runId],
				{ timeoutMs: 15000 },
			);
			// 7. Verify: success, clean protocol.
			assert.strictEqual(result.exitCode, 0);
			assert.strictEqual(countProtocolBlocks(result.stdout), 1);
			const block = parseSingleProtocolBlock(result.stdout);
			assert.strictEqual(block.action, "DONE");
			assert.strictEqual(block.runId, runId);
			assert.strictEqual(block.fields.success, true);
			// 8. Verify: state.json (projected from SQLite) is v4.
			const state = readJsonFile<Record<string, unknown>>(
				join(runDir, "state.json"),
			);
			assert.strictEqual(state.schemaVersion, STATE_SCHEMA_VERSION);
			// 9. Verify: terminalResult present, pendingDelegation consumed.
			const terminalResult = state.terminalResult as
				| Record<string, unknown>
				| undefined;
			assert.notStrictEqual(terminalResult, undefined);
			assert.notStrictEqual(terminalResult?.outputArtifact, undefined);
			assert.strictEqual(state.pendingDelegation, undefined);
			// 10. Verify: the immutable manifest blob exists on disk at the
			//    expected relativePath derived from its SHA-256 digest.
			//    migrateV3ToV4 calls installArtifactBlob which writes
			//    artifacts/sha256/{hex[0:2]}/{hex[2:]}.json.
			const manifestDigest = createHash("sha256")
				.update(manifestContent)
				.digest("hex");
			const expectedBlobPath = join(
				runDir,
				"artifacts",
				"sha256",
				manifestDigest.slice(0, 2),
				`${manifestDigest.slice(2)}.json`,
			);
			assert.strictEqual(existsSync(expectedBlobPath), true);
			// Also verify the SQLite DB exists.
			assert.strictEqual(existsSync(dbPath), true);
			// 11. Verify: stateRevision = "2" — the definitive proof that both
			//     the migration commit AND the terminal transition committed.
			//
			//     Progression:
			//       unsafeEnsureInitialStateRow  → state_revision = 0  (seed)
			//       commitState (migration v3→v4) → state_revision = 1  (+1)
			//       commitState (terminal done)    → state_revision = 2  (+1)
			assert.strictEqual(state.stateRevision, "2");
			// 11a. Confirm the authoritative SQLite record agrees.
			const checkDb = openRunDatabase({
				driver: nodeSqliteDriver,
				dbPath,
				busyTimeoutMs: 500,
			});
			try {
				const authRead = readAuthoritativeState(checkDb.connection);
				assert.ok(authRead.state !== null);
				assert.strictEqual(authRead.state.schemaVersion, STATE_SCHEMA_VERSION);
				assert.strictEqual(authRead.state.stateRevision, "2");
				// Ownership released (FREE).
				const ownRow = checkDb.connection
					.prepare(
						"SELECT ownership_status FROM run_ownership WHERE singleton = 1",
					)
					.get() as
					| {
							ownership_status: string;
					  }
					| undefined;
				assert.strictEqual(ownRow?.ownership_status ?? "FREE", "FREE");
			} finally {
				checkDb.close();
			}
			// 12. Verify: terminal output correct.
			const output = readJsonFile<{
				approved: boolean;
				reviewed: boolean;
			}>(join(runDir, "output.json"));
			assert.strictEqual(output.approved, true);
			assert.strictEqual(output.reviewed, true);
			// 13. Verify: no protocol blocks on stderr.
			assert.ok(!result.stderr.includes("@@TURNLOCK@@"));
		} finally {
			workspace.cleanup();
		}
	});
	test("blocked migration via dbExists: v3 in SQLite + missing manifest → StateMigrationBlockedError", async () => {
		const workspace = createE2EWorkspace("v3v4-e2e-blocked-");
		const orchestratorName = "e2e-v3v4-blocked";
		const runId = "01HX000000000000000000B1KD";
		try {
			// 1. Write the entrypoint (same phase definitions as success test).
			const entrypoint = workspace.writeEntrypoint(
				"v3v4-e2e-blocked.ts",
				buildEntrypointSource(`
interface State { approved: boolean; reviewed: boolean }

await runOrchestrator<State>({
	name: ${JSON.stringify(orchestratorName)},
	initial: "fanout",
	initialState: { approved: false, reviewed: false },
	resumeCommand: (runId: string) => \`node \${import.meta.filename} --run-id \${runId} --resume\`,
	phases: {
		fanout: definePhase<State>(async (_state, io) =>
			io.delegatePrompt("review the code", "collect", { reviewed: false })
		),
		collect: definePhase<State>(async (_state, io) => {
			const result = io.consumePendingResult(z.object({ approved: z.boolean() }));
			return io.done({ approved: result.approved, reviewed: true });
		}),
	},
});
`),
			);
			// 2. Construct the run directory — manifest file is intentionally
			//    NOT created.  The v3 state references a manifestPath that
			//    does not exist on disk.
			const runDir = join(workspace.runDirRoot, orchestratorName, runId);
			mkdirSync(runDir, { recursive: true });
			mkdirSync(join(runDir, "delegations"), { recursive: true });
			mkdirSync(join(runDir, "results"), { recursive: true });
			mkdirSync(join(runDir, "artifacts", "sha256"), { recursive: true });
			mkdirSync(join(runDir, "external-requests"), { recursive: true });
			mkdirSync(join(runDir, "external-results"), { recursive: true });
			mkdirSync(join(runDir, "accepted-external-resolutions"), {
				recursive: true,
			});
			// 3. Pre-seed a SQLite DB containing a v3 state whose
			//    manifestPath points nowhere.
			const dbPath = join(runDir, "turnlock.sqlite3");
			const seedDb = openRunDatabase({
				driver: nodeSqliteDriver,
				dbPath,
				busyTimeoutMs: 500,
			});
			seedDb.connection
				.prepare(`INSERT INTO run_incarnation
					 (singleton, run_id, incarnation_id, orchestrator_name,
					  created_at_epoch_ms, created_at_iso)
					 VALUES (1, ?, ?, ?, ?, ?)`)
				.run(runId, runId, orchestratorName, NOW_EPOCH, NOW_ISO);
			const acquireResult = acquireOwnership({
				db: seedDb.connection,
				runId,
				orchestratorName,
				nowEpochMs: NOW_EPOCH,
				nowIso: NOW_ISO,
				leaseDurationMs: LEASE_MS,
				contentionDeadlineMs: CONTENTION_DEADLINE_MS,
				leaseClockEpochMs: () => NOW_EPOCH,
			});
			assert.strictEqual(acquireResult.kind, "ACQUIRED");
			if (acquireResult.kind !== "ACQUIRED") return;
			// Seed v3 state with manifestPath pointing to a non-existent file.
			const v3State = v3DelegationState(runId, orchestratorName);
			(v3State.pendingDelegation as Record<string, unknown>).manifestPath =
				"delegations/nonexistent.json";
			unsafeEnsureInitialStateRow(
				seedDb.connection,
				acquireResult.handle.incarnationId,
				3,
				JSON.stringify(v3State),
				NOW_EPOCH,
				NOW_ISO,
			);
			releaseOwnership({
				db: seedDb.connection,
				handle: acquireResult.handle,
			});
			// Force a WAL checkpoint so the next process opening this DB
			// does not hit SQLITE_BUSY.
			seedDb.connection.exec("PRAGMA wal_checkpoint(TRUNCATE)");
			seedDb.close();
			// 4. Run the orchestrator in resume mode — this MUST fail.
			const result = await workspace.runEntrypoint(
				entrypoint,
				["--resume", "--run-id", runId],
				{ timeoutMs: 15000 },
			);
			// 5. Verify: process failure, single clean ERROR block.
			assert.strictEqual(result.exitCode, 1);
			assert.strictEqual(countProtocolBlocks(result.stdout), 1);
			const block = parseSingleProtocolBlock(result.stdout);
			assert.strictEqual(block.action, "ERROR");
			assert.strictEqual(block.runId, runId);
			// 6. Verify: error is correctly classified as migration blocked.
			//    This is the assertion the old double-cleanup code would have
			//    failed — it masked StateMigrationBlockedError behind
			//    ProtocolError("Resume failed and ownership release also failed").
			assert.strictEqual(block.fields.errorKind, "state_migration_blocked");
			assert.ok(String(block.fields.message).includes("cannot be converted"));
			// 7. Verify: ownership was released — the single cleanup owner
			//    in the catch block did its job.  No double-release, no
			//    DB_FAILURE on a closed connection.
			const checkDb = openRunDatabase({
				driver: nodeSqliteDriver,
				dbPath,
				busyTimeoutMs: 500,
			});
			try {
				const ownRow = checkDb.connection
					.prepare(
						"SELECT ownership_status FROM run_ownership WHERE singleton = 1",
					)
					.get() as
					| {
							ownership_status: string;
					  }
					| undefined;
				assert.strictEqual(ownRow?.ownership_status ?? "FREE", "FREE");
			} finally {
				checkDb.close();
			}
			// 8. Verify: no protocol blocks on stderr.
			assert.ok(!result.stderr.includes("@@TURNLOCK@@"));
		} finally {
			workspace.cleanup();
		}
	});
	// -------------------------------------------------------------------
	// Legacy .lock inter-protocol guard
	// -------------------------------------------------------------------
	test("legacy .lock present + no DB → resume blocked, SQLite DB not created", async () => {
		const workspace = createE2EWorkspace("lock-guard-blocked-");
		const orchestratorName = "e2e-lock-guard";
		const runId = "01HX000000000000000000K0K1";
		try {
			// 1. Write entrypoint.
			const entrypoint = workspace.writeEntrypoint(
				"lock-guard-blocked.ts",
				buildEntrypointSource(`
interface State { approved: boolean; reviewed: boolean }

await runOrchestrator<State>({
	name: ${JSON.stringify(orchestratorName)},
	initial: "fanout",
	initialState: { approved: false, reviewed: false },
	resumeCommand: (runId: string) => \`node \${import.meta.filename} --run-id \${runId} --resume\`,
	phases: {
		fanout: definePhase<State>(async (_state, io) =>
			io.delegatePrompt("review the code", "collect", { reviewed: false })
		),
		collect: definePhase<State>(async (_state, io) => {
			const result = io.consumePendingResult(z.object({ approved: z.boolean() }));
			return io.done({ approved: result.approved, reviewed: true });
		}),
	},
});
`),
			);
			// 2. Construct the run directory with state.json (v4) + .lock,
			//    but NO turnlock.sqlite3.
			const runDir = join(workspace.runDirRoot, orchestratorName, runId);
			mkdirSync(runDir, { recursive: true });
			mkdirSync(join(runDir, "delegations"), { recursive: true });
			mkdirSync(join(runDir, "results"), { recursive: true });
			mkdirSync(join(runDir, "artifacts", "sha256"), { recursive: true });
			mkdirSync(join(runDir, "external-requests"), { recursive: true });
			mkdirSync(join(runDir, "external-results"), { recursive: true });
			mkdirSync(join(runDir, "accepted-external-resolutions"), {
				recursive: true,
			});
			// Write a valid state.json (v4) with pending delegation.
			const manifestContent = JSON.stringify({
				kind: "delegation-manifest",
				task: "review the code",
			});
			writeFileSync(
				join(runDir, "delegations", "review-0.json"),
				manifestContent,
			);
			// Create the manifest artifact blob so readStateSnapshot succeeds.
			const manifestDigest = createHash("sha256")
				.update(manifestContent)
				.digest("hex");
			const blobDir = join(
				runDir,
				"artifacts",
				"sha256",
				manifestDigest.slice(0, 2),
			);
			mkdirSync(blobDir, { recursive: true });
			writeFileSync(
				join(blobDir, `${manifestDigest.slice(2)}.json`),
				manifestContent,
			);
			const stateV4 = {
				schemaVersion: STATE_SCHEMA_VERSION,
				runId,
				orchestratorName,
				startedAt: NOW_ISO,
				startedAtEpochMs: NOW_EPOCH,
				lastTransitionAt: NOW_ISO,
				lastTransitionAtEpochMs: NOW_EPOCH,
				currentPhase: "fanout",
				phasesExecuted: 1,
				accumulatedDurationMs: 100,
				data: { approved: false, reviewed: false },
				usedLabels: ["review"],
				pendingDelegation: {
					label: "review",
					kind: "prompt",
					resumeAt: "collect",
					manifestArtifact: {
						kind: "delegation-manifest",
						digestAlgorithm: "sha256",
						digest: `sha256:${manifestDigest}`,
						relativePath: `artifacts/sha256/${manifestDigest.slice(0, 2)}/${manifestDigest.slice(2)}.json`,
						mediaType: "application/json",
						sizeBytes: manifestContent.length,
					},
					emittedAtEpochMs: NOW_EPOCH,
					deadlineAtEpochMs: NOW_EPOCH + 600000,
					attempt: 0,
					effectiveRetryPolicy: {
						maxAttempts: 3,
						backoffBaseMs: 1000,
						maxBackoffMs: 30000,
					},
				},
			};
			writeFileSync(join(runDir, "state.json"), JSON.stringify(stateV4));
			// Create the legacy .lock file — this is what we're testing.
			writeFileSync(
				join(runDir, ".lock"),
				"pid=99999\ntimestamp=1704067200000\n",
			);
			// Verify turnlock.sqlite3 does NOT exist.
			const dbPath = join(runDir, "turnlock.sqlite3");
			assert.strictEqual(existsSync(dbPath), false);
			// 3. Run the orchestrator in resume mode — MUST be blocked.
			const result = await workspace.runEntrypoint(
				entrypoint,
				["--resume", "--run-id", runId],
				{ timeoutMs: 15000 },
			);
			// 4. Verify: process failure, single clean ERROR block.
			assert.strictEqual(result.exitCode, 1);
			assert.strictEqual(countProtocolBlocks(result.stdout), 1);
			const block = parseSingleProtocolBlock(result.stdout);
			assert.strictEqual(block.action, "ERROR");
			assert.strictEqual(block.runId, runId);
			assert.strictEqual(
				block.fields.errorKind,
				"legacy_lock_migration_blocked",
			);
			assert.ok(String(block.fields.message).includes("Legacy ownership lock"));
			// 5. Verify: turnlock.sqlite3 was NOT created.
			assert.strictEqual(existsSync(dbPath), false);
			// 6. Verify: no protocol blocks on stderr.
			assert.ok(!result.stderr.includes("@@TURNLOCK@@"));
		} finally {
			workspace.cleanup();
		}
	});
	test("legacy .lock absent + no DB → normal migration proceeds, SQLite ownership acquired", async () => {
		const workspace = createE2EWorkspace("lock-guard-allowed-");
		const orchestratorName = "e2e-lock-guard-ok";
		const runId = "01HX000000000000000000K0K2";
		try {
			// 1. Write entrypoint.
			const entrypoint = workspace.writeEntrypoint(
				"lock-guard-ok.ts",
				buildEntrypointSource(`
interface State { approved: boolean; reviewed: boolean }

await runOrchestrator<State>({
	name: ${JSON.stringify(orchestratorName)},
	initial: "fanout",
	initialState: { approved: false, reviewed: false },
	resumeCommand: (runId: string) => \`node \${import.meta.filename} --run-id \${runId} --resume\`,
	phases: {
		fanout: definePhase<State>(async (_state, io) =>
			io.delegatePrompt("review the code", "collect", { reviewed: false })
		),
		collect: definePhase<State>(async (_state, io) => {
			const result = io.consumePendingResult(z.object({ approved: z.boolean() }));
			return io.done({ approved: result.approved, reviewed: true });
		}),
	},
});
`),
			);
			// 2. Construct the run directory with state.json (v4) but NO .lock
			//    and NO turnlock.sqlite3.
			const runDir = join(workspace.runDirRoot, orchestratorName, runId);
			mkdirSync(runDir, { recursive: true });
			mkdirSync(join(runDir, "delegations"), { recursive: true });
			mkdirSync(join(runDir, "results"), { recursive: true });
			mkdirSync(join(runDir, "artifacts", "sha256"), { recursive: true });
			mkdirSync(join(runDir, "external-requests"), { recursive: true });
			mkdirSync(join(runDir, "external-results"), { recursive: true });
			mkdirSync(join(runDir, "accepted-external-resolutions"), {
				recursive: true,
			});
			// Write manifest file.
			const manifestContent = JSON.stringify({
				kind: "delegation-manifest",
				task: "review the code",
			});
			writeFileSync(
				join(runDir, "delegations", "review-0.json"),
				manifestContent,
			);
			// Write result file so runHandleResume can consume it.
			writeFileSync(
				join(runDir, "results", "review-0.json"),
				JSON.stringify({ approved: true }),
			);
			// Create manifest artifact blob.
			const manifestDigest = createHash("sha256")
				.update(manifestContent)
				.digest("hex");
			const blobDir = join(
				runDir,
				"artifacts",
				"sha256",
				manifestDigest.slice(0, 2),
			);
			mkdirSync(blobDir, { recursive: true });
			writeFileSync(
				join(blobDir, `${manifestDigest.slice(2)}.json`),
				manifestContent,
			);
			const stateV4 = {
				schemaVersion: STATE_SCHEMA_VERSION,
				runId,
				orchestratorName,
				startedAt: NOW_ISO,
				startedAtEpochMs: NOW_EPOCH,
				lastTransitionAt: NOW_ISO,
				lastTransitionAtEpochMs: NOW_EPOCH,
				currentPhase: "fanout",
				phasesExecuted: 1,
				accumulatedDurationMs: 100,
				data: { approved: false, reviewed: false },
				usedLabels: ["review"],
				pendingDelegation: {
					label: "review",
					kind: "prompt",
					resumeAt: "collect",
					manifestArtifact: {
						kind: "delegation-manifest",
						digestAlgorithm: "sha256",
						digest: `sha256:${manifestDigest}`,
						relativePath: `artifacts/sha256/${manifestDigest.slice(0, 2)}/${manifestDigest.slice(2)}.json`,
						mediaType: "application/json",
						sizeBytes: manifestContent.length,
					},
					emittedAtEpochMs: NOW_EPOCH,
					deadlineAtEpochMs: NOW_EPOCH + 600000,
					attempt: 0,
					effectiveRetryPolicy: {
						maxAttempts: 3,
						backoffBaseMs: 1000,
						maxBackoffMs: 30000,
					},
				},
			};
			writeFileSync(join(runDir, "state.json"), JSON.stringify(stateV4));
			// Explicitly verify .lock is absent.
			const dbPath = join(runDir, "turnlock.sqlite3");
			assert.strictEqual(existsSync(join(runDir, ".lock")), false);
			assert.strictEqual(existsSync(dbPath), false);
			// 3. Run the orchestrator in resume mode — MUST succeed.
			const result = await workspace.runEntrypoint(
				entrypoint,
				["--resume", "--run-id", runId],
				{ timeoutMs: 15000 },
			);
			// 4. Verify: success, DONE protocol block.
			assert.strictEqual(result.exitCode, 0);
			assert.strictEqual(countProtocolBlocks(result.stdout), 1);
			const block = parseSingleProtocolBlock(result.stdout);
			assert.strictEqual(block.action, "DONE");
			assert.strictEqual(block.runId, runId);
			assert.strictEqual(block.fields.success, true);
			// 5. Verify: turnlock.sqlite3 WAS created.
			assert.strictEqual(existsSync(dbPath), true);
			// 6. Verify: state.json projected from SQLite.
			const state = readJsonFile<Record<string, unknown>>(
				join(runDir, "state.json"),
			);
			assert.strictEqual(state.schemaVersion, STATE_SCHEMA_VERSION);
			assert.strictEqual(state.runId, runId);
			// 7. Verify: DB ownership is released (FREE).
			const checkDb = openRunDatabase({
				driver: nodeSqliteDriver,
				dbPath,
				busyTimeoutMs: 500,
			});
			try {
				const ownRow = checkDb.connection
					.prepare(
						"SELECT ownership_status FROM run_ownership WHERE singleton = 1",
					)
					.get() as
					| {
							ownership_status: string;
					  }
					| undefined;
				assert.strictEqual(ownRow?.ownership_status ?? "FREE", "FREE");
			} finally {
				checkDb.close();
			}
			// 8. Verify: no protocol blocks on stderr.
			assert.ok(!result.stderr.includes("@@TURNLOCK@@"));
		} finally {
			workspace.cleanup();
		}
	});
	// -------------------------------------------------------------------
	// Mixed ownership protocol detection (E2E)
	// -------------------------------------------------------------------
	test("DB present + .lock present → MixedOwnershipProtocolError, fail-closed", async () => {
		const workspace = createE2EWorkspace("mixed-own-e2e-");
		const orchestratorName = "e2e-mixed-own";
		const runId = "01HX0000000000000000000XD1";
		try {
			const entrypoint = workspace.writeEntrypoint(
				"mixed-own-e2e.ts",
				buildEntrypointSource(`
interface State { approved: boolean; reviewed: boolean }

await runOrchestrator<State>({
name: ${JSON.stringify(orchestratorName)},
initial: "fanout",
initialState: { approved: false, reviewed: false },
resumeCommand: (runId: string) => \`node \${import.meta.filename} --run-id \${runId} --resume\`,
phases: {
fanout: definePhase<State>(async (_state, io) =>
io.delegatePrompt("review the code", "collect", { reviewed: false })
),
collect: definePhase<State>(async (_state, io) => {
const result = io.consumePendingResult(z.object({ approved: z.boolean() }));
return io.done({ approved: result.approved, reviewed: true });
}),
},
});
`),
			);
			const runDir = join(workspace.runDirRoot, orchestratorName, runId);
			mkdirSync(runDir, { recursive: true });
			mkdirSync(join(runDir, "delegations"), { recursive: true });
			mkdirSync(join(runDir, "results"), { recursive: true });
			mkdirSync(join(runDir, "artifacts", "sha256"), { recursive: true });
			mkdirSync(join(runDir, "external-requests"), { recursive: true });
			mkdirSync(join(runDir, "external-results"), { recursive: true });
			mkdirSync(join(runDir, "accepted-external-resolutions"), {
				recursive: true,
			});
			// Pre-seed a SQLite DB with a valid authoritative state.
			const dbPath = join(runDir, "turnlock.sqlite3");
			const seedDb = openRunDatabase({
				driver: nodeSqliteDriver,
				dbPath,
				busyTimeoutMs: 500,
			});
			seedDb.connection
				.prepare(`INSERT INTO run_incarnation
					 (singleton, run_id, incarnation_id, orchestrator_name,
					  created_at_epoch_ms, created_at_iso)
					 VALUES (1, ?, ?, ?, ?, ?)`)
				.run(runId, runId, orchestratorName, NOW_EPOCH, NOW_ISO);
			const acquireResult = acquireOwnership({
				db: seedDb.connection,
				runId,
				orchestratorName,
				nowEpochMs: NOW_EPOCH,
				nowIso: NOW_ISO,
				leaseDurationMs: LEASE_MS,
				contentionDeadlineMs: CONTENTION_DEADLINE_MS,
				leaseClockEpochMs: () => NOW_EPOCH,
			});
			assert.strictEqual(acquireResult.kind, "ACQUIRED");
			if (acquireResult.kind !== "ACQUIRED") return;
			const v4State = {
				schemaVersion: STATE_SCHEMA_VERSION,
				runId,
				orchestratorName,
				startedAt: NOW_ISO,
				startedAtEpochMs: NOW_EPOCH,
				lastTransitionAt: NOW_ISO,
				lastTransitionAtEpochMs: NOW_EPOCH,
				currentPhase: "fanout",
				phasesExecuted: 1,
				accumulatedDurationMs: 100,
				data: { approved: false, reviewed: false },
				usedLabels: ["review"],
			};
			unsafeEnsureInitialStateRow(
				seedDb.connection,
				acquireResult.handle.incarnationId,
				STATE_SCHEMA_VERSION,
				JSON.stringify(v4State),
				NOW_EPOCH,
				NOW_ISO,
			);
			// Record authoritative state before .lock is introduced.
			const beforeRead = readAuthoritativeState(seedDb.connection);
			assert.ok(beforeRead.state !== null);
			const beforeDigest = beforeRead.digest;
			const beforeFence = seedDb.connection
				.prepare("SELECT fence_token FROM run_ownership WHERE singleton = 1")
				.get() as
				| {
						fence_token: number | bigint;
				  }
				| undefined;
			assert.ok(beforeFence !== undefined);
			const beforeRevision = beforeRead.state.stateRevision;
			releaseOwnership({
				db: seedDb.connection,
				handle: acquireResult.handle,
			});
			seedDb.connection.exec("PRAGMA wal_checkpoint(TRUNCATE)");
			seedDb.close();
			// Write the legacy .lock — creating the mixed state.
			writeFileSync(
				join(runDir, ".lock"),
				"pid=99999\ntimestamp=1704067200000\n",
			);
			// Run resume — MUST be blocked.
			const result = await workspace.runEntrypoint(
				entrypoint,
				["--resume", "--run-id", runId],
				{ timeoutMs: 15000 },
			);
			assert.strictEqual(result.exitCode, 1);
			assert.strictEqual(countProtocolBlocks(result.stdout), 1);
			const block = parseSingleProtocolBlock(result.stdout);
			assert.strictEqual(block.action, "ERROR");
			assert.strictEqual(block.runId, runId);
			assert.strictEqual(
				block.fields.errorKind,
				"mixed_ownership_protocol_detected",
			);
			assert.ok(String(block.fields.message).includes("coexist"));
			// Verify: no new authority granted.
			const checkDb = openRunDatabase({
				driver: nodeSqliteDriver,
				dbPath,
				busyTimeoutMs: 500,
			});
			try {
				const afterFence = checkDb.connection
					.prepare(
						"SELECT fence_token, ownership_status FROM run_ownership WHERE singleton = 1",
					)
					.get() as
					| {
							fence_token: number | bigint;
							ownership_status: string;
					  }
					| undefined;
				assert.ok(afterFence !== undefined);
				assert.strictEqual(
					typeof afterFence.fence_token === "bigint"
						? afterFence.fence_token
						: BigInt(afterFence.fence_token as number),
					typeof beforeFence.fence_token === "bigint"
						? beforeFence.fence_token
						: BigInt(beforeFence.fence_token as number),
				);
				const afterRead = readAuthoritativeState(checkDb.connection);
				assert.ok(afterRead.state !== null);
				assert.strictEqual(afterRead.state.stateRevision, beforeRevision);
				assert.strictEqual(afterRead.digest, beforeDigest);
				assert.strictEqual(afterFence.ownership_status, "FREE");
			} finally {
				checkDb.close();
			}
			// .lock still present, not removed.
			assert.strictEqual(existsSync(join(runDir, ".lock")), true);
			assert.ok(!result.stderr.includes("@@TURNLOCK@@"));
		} finally {
			workspace.cleanup();
		}
	});
	test("initial mode on reused RUN_DIR with .lock → blocked before SQLite creation", async () => {
		const workspace = createE2EWorkspace("initial-lock-e2e-");
		const orchestratorName = "e2e-initial-lock";
		const runId = "01HX0000000000000000000NK1";
		try {
			const entrypoint = workspace.writeEntrypoint(
				"initial-lock-e2e.ts",
				buildEntrypointSource(`
interface State { step: number }

await runOrchestrator<State>({
name: ${JSON.stringify(orchestratorName)},
initial: "start",
initialState: { step: 0 },
resumeCommand: (runId: string) => \`node \${import.meta.filename} --run-id \${runId} --resume\`,
phases: {
start: definePhase<State>(async (state, io) => io.done({ step: 1 })),
},
});
`),
			);
			// Pre-create the run directory with a legacy .lock but NO SQLite DB.
			const runDir = join(workspace.runDirRoot, orchestratorName, runId);
			mkdirSync(runDir, { recursive: true });
			writeFileSync(
				join(runDir, ".lock"),
				"pid=99999\ntimestamp=1704067200000\n",
			);
			// Run in initial mode with --run-id pointing to the existing dir.
			const result = await workspace.runEntrypoint(
				entrypoint,
				["--run-id", runId],
				{ timeoutMs: 15000 },
			);
			assert.strictEqual(result.exitCode, 1);
			assert.strictEqual(countProtocolBlocks(result.stdout), 1);
			const block = parseSingleProtocolBlock(result.stdout);
			assert.strictEqual(block.action, "ERROR");
			assert.strictEqual(block.runId, runId);
			assert.strictEqual(
				block.fields.errorKind,
				"legacy_lock_migration_blocked",
			);
			// turnlock.sqlite3 was NOT created.
			const dbPath = join(runDir, "turnlock.sqlite3");
			assert.strictEqual(existsSync(dbPath), false);
			// .lock was not removed.
			assert.strictEqual(existsSync(join(runDir, ".lock")), true);
			assert.ok(!result.stderr.includes("@@TURNLOCK@@"));
		} finally {
			workspace.cleanup();
		}
	});
});
