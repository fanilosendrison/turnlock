import assert from "node:assert/strict";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
// Retention cleanup safety — adversarial integration tests.
//
// Invariant: a RUN_DIR can only be deleted by the retention cleanup after a
// durable, irreversible retirement claim committed in the run's own SQLite
// authority.  The claim is serialized against every ownership acquisition
// by the same BEGIN IMMEDIATE write lock, so a newly acquired valid
// authority can never be destroyed by retention cleanup.
import { beforeEach, describe, test } from "node:test";
import { STATE_SCHEMA_VERSION } from "../../src/constants.js";
import {
	type RunOrchestratorInternalDependencies,
	runOrchestratorInternal,
} from "../../src/engine/run-orchestrator.js";
import { AuthorityLostError } from "../../src/errors/concrete.js";
import { nodeSqliteDriver } from "../../src/persistence/sqlite/node-sqlite-driver.js";
import {
	acquireOwnership,
	refreshOwnership,
	releaseOwnership,
} from "../../src/persistence/sqlite/ownership.js";
import {
	claimRunForRetentionDeletion,
	createRunRetentionClaim,
} from "../../src/persistence/sqlite/retention-claim.js";
import {
	RETENTION_STATUS_RETIRING,
	readRetentionStatus,
} from "../../src/persistence/sqlite/retention-state.js";
import { bootstrapNewRunAtomic } from "../../src/persistence/sqlite/run-bootstrap.js";
import { openRunDatabase } from "../../src/persistence/sqlite/run-database.js";
import {
	commitState,
	projectAuthoritativeStateFenced,
	type StateRecord,
} from "../../src/persistence/sqlite/run-state-store.js";
import { cleanupOldRuns } from "../../src/services/run-dir.js";
import type { OrchestratorConfig } from "../../src/types/config.js";
import { cleanupTempDir, makeTempDir } from "../helpers/temp-run-dir.js";

const ORCHESTRATOR_NAME = "retention-orch";
const RUN_A = "01HX000000000000000000000A";
const RUN_B = "01HX000000000000000000000B";
const DAY_MS = 24 * 60 * 60 * 1000;

interface RetentionTestState {
	readonly stage: string;
}

/** Hook abort marker: the orchestrator reached the post-cleanup boundary. */
class StopAfterCleanup extends Error {}

const productionClaim = createRunRetentionClaim(nodeSqliteDriver);

beforeEach(() => {
	delete process.env.TURNLOCK_RUN_DIR_ROOT;
});

function makeConfig(
	runDirRoot: string,
	retentionDays: number,
): OrchestratorConfig<RetentionTestState> {
	return {
		name: ORCHESTRATOR_NAME,
		initial: "start",
		initialState: { stage: "fresh" },
		resumeCommand: (runId) => `node worker.mjs --run-id ${runId} --resume`,
		retentionDays,
		runDirRoot,
		phases: {
			start: async (_state, io) => io.done({ stage: "done" }),
		},
	};
}

/** Bootstrap a genuine Turnlock run database via the production primitive.
 *
 *  Ownership is HELD with a live lease (now + 30min).  Returns the
 *  bootstrap result (including the LockHandle) for fencing proofs. */
function bootstrapForeignRun(
	runDir: string,
	runId: string,
): ReturnType<typeof bootstrapNewRunAtomic> {
	mkdirSync(runDir, { recursive: true });
	const dbPath = join(runDir, "turnlock.sqlite3");
	const runDb = openRunDatabase({
		driver: nodeSqliteDriver,
		dbPath,
		busyTimeoutMs: 2000,
	});
	const nowEpochMs = Date.now();
	const nowIso = new Date(nowEpochMs).toISOString();
	const result = bootstrapNewRunAtomic({
		db: runDb.connection,
		runId,
		orchestratorName: ORCHESTRATOR_NAME,
		nowEpochMs,
		nowIso,
		leaseDurationMs: 30 * 60 * 1000,
		initialState: {
			schemaVersion: STATE_SCHEMA_VERSION,
			runId,
			orchestratorName: ORCHESTRATOR_NAME,
			startedAt: nowIso,
			startedAtEpochMs: nowEpochMs,
			lastTransitionAt: nowIso,
			lastTransitionAtEpochMs: nowEpochMs,
			currentPhase: "start",
			phasesExecuted: 0,
			accumulatedDurationMs: 0,
			data: { stage: "active" },
			usedLabels: [],
		},
		stateSchemaVersion: STATE_SCHEMA_VERSION,
		contentionDeadlineMs: 5000,
	});
	runDb.close();
	assert.strictEqual(result.kind, "BOOTSTRAPPED");
	return result;
}

/** Adversarially mutate the seeded ownership row (e.g. expire the lease). */
function mutateOwnership(runDir: string, sql: string): void {
	const dbPath = join(runDir, "turnlock.sqlite3");
	const runDb = openRunDatabase({
		driver: nodeSqliteDriver,
		dbPath,
		busyTimeoutMs: 2000,
	});
	runDb.connection.exec(sql);
	runDb.close();
}

function expireLease(runDir: string): void {
	mutateOwnership(
		runDir,
		`UPDATE run_ownership SET lease_until_epoch_ms = ${Date.now() - 1000} WHERE singleton = 1`,
	);
}

function ageDir(dir: string, days: number): void {
	const old = new Date(Date.now() - days * DAY_MS);
	utimesSync(dir, old, old);
}

function claimB(runDir: string, runId = RUN_B) {
	return claimRunForRetentionDeletion({
		driver: nodeSqliteDriver,
		dbPath: join(runDir, "turnlock.sqlite3"),
		runId,
		busyTimeoutMs: 2000,
		contentionDeadlineMs: 5000,
	});
}

function acquireB(runDir: string, runId = RUN_B) {
	const runDb = openRunDatabase({
		driver: nodeSqliteDriver,
		dbPath: join(runDir, "turnlock.sqlite3"),
		busyTimeoutMs: 2000,
	});
	const now = Date.now();
	const result = acquireOwnership({
		db: runDb.connection,
		runId,
		orchestratorName: ORCHESTRATOR_NAME,
		nowEpochMs: now,
		nowIso: new Date(now).toISOString(),
		leaseDurationMs: 30 * 60 * 1000,
		contentionDeadlineMs: 5000,
	});
	runDb.close();
	return result;
}

describe("retention cleanup safety", () => {
	test("foreign run with live SQLite ownership survives orchestrator retention cleanup", async () => {
		const root = makeTempDir();
		try {
			const runDirRoot = join(root, "runs");
			const runBDir = join(runDirRoot, ORCHESTRATOR_NAME, RUN_B);
			// 1. run B holds a genuine, currently-valid SQLite ownership.
			bootstrapForeignRun(runBDir, RUN_B);
			// 2. Make run B's RUN_DIR old enough to be retention-eligible
			//    while its ownership lease is still alive.
			ageDir(runBDir, 100);
			// 3. Trigger the real cleanup through the real orchestrator path.
			const dependencies: RunOrchestratorInternalDependencies = {
				hooks: {
					beforeInitialDispatchClaim: () => {
						throw new StopAfterCleanup("stop after retention cleanup");
					},
				},
			};
			let caught: unknown;
			try {
				await runOrchestratorInternal(
					makeConfig(runDirRoot, 7),
					{ resume: false, runId: RUN_A, rest: [] },
					dependencies,
				);
			} catch (error) {
				caught = error;
			}
			assert.ok(
				caught instanceof StopAfterCleanup,
				`expected the post-cleanup hook abort, got: ${String(caught)}`,
			);
			// 4. Run B must still exist with its SQLite authority intact.
			assert.strictEqual(
				existsSync(runBDir),
				true,
				"expected: active foreign run survives cleanup; actual: run directory was deleted",
			);
			assert.strictEqual(
				existsSync(join(runBDir, "turnlock.sqlite3")),
				true,
				"expected: foreign run SQLite authority survives cleanup; actual: turnlock.sqlite3 was deleted",
			);
		} finally {
			cleanupTempDir(root);
		}
	});

	test("A | live owner: retirement claim returns LIVE_OWNER and the directory is kept", () => {
		const root = makeTempDir();
		try {
			const runDirRoot = join(root, "runs");
			const runBDir = join(runDirRoot, ORCHESTRATOR_NAME, RUN_B);
			bootstrapForeignRun(runBDir, RUN_B);
			ageDir(runBDir, 100);
			const claim = claimB(runBDir);
			assert.strictEqual(claim.kind, "LIVE_OWNER");
			const deleted = cleanupOldRuns(
				root,
				ORCHESTRATOR_NAME,
				7,
				RUN_A,
				productionClaim,
				runDirRoot,
			);
			assert.strictEqual(deleted, 0);
			assert.strictEqual(existsSync(runBDir), true);
		} finally {
			cleanupTempDir(root);
		}
	});

	test("B | cleanup wins: CLAIMED blocks takeover, deletion proceeds", () => {
		const root = makeTempDir();
		try {
			const runDirRoot = join(root, "runs");
			const runBDir = join(runDirRoot, ORCHESTRATOR_NAME, RUN_B);
			bootstrapForeignRun(runBDir, RUN_B);
			expireLease(runBDir);
			ageDir(runBDir, 100);
			// Cleanup claims the durable retirement first.
			const claim = claimB(runBDir);
			assert.strictEqual(claim.kind, "CLAIMED");
			// A successor attempting takeover must NOT acquire.
			const takeover = acquireB(runBDir);
			assert.strictEqual(takeover.kind, "RUN_RETIRING");
			// Re-age: DB re-opens refresh the directory mtime; the retention
			// eligibility decision is mtime-based and must be re-satisfied.
			ageDir(runBDir, 100);
			// The real cleanup mechanism then finishes the deletion via
			// ALREADY_RETIRING.
			const deleted = cleanupOldRuns(
				root,
				ORCHESTRATOR_NAME,
				7,
				RUN_A,
				productionClaim,
				runDirRoot,
			);
			assert.strictEqual(deleted, 1);
			assert.strictEqual(existsSync(runBDir), false);
		} finally {
			cleanupTempDir(root);
		}
	});

	test("C | resume wins: takeover before the claim → LIVE_OWNER, directory survives (TOCTOU closed)", () => {
		const root = makeTempDir();
		try {
			const runDirRoot = join(root, "runs");
			const runBDir = join(runDirRoot, ORCHESTRATOR_NAME, RUN_B);
			bootstrapForeignRun(runBDir, RUN_B);
			expireLease(runBDir);
			ageDir(runBDir, 100);
			// Successor acquires a fresh valid authority first.
			const takeover = acquireB(runBDir);
			assert.strictEqual(takeover.kind, "ACQUIRED");
			if (takeover.kind === "ACQUIRED") {
				assert.ok(
					takeover.handle.leaseUntilEpochMs > Date.now(),
					"test setup: takeover lease must be alive",
				);
			}
			// The cleanup's destructive authorization must now be refused:
			// the claim re-reads ownership AFTER BEGIN IMMEDIATE and sees
			// the live successor.
			const claim = claimB(runBDir);
			assert.strictEqual(claim.kind, "LIVE_OWNER");
			const deleted = cleanupOldRuns(
				root,
				ORCHESTRATOR_NAME,
				7,
				RUN_A,
				productionClaim,
				runDirRoot,
			);
			assert.strictEqual(deleted, 0);
			assert.strictEqual(existsSync(runBDir), true);
			assert.strictEqual(existsSync(join(runBDir, "turnlock.sqlite3")), true);
		} finally {
			cleanupTempDir(root);
		}
	});

	test("E | stale handle fenced by retirement: refresh/commit/projection/release all rejected", () => {
		const root = makeTempDir();
		try {
			const runDir = join(root, "runs", ORCHESTRATOR_NAME, RUN_B);
			const bootstrapped = bootstrapForeignRun(runDir, RUN_B);
			if (bootstrapped.kind !== "BOOTSTRAPPED") throw new Error("setup");
			const staleHandle = bootstrapped.handle;
			expireLease(runDir);
			// Cleanup claims RETIRING — the handle is now definitively stale
			// even though its lease had (just) expired.
			const claim = claimB(runDir);
			assert.strictEqual(claim.kind, "CLAIMED");
			const db = openRunDatabase({
				driver: nodeSqliteDriver,
				dbPath: join(runDir, "turnlock.sqlite3"),
				busyTimeoutMs: 2000,
			});
			try {
				// refresh → STALE_HANDLE (not EXPIRED_HANDLE): the fence moved.
				const refresh = refreshOwnership({
					db: db.connection,
					handle: staleHandle,
					nowEpochMs: Date.now(),
					leaseDurationMs: 30 * 60 * 1000,
				});
				assert.strictEqual(refresh.kind, "STALE_HANDLE");
				// commit → STALE_HANDLE.
				const commit = commitState({
					db: db.connection,
					handle: staleHandle,
					expectedRevision: bootstrapped.committed.stateRevision,
					nextState: bootstrapped.committed
						.state as unknown as StateRecord<RetentionTestState>,
					nowEpochMs: Date.now(),
					nowIso: new Date().toISOString(),
				});
				assert.strictEqual(commit.kind, "STALE_HANDLE");
				// projection → AuthorityLostError with STALE_HANDLE reason.
				assert.throws(
					() =>
						projectAuthoritativeStateFenced(
							db.connection,
							staleHandle,
							runDir,
							bootstrapped.committed.stateRevision,
							bootstrapped.committed.stateDigest,
						),
					(error: unknown) =>
						error instanceof AuthorityLostError &&
						error.reason === "STALE_HANDLE",
				);
				// release → STALE_HANDLE.
				const release = releaseOwnership({
					db: db.connection,
					handle: staleHandle,
				});
				assert.strictEqual(release.kind, "STALE_HANDLE");
			} finally {
				db.close();
			}
		} finally {
			cleanupTempDir(root);
		}
	});

	test("F | crash after claim: RETIRING persists, resume rejected, next cleanup finishes deletion", () => {
		const root = makeTempDir();
		try {
			const runDirRoot = join(root, "runs");
			const runBDir = join(runDirRoot, ORCHESTRATOR_NAME, RUN_B);
			bootstrapForeignRun(runBDir, RUN_B);
			expireLease(runBDir);
			ageDir(runBDir, 100);
			// Cleanup claims, then "crashes" before rm.
			const claim = claimB(runBDir);
			assert.strictEqual(claim.kind, "CLAIMED");
			// Resume must not acquire.
			const takeover = acquireB(runBDir);
			assert.strictEqual(takeover.kind, "RUN_RETIRING");
			// Re-age: DB re-opens refresh the directory mtime; the retention
			// eligibility decision is mtime-based and must be re-satisfied.
			ageDir(runBDir, 100);
			// A new cleanup process sees ALREADY_RETIRING and can finish.
			const deleted = cleanupOldRuns(
				root,
				ORCHESTRATOR_NAME,
				7,
				RUN_A,
				productionClaim,
				runDirRoot,
			);
			assert.strictEqual(deleted, 1);
			assert.strictEqual(existsSync(runBDir), false);
		} finally {
			cleanupTempDir(root);
		}
	});

	test("G | deletion failure after claim: RETIRING persists, resume rejected, retry deletes", () => {
		const root = makeTempDir();
		try {
			const runDirRoot = join(root, "runs");
			const runBDir = join(runDirRoot, ORCHESTRATOR_NAME, RUN_B);
			bootstrapForeignRun(runBDir, RUN_B);
			expireLease(runBDir);
			ageDir(runBDir, 100);
			// Instrumented claim delegate: performs the REAL durable claim,
			// then makes the directory undeletable before rm runs.
			const claimThenLock: typeof productionClaim = {
				claimRunForDeletion: (runDir, runId) => {
					const result = claimB(runDir, runId);
					chmodSync(runDir, 0o555);
					return result;
				},
			};
			const deletedFirst = cleanupOldRuns(
				root,
				ORCHESTRATOR_NAME,
				7,
				RUN_A,
				claimThenLock,
				runDirRoot,
			);
			// rm failed — the claim must NOT be reactivated.
			assert.strictEqual(deletedFirst, 0);
			assert.strictEqual(existsSync(runBDir), true);
			chmodSync(runBDir, 0o755);
			const checkDb = openRunDatabase({
				driver: nodeSqliteDriver,
				dbPath: join(runBDir, "turnlock.sqlite3"),
				busyTimeoutMs: 2000,
			});
			try {
				assert.strictEqual(
					readRetentionStatus(checkDb.connection),
					RETENTION_STATUS_RETIRING,
				);
			} finally {
				checkDb.close();
			}
			// Resume remains forbidden.
			const takeover = acquireB(runBDir);
			assert.strictEqual(takeover.kind, "RUN_RETIRING");
			// Re-age: DB re-opens refresh the directory mtime; the retention
			// eligibility decision is mtime-based and must be re-satisfied.
			ageDir(runBDir, 100);
			// A future cleanup retries and completes the deletion.
			const deletedRetry = cleanupOldRuns(
				root,
				ORCHESTRATOR_NAME,
				7,
				RUN_A,
				productionClaim,
				runDirRoot,
			);
			assert.strictEqual(deletedRetry, 1);
			assert.strictEqual(existsSync(runBDir), false);
		} finally {
			cleanupTempDir(root);
		}
	});

	test("H | unreadable or incompatible database is kept (fail-closed)", () => {
		const root = makeTempDir();
		try {
			const runDirRoot = join(root, "runs");
			// Unreadable DB file.
			const corruptDir = join(runDirRoot, ORCHESTRATOR_NAME, RUN_B);
			mkdirSync(corruptDir, { recursive: true });
			writeFileSync(join(corruptDir, "turnlock.sqlite3"), "not a sqlite db");
			ageDir(corruptDir, 100);
			// Schema-incompatible DB.
			const mismatchedId = "01HX000000000000000000000C";
			const mismatchedDir = join(runDirRoot, ORCHESTRATOR_NAME, mismatchedId);
			bootstrapForeignRun(mismatchedDir, mismatchedId);
			mutateOwnership(
				mismatchedDir,
				"UPDATE schema_metadata SET schema_version = 999 WHERE singleton = 1",
			);
			ageDir(mismatchedDir, 100);
			const deleted = cleanupOldRuns(
				root,
				ORCHESTRATOR_NAME,
				7,
				RUN_A,
				productionClaim,
				runDirRoot,
			);
			assert.strictEqual(deleted, 0);
			assert.strictEqual(existsSync(corruptDir), true);
			assert.strictEqual(existsSync(mismatchedDir), true);
		} finally {
			cleanupTempDir(root);
		}
	});

	test("legacy RUN_DIR without SQLite authority is kept (fail-closed)", () => {
		const root = makeTempDir();
		try {
			const runDirRoot = join(root, "runs");
			const runBDir = join(runDirRoot, ORCHESTRATOR_NAME, RUN_B);
			mkdirSync(runBDir, { recursive: true });
			ageDir(runBDir, 100);
			const deleted = cleanupOldRuns(
				root,
				ORCHESTRATOR_NAME,
				7,
				RUN_A,
				productionClaim,
				runDirRoot,
			);
			assert.strictEqual(deleted, 0);
			assert.strictEqual(existsSync(runBDir), true);
		} finally {
			cleanupTempDir(root);
		}
	});

	test("foreign run with expired lease but recent directory is kept", () => {
		const root = makeTempDir();
		try {
			const runDirRoot = join(root, "runs");
			const runBDir = join(runDirRoot, ORCHESTRATOR_NAME, RUN_B);
			bootstrapForeignRun(runBDir, RUN_B);
			expireLease(runBDir);
			// Fresh directory — below the retention threshold.
			const deleted = cleanupOldRuns(
				root,
				ORCHESTRATOR_NAME,
				7,
				RUN_A,
				productionClaim,
				runDirRoot,
			);
			assert.strictEqual(deleted, 0);
			assert.strictEqual(existsSync(runBDir), true);
		} finally {
			cleanupTempDir(root);
		}
	});

	test("current run is never retirement-claimed by its own startup cleanup", () => {
		const root = makeTempDir();
		try {
			const runDirRoot = join(root, "runs");
			const runADir = join(runDirRoot, ORCHESTRATOR_NAME, RUN_A);
			bootstrapForeignRun(runADir, RUN_A);
			ageDir(runADir, 100);
			let claims = 0;
			const spyClaim: typeof productionClaim = {
				claimRunForDeletion: (runDir, runId) => {
					claims++;
					return claimB(runDir, runId);
				},
			};
			const deleted = cleanupOldRuns(
				root,
				ORCHESTRATOR_NAME,
				7,
				RUN_A,
				spyClaim,
				runDirRoot,
			);
			assert.strictEqual(claims, 0);
			assert.strictEqual(deleted, 0);
			assert.strictEqual(existsSync(runADir), true);
		} finally {
			cleanupTempDir(root);
		}
	});

	test("cleanup never touches runs of another orchestrator, even with a live DB", () => {
		const root = makeTempDir();
		try {
			const runDirRoot = join(root, "runs");
			const otherRunDir = join(runDirRoot, "other-orch", RUN_B);
			bootstrapForeignRun(otherRunDir, RUN_B);
			ageDir(otherRunDir, 100);
			const deleted = cleanupOldRuns(
				root,
				ORCHESTRATOR_NAME,
				7,
				RUN_A,
				productionClaim,
				runDirRoot,
			);
			assert.strictEqual(deleted, 0);
			assert.strictEqual(existsSync(otherRunDir), true);
			assert.strictEqual(
				existsSync(join(otherRunDir, "turnlock.sqlite3")),
				true,
			);
		} finally {
			cleanupTempDir(root);
		}
	});

	test("retentionDays = 0 deletes a genuinely retired candidate and keeps the current run", () => {
		const root = makeTempDir();
		try {
			const runDirRoot = join(root, "runs");
			const base = join(runDirRoot, ORCHESTRATOR_NAME);
			const oldRunDir = join(base, RUN_B);
			bootstrapForeignRun(oldRunDir, RUN_B);
			expireLease(oldRunDir);
			ageDir(oldRunDir, 1);
			const currentDir = join(base, RUN_A);
			bootstrapForeignRun(currentDir, RUN_A);
			ageDir(currentDir, 100);
			const deleted = cleanupOldRuns(
				root,
				ORCHESTRATOR_NAME,
				0,
				RUN_A,
				productionClaim,
				runDirRoot,
			);
			assert.strictEqual(deleted, 1);
			assert.strictEqual(existsSync(oldRunDir), false);
			assert.strictEqual(existsSync(currentDir), true);
		} finally {
			cleanupTempDir(root);
		}
	});
});
