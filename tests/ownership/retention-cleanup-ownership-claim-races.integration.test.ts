import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { beforeEach, describe, test } from "node:test";
import {
	type RunOrchestratorInternalDependencies,
	runOrchestratorInternal,
} from "../../src/engine/run-orchestrator.js";
import { AuthorityLostError } from "../../src/errors/concrete.js";
import { nodeSqliteDriver } from "../../src/persistence/sqlite/node-sqlite-driver.js";
import {
	refreshOwnership,
	releaseOwnership,
} from "../../src/persistence/sqlite/ownership.js";
import { openRunDatabase } from "../../src/persistence/sqlite/run-database.js";
import {
	commitState,
	projectAuthoritativeStateFenced,
	type StateRecord,
} from "../../src/persistence/sqlite/run-state-store.js";
import { cleanupOldRuns } from "../../src/services/run-dir.js";
import {
	RETIRED_DIR_NAME,
	RETIRED_PAYLOAD_DIR_NAME,
} from "../../src/services/run-retirement.js";
import { cleanupTempDir, makeTempDir } from "../helpers/temp-run-dir.js";
import {
	acquireB,
	ageDir,
	bootstrapForeignRun,
	claimB,
	expireLease,
	makeConfig,
	ORCHESTRATOR_NAME,
	productionRetirement,
	type RetentionTestState,
	RUN_A,
	RUN_B,
	resetRetentionTestEnvironment,
	StopAfterCleanup,
} from "./retention-cleanup-scenario-setup.js";

// SQLite ownership and retirement claims serialize cleanup with acquisition.
beforeEach(resetRetentionTestEnvironment);

describe("retention cleanup ownership and claim races", () => {
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
						RETIRED_PAYLOAD_DIR_NAME,
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
});
