import assert from "node:assert/strict";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readdirSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
// Retention cleanup safety — adversarial integration tests.
//
// Two-frontier invariant:
//   SQLite: a RUN_DIR can only be retired after a durable ACTIVE→RETIRING
//   claim committed in the run's own authority (serialized with every
//   ownership acquisition).
//   Filesystem: physical deletion operates only on a retirement-specific
//   pathname (.retired/<runId>--<retirementToken>), reached by an atomic
//   rename of the canonical pathname.  A new incarnation at the canonical
//   pathname can never share deletion scope with a retired one.
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
	beginImmediate,
	refreshOwnership,
	releaseOwnership,
	rollback,
} from "../../src/persistence/sqlite/ownership.js";
import { claimRunForRetentionDeletion } from "../../src/persistence/sqlite/retention-claim.js";
import {
	applyRetirementInTransaction,
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
import {
	buildRunRetirement,
	deleteRetiredRunDirectory,
	RETIRED_DIR_NAME,
	renameRunDirectoryToRetired,
} from "../../src/services/run-retirement.js";
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

const productionRetirement = buildRunRetirement(nodeSqliteDriver);

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

/** Adversarially mutate the seeded ownership/retention rows. */
function mutateRun(runDir: string, sql: string): void {
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
	mutateRun(
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
			bootstrapForeignRun(runBDir, RUN_B);
			ageDir(runBDir, 100);
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
			assert.strictEqual(existsSync(runBDir), true);
			assert.strictEqual(existsSync(join(runBDir, "turnlock.sqlite3")), true);
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
				productionRetirement,
				runDirRoot,
			);
			assert.strictEqual(deleted, 0);
			assert.strictEqual(existsSync(runBDir), true);
		} finally {
			cleanupTempDir(root);
		}
	});

	test("B | cleanup wins: CLAIMED blocks takeover, rename+delete vacates the canonical path", () => {
		const root = makeTempDir();
		try {
			const runDirRoot = join(root, "runs");
			const runBDir = join(runDirRoot, ORCHESTRATOR_NAME, RUN_B);
			bootstrapForeignRun(runBDir, RUN_B);
			expireLease(runBDir);
			ageDir(runBDir, 100);
			const claim = claimB(runBDir);
			assert.strictEqual(claim.kind, "CLAIMED");
			const takeover = acquireB(runBDir);
			assert.strictEqual(takeover.kind, "RUN_RETIRING");
			ageDir(runBDir, 100);
			const deleted = cleanupOldRuns(
				root,
				ORCHESTRATOR_NAME,
				7,
				RUN_A,
				productionRetirement,
				runDirRoot,
			);
			assert.strictEqual(deleted, 1);
			assert.strictEqual(existsSync(runBDir), false);
			assert.strictEqual(
				existsSync(
					join(
						dirname(runBDir),
						RETIRED_DIR_NAME,
						`${RUN_B}--${claim.retirementToken}`,
					),
				),
				false,
			);
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
			const takeover = acquireB(runBDir);
			assert.strictEqual(takeover.kind, "ACQUIRED");
			if (takeover.kind === "ACQUIRED") {
				assert.ok(takeover.handle.leaseUntilEpochMs > Date.now());
			}
			const claim = claimB(runBDir);
			assert.strictEqual(claim.kind, "LIVE_OWNER");
			const deleted = cleanupOldRuns(
				root,
				ORCHESTRATOR_NAME,
				7,
				RUN_A,
				productionRetirement,
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
			const claim = claimB(runDir);
			assert.strictEqual(claim.kind, "CLAIMED");
			const db = openRunDatabase({
				driver: nodeSqliteDriver,
				dbPath: join(runDir, "turnlock.sqlite3"),
				busyTimeoutMs: 2000,
			});
			try {
				const refresh = refreshOwnership({
					db: db.connection,
					handle: staleHandle,
					nowEpochMs: Date.now(),
					leaseDurationMs: 30 * 60 * 1000,
				});
				assert.strictEqual(refresh.kind, "STALE_HANDLE");
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

	test("F | crash after claim (before rename): RETIRING persists, resume rejected, next cleanup finishes", () => {
		const root = makeTempDir();
		try {
			const runDirRoot = join(root, "runs");
			const runBDir = join(runDirRoot, ORCHESTRATOR_NAME, RUN_B);
			bootstrapForeignRun(runBDir, RUN_B);
			expireLease(runBDir);
			ageDir(runBDir, 100);
			const claim = claimB(runBDir);
			assert.strictEqual(claim.kind, "CLAIMED");
			// Crash before rename: canonical still exists, DB says RETIRING.
			const takeover = acquireB(runBDir);
			assert.strictEqual(takeover.kind, "RUN_RETIRING");
			ageDir(runBDir, 100);
			const deleted = cleanupOldRuns(
				root,
				ORCHESTRATOR_NAME,
				7,
				RUN_A,
				productionRetirement,
				runDirRoot,
			);
			assert.strictEqual(deleted, 1);
			assert.strictEqual(existsSync(runBDir), false);
		} finally {
			cleanupTempDir(root);
		}
	});

	test("crash B | crash after rename (before rm): sweep finishes the retired deletion", () => {
		const root = makeTempDir();
		try {
			const runDir = join(root, "runs", ORCHESTRATOR_NAME, RUN_B);
			bootstrapForeignRun(runDir, RUN_B);
			expireLease(runDir);
			ageDir(runDir, 100);
			const claim = claimB(runDir);
			assert.strictEqual(claim.kind, "CLAIMED");
			if (claim.kind !== "CLAIMED") throw new Error("setup");
			const rename = renameRunDirectoryToRetired({
				driver: nodeSqliteDriver,
				runDir,
				runId: RUN_B,
				retirementToken: claim.retirementToken,
				databaseIdentity: claim.databaseIdentity,
			});
			assert.strictEqual(rename.kind, "RENAMED");
			if (rename.kind !== "RENAMED") throw new Error("setup");
			// Crash before rm: canonical absent, retired path exists.
			assert.strictEqual(existsSync(runDir), false);
			assert.strictEqual(existsSync(rename.retiredPath), true);
			// A future cleanup finds and deletes the retired entry via the
			// sweep — independent of the canonical path presence.
			const deleted = cleanupOldRuns(
				root,
				ORCHESTRATOR_NAME,
				7,
				RUN_A,
				productionRetirement,
				join(root, "runs"),
			);
			assert.strictEqual(deleted, 1);
			assert.strictEqual(existsSync(rename.retiredPath), false);
		} finally {
			cleanupTempDir(root);
		}
	});

	test("G | deletion failure after rename: RETIRING persists, resume rejected, sweep retries", () => {
		const root = makeTempDir();
		try {
			const runDirRoot = join(root, "runs");
			const runBDir = join(runDirRoot, ORCHESTRATOR_NAME, RUN_B);
			bootstrapForeignRun(runBDir, RUN_B);
			expireLease(runBDir);
			// A non-empty read-only child makes recursive deletion fail —
			// sorted before turnlock.sqlite3 so the DB survives intact.
			const stickyDir = join(runBDir, "0-sticky", "deep");
			mkdirSync(stickyDir, { recursive: true });
			writeFileSync(join(stickyDir, "file.txt"), "x");
			chmodSync(join(runBDir, "0-sticky"), 0o555);
			ageDir(runBDir, 100);
			// Claim + rename succeed; the recursive delete fails.
			const deletedFirst = cleanupOldRuns(
				root,
				ORCHESTRATOR_NAME,
				7,
				RUN_A,
				productionRetirement,
				runDirRoot,
			);
			assert.strictEqual(deletedFirst, 0);
			assert.strictEqual(existsSync(runBDir), false);
			const retiredRoot = join(dirname(runBDir), RETIRED_DIR_NAME);
			const retiredEntries = readdirSync(retiredRoot);
			assert.strictEqual(retiredEntries.length, 1);
			const retiredPath = join(retiredRoot, retiredEntries[0] ?? "");
			assert.strictEqual(existsSync(retiredPath), true);
			// The retired DB stays RETIRING and refuses new ownership.
			const checkDb = openRunDatabase({
				driver: nodeSqliteDriver,
				dbPath: join(retiredPath, "turnlock.sqlite3"),
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
			const takeover = acquireB(retiredPath);
			assert.strictEqual(takeover.kind, "RUN_RETIRING");
			// Unblock the deletion and retry — the sweep completes it.
			chmodSync(join(retiredPath, "0-sticky"), 0o755);
			const deletedRetry = cleanupOldRuns(
				root,
				ORCHESTRATOR_NAME,
				7,
				RUN_A,
				productionRetirement,
				runDirRoot,
			);
			assert.strictEqual(deletedRetry, 1);
			assert.strictEqual(existsSync(retiredPath), false);
		} finally {
			cleanupTempDir(root);
		}
	});

	test("H | unreadable or incompatible database is kept (fail-closed)", () => {
		const root = makeTempDir();
		try {
			const runDirRoot = join(root, "runs");
			const corruptDir = join(runDirRoot, ORCHESTRATOR_NAME, RUN_B);
			mkdirSync(corruptDir, { recursive: true });
			writeFileSync(join(corruptDir, "turnlock.sqlite3"), "not a sqlite db");
			ageDir(corruptDir, 100);
			const mismatchedId = "01HX000000000000000000000C";
			const mismatchedDir = join(runDirRoot, ORCHESTRATOR_NAME, mismatchedId);
			bootstrapForeignRun(mismatchedDir, mismatchedId);
			mutateRun(
				mismatchedDir,
				"UPDATE schema_metadata SET schema_version = 999 WHERE singleton = 1",
			);
			ageDir(mismatchedDir, 100);
			const deleted = cleanupOldRuns(
				root,
				ORCHESTRATOR_NAME,
				7,
				RUN_A,
				productionRetirement,
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
				productionRetirement,
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
			const deleted = cleanupOldRuns(
				root,
				ORCHESTRATOR_NAME,
				7,
				RUN_A,
				productionRetirement,
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
			let retirements = 0;
			const spy: typeof productionRetirement = {
				retireRunDirectory: (runDir, runId) => {
					retirements++;
					return productionRetirement.retireRunDirectory(runDir, runId);
				},
				sweepRetiredDirectories: (retiredRoot) =>
					productionRetirement.sweepRetiredDirectories(retiredRoot),
			};
			const deleted = cleanupOldRuns(
				root,
				ORCHESTRATOR_NAME,
				7,
				RUN_A,
				spy,
				runDirRoot,
			);
			assert.strictEqual(retirements, 0);
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
				productionRetirement,
				runDirRoot,
			);
			assert.strictEqual(deleted, 0);
			assert.strictEqual(existsSync(otherRunDir), true);
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
				productionRetirement,
				runDirRoot,
			);
			assert.strictEqual(deleted, 1);
			assert.strictEqual(existsSync(oldRunDir), false);
			assert.strictEqual(existsSync(currentDir), true);
		} finally {
			cleanupTempDir(root);
		}
	});

	test("new incarnation created at the canonical path during the retirement window must not be destroyed", () => {
		const root = makeTempDir();
		try {
			const runDirRoot = join(root, "runs");
			const runBDir = join(runDirRoot, ORCHESTRATOR_NAME, RUN_B);
			bootstrapForeignRun(runBDir, RUN_B);
			expireLease(runBDir);
			ageDir(runBDir, 100);
			// Barrier delegate: the REAL durable claim wins, then the
			// deletion window is simulated — the old authority's files
			// disappear and a NEW incarnation is bootstrapped at the SAME
			// canonical pathname with the production primitives.
			let newIncarnationBootstrapped = false;
			const windowDelegate: typeof productionRetirement = {
				retireRunDirectory: (runDir, runId) => {
					const claim = claimB(runDir, runId);
					assert.strictEqual(claim.kind, "CLAIMED");
					for (const entry of readdirSync(runDir)) {
						rmSync(join(runDir, entry), { recursive: true, force: true });
					}
					const fresh = bootstrapForeignRun(runDir, runId);
					assert.strictEqual(fresh.kind, "BOOTSTRAPPED");
					if (fresh.kind === "BOOTSTRAPPED") {
						assert.ok(fresh.handle.leaseUntilEpochMs > Date.now());
					}
					newIncarnationBootstrapped = true;
					// Hand over to the REAL production flow: it must refuse
					// to act on the new incarnation.
					return productionRetirement.retireRunDirectory(runDir, runId);
				},
				sweepRetiredDirectories: (retiredRoot) =>
					productionRetirement.sweepRetiredDirectories(retiredRoot),
			};
			const deleted = cleanupOldRuns(
				root,
				ORCHESTRATOR_NAME,
				7,
				RUN_A,
				windowDelegate,
				runDirRoot,
			);
			console.error(
				`filesystem-window proof: newIncarnationBootstrapped=${newIncarnationBootstrapped} deleted=${deleted}`,
			);
			assert.strictEqual(
				existsSync(runBDir),
				true,
				"expected: new incarnation survives; actual: canonical pathname was removed by the cleanup",
			);
			assert.strictEqual(
				existsSync(join(runBDir, "turnlock.sqlite3")),
				true,
				"expected: new incarnation SQLite authority survives; actual: turnlock.sqlite3 was removed",
			);
			// The new incarnation remains fully authoritative: its bootstrap
			// owner is still HELD with a live lease, so a takeover attempt
			// must report ACTIVE_CONFLICT (a live owner exists).
			const takeover = acquireB(runBDir);
			assert.strictEqual(takeover.kind, "ACTIVE_CONFLICT");
			if (takeover.kind === "ACTIVE_CONFLICT") {
				assert.ok(takeover.leaseUntilEpochMs > Date.now());
			}
		} finally {
			cleanupTempDir(root);
		}
	});

	test("canonical pathname replaced after claim must not be renamed/deleted", () => {
		const root = makeTempDir();
		try {
			const runDirRoot = join(root, "runs");
			const runBDir = join(runDirRoot, ORCHESTRATOR_NAME, RUN_B);
			bootstrapForeignRun(runBDir, RUN_B);
			expireLease(runBDir);
			ageDir(runBDir, 100);
			let newIncarnationBootstrapped = false;
			const swapDelegate: typeof productionRetirement = {
				retireRunDirectory: (runDir, runId) => {
					const claim = claimB(runDir, runId);
					assert.strictEqual(claim.kind, "CLAIMED");
					// Pathname substitution: the whole directory object the
					// claim referred to is replaced by a brand-new one.
					rmSync(runDir, { recursive: true, force: true });
					const fresh = bootstrapForeignRun(runDir, runId);
					assert.strictEqual(fresh.kind, "BOOTSTRAPPED");
					if (fresh.kind === "BOOTSTRAPPED") {
						assert.ok(fresh.handle.leaseUntilEpochMs > Date.now());
					}
					newIncarnationBootstrapped = true;
					return productionRetirement.retireRunDirectory(runDir, runId);
				},
				sweepRetiredDirectories: (retiredRoot) =>
					productionRetirement.sweepRetiredDirectories(retiredRoot),
			};
			const deleted = cleanupOldRuns(
				root,
				ORCHESTRATOR_NAME,
				7,
				RUN_A,
				swapDelegate,
				runDirRoot,
			);
			console.error(
				`pathname-replacement proof: newIncarnationBootstrapped=${newIncarnationBootstrapped} deleted=${deleted}`,
			);
			assert.strictEqual(
				existsSync(runBDir),
				true,
				"expected: replacement incarnation survives; actual: canonical pathname was removed after the swap",
			);
			assert.strictEqual(existsSync(join(runBDir, "turnlock.sqlite3")), true);
			const takeover = acquireB(runBDir);
			assert.strictEqual(takeover.kind, "ACTIVE_CONFLICT");
			if (takeover.kind === "ACTIVE_CONFLICT") {
				assert.ok(takeover.leaseUntilEpochMs > Date.now());
			}
		} finally {
			cleanupTempDir(root);
		}
	});

	test("filesystem protocol: new canonical incarnation survives deletion of the retired path", () => {
		const root = makeTempDir();
		try {
			const runDir = join(root, "runs", ORCHESTRATOR_NAME, RUN_B);
			bootstrapForeignRun(runDir, RUN_B);
			expireLease(runDir);
			ageDir(runDir, 100);
			// 1. Retirement claimed on the OLD incarnation.
			const claim = claimB(runDir);
			assert.strictEqual(claim.kind, "CLAIMED");
			if (claim.kind !== "CLAIMED") throw new Error("setup");
			// 2. Atomic rename: old incarnation leaves the canonical path.
			const rename = renameRunDirectoryToRetired({
				driver: nodeSqliteDriver,
				runDir,
				runId: RUN_B,
				retirementToken: claim.retirementToken,
				databaseIdentity: claim.databaseIdentity,
			});
			assert.strictEqual(rename.kind, "RENAMED");
			if (rename.kind !== "RENAMED") throw new Error("setup");
			assert.strictEqual(existsSync(runDir), false);
			// 3. A NEW incarnation bootstraps at the canonical pathname.
			const fresh = bootstrapForeignRun(runDir, RUN_B);
			assert.strictEqual(fresh.kind, "BOOTSTRAPPED");
			// 4. Deletion of the retired path runs to completion.
			const deletion = deleteRetiredRunDirectory(rename.retiredPath);
			assert.strictEqual(deletion.kind, "DELETED");
			assert.strictEqual(existsSync(rename.retiredPath), false);
			// 5. The new incarnation is completely untouched and still
			//    authoritative (live HELD ownership from its bootstrap).
			assert.strictEqual(existsSync(runDir), true);
			assert.strictEqual(existsSync(join(runDir, "turnlock.sqlite3")), true);
			const takeover = acquireB(runDir);
			assert.strictEqual(takeover.kind, "ACTIVE_CONFLICT");
			if (takeover.kind === "ACTIVE_CONFLICT") {
				assert.ok(takeover.leaseUntilEpochMs > Date.now());
			}
		} finally {
			cleanupTempDir(root);
		}
	});

	test("pathname replacement before rename: identity verification refuses to move the new incarnation", () => {
		const root = makeTempDir();
		try {
			const runDir = join(root, "runs", ORCHESTRATOR_NAME, RUN_B);
			bootstrapForeignRun(runDir, RUN_B);
			expireLease(runDir);
			const claim = claimB(runDir);
			assert.strictEqual(claim.kind, "CLAIMED");
			if (claim.kind !== "CLAIMED") throw new Error("setup");
			// Swap the canonical path with a brand-new incarnation BEFORE
			// the filesystem phase.
			rmSync(runDir, { recursive: true, force: true });
			const fresh = bootstrapForeignRun(runDir, RUN_B);
			assert.strictEqual(fresh.kind, "BOOTSTRAPPED");
			// The stale claim's identity must refuse the rename.
			const rename = renameRunDirectoryToRetired({
				driver: nodeSqliteDriver,
				runDir,
				runId: RUN_B,
				retirementToken: claim.retirementToken,
				databaseIdentity: claim.databaseIdentity,
			});
			assert.strictEqual(rename.kind, "MISMATCH");
			// The new incarnation is untouched and still authoritative.
			assert.strictEqual(existsSync(runDir), true);
			assert.strictEqual(existsSync(join(runDir, "turnlock.sqlite3")), true);
			const takeover = acquireB(runDir);
			assert.strictEqual(takeover.kind, "ACTIVE_CONFLICT");
			if (takeover.kind === "ACTIVE_CONFLICT") {
				assert.ok(takeover.leaseUntilEpochMs > Date.now());
			}
		} finally {
			cleanupTempDir(root);
		}
	});

	test("retention status invalid → KEEP (no destructive effect)", () => {
		const root = makeTempDir();
		try {
			const runDirRoot = join(root, "runs");
			const runBDir = join(runDirRoot, ORCHESTRATOR_NAME, RUN_B);
			mkdirSync(runBDir, { recursive: true });
			// Craft a schema-v2 database whose run_retention row carries a
			// status value that bypasses the production CHECK constraint —
			// the only way to construct the corrupted state for testing.
			const dbPath = join(runBDir, "turnlock.sqlite3");
			const raw = nodeSqliteDriver.open(dbPath);
			raw.exec(`
				CREATE TABLE schema_metadata (
				    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
				    schema_version INTEGER NOT NULL
				);
				INSERT INTO schema_metadata (singleton, schema_version)
				VALUES (1, 2);
				CREATE TABLE run_retention (
				    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
				    retention_status TEXT NOT NULL,
				    retirement_token TEXT,
				    retirement_claimed_at_epoch_ms INTEGER
				);
				INSERT INTO run_retention (singleton, retention_status)
				VALUES (1, 'BROKEN');
			`);
			raw.close();
			ageDir(runBDir, 100);
			const deleted = cleanupOldRuns(
				root,
				ORCHESTRATOR_NAME,
				7,
				RUN_A,
				productionRetirement,
				runDirRoot,
			);
			// The corrupted status must never authorize deletion: the open
			// fails closed and the directory is kept.
			assert.strictEqual(deleted, 0);
			assert.strictEqual(existsSync(runBDir), true);
			assert.strictEqual(existsSync(join(runBDir, "turnlock.sqlite3")), true);
		} finally {
			cleanupTempDir(root);
		}
	});

	test("RETIRING + missing retirement token → KEEP (no destructive effect)", () => {
		const root = makeTempDir();
		try {
			const runDirRoot = join(root, "runs");
			const runBDir = join(runDirRoot, ORCHESTRATOR_NAME, RUN_B);
			bootstrapForeignRun(runBDir, RUN_B);
			expireLease(runBDir);
			mutateRun(
				runBDir,
				"UPDATE run_retention SET retention_status = 'RETIRING', retirement_token = NULL WHERE singleton = 1",
			);
			ageDir(runBDir, 100);
			const deleted = cleanupOldRuns(
				root,
				ORCHESTRATOR_NAME,
				7,
				RUN_A,
				productionRetirement,
				runDirRoot,
			);
			assert.strictEqual(deleted, 0);
			assert.strictEqual(existsSync(runBDir), true);
		} finally {
			cleanupTempDir(root);
		}
	});

	test("RETIRING + HELD/live ownership → KEEP (no destructive effect)", () => {
		const root = makeTempDir();
		try {
			const runDirRoot = join(root, "runs");
			const runBDir = join(runDirRoot, ORCHESTRATOR_NAME, RUN_B);
			bootstrapForeignRun(runBDir, RUN_B);
			expireLease(runBDir);
			const firstClaim = claimB(runBDir);
			assert.strictEqual(firstClaim.kind, "CLAIMED");
			// Corrupt the retired state: a live owner appears again.
			mutateRun(
				runBDir,
				`UPDATE run_ownership SET ownership_status = 'HELD', owner_token = 'ghost', owner_pid = 1, acquired_at_epoch_ms = ${Date.now()}, lease_until_epoch_ms = ${Date.now() + 3600000} WHERE singleton = 1`,
			);
			ageDir(runBDir, 100);
			const deleted = cleanupOldRuns(
				root,
				ORCHESTRATOR_NAME,
				7,
				RUN_A,
				productionRetirement,
				runDirRoot,
			);
			assert.strictEqual(deleted, 0);
			assert.strictEqual(existsSync(runBDir), true);
		} finally {
			cleanupTempDir(root);
		}
	});

	test("schema v2 + missing run_retention row → open fails closed → KEEP", () => {
		const root = makeTempDir();
		try {
			const runDirRoot = join(root, "runs");
			const runBDir = join(runDirRoot, ORCHESTRATOR_NAME, RUN_B);
			bootstrapForeignRun(runBDir, RUN_B);
			expireLease(runBDir);
			mutateRun(runBDir, "DELETE FROM run_retention WHERE singleton = 1");
			ageDir(runBDir, 100);
			const deleted = cleanupOldRuns(
				root,
				ORCHESTRATOR_NAME,
				7,
				RUN_A,
				productionRetirement,
				runDirRoot,
			);
			assert.strictEqual(deleted, 0);
			assert.strictEqual(existsSync(runBDir), true);
		} finally {
			cleanupTempDir(root);
		}
	});

	test("ACTIVE → RETIRING transition mutating zero rows → no CLAIMED, no delete", () => {
		const root = makeTempDir();
		try {
			const runDir = join(root, "runs", ORCHESTRATOR_NAME, RUN_B);
			bootstrapForeignRun(runDir, RUN_B);
			expireLease(runDir);
			// Open a connection and manually flip the retention state to
			// RETIRING (simulating a racing claim), then the real
			// transition primitive must prove exactly-one-row mutation.
			const db = openRunDatabase({
				driver: nodeSqliteDriver,
				dbPath: join(runDir, "turnlock.sqlite3"),
				busyTimeoutMs: 2000,
			});
			try {
				beginImmediate(db.connection);
				db.connection.exec(
					"UPDATE run_retention SET retention_status = 'RETIRING' WHERE singleton = 1",
				);
				assert.throws(
					() =>
						applyRetirementInTransaction(db.connection, "TOKEN", Date.now()),
					/affected 0 rows/,
				);
				rollback(db.connection);
			} finally {
				db.close();
			}
			// The failed primitive produced no destructive effect: the
			// directory and its authority are untouched.
			assert.strictEqual(existsSync(runDir), true);
			assert.strictEqual(existsSync(join(runDir, "turnlock.sqlite3")), true);
		} finally {
			cleanupTempDir(root);
		}
	});
});
