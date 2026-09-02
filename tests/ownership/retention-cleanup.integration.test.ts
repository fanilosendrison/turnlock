import assert from "node:assert/strict";
import { existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
// Retention cleanup safety — adversarial integration tests.
//
// Invariant: a RUN_DIR whose SQLite ownership is still HELD with a live
// lease must never be deleted by the retention cleanup, even when the
// directory is old, foreign, and past the retention threshold.
import { beforeEach, describe, test } from "node:test";
import { STATE_SCHEMA_VERSION } from "../../src/constants.js";
import {
	type RunOrchestratorInternalDependencies,
	runOrchestratorInternal,
} from "../../src/engine/run-orchestrator.js";
import { nodeSqliteDriver } from "../../src/persistence/sqlite/node-sqlite-driver.js";
import { bootstrapNewRunAtomic } from "../../src/persistence/sqlite/run-bootstrap.js";
import { openRunDatabase } from "../../src/persistence/sqlite/run-database.js";
import { createRunRetentionProtection } from "../../src/persistence/sqlite/run-liveness.js";
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

const productionProtection = createRunRetentionProtection(nodeSqliteDriver);

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
 *  Ownership is HELD with a live lease (now + 30min) and remains so after
 *  the connection is closed — exactly what a foreign live process leaves
 *  behind from the perspective of the cleanup. */
function bootstrapForeignRun(
	runDir: string,
	runId: string,
): { leaseUntilEpochMs: number } {
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
	return { leaseUntilEpochMs: result.handle.leaseUntilEpochMs };
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

function ageDir(dir: string, days: number): void {
	const old = new Date(Date.now() - days * DAY_MS);
	utimesSync(dir, old, old);
}

describe("retention cleanup safety", () => {
	test("foreign run with live SQLite ownership survives orchestrator retention cleanup", async () => {
		const root = makeTempDir();
		try {
			const runDirRoot = join(root, "runs");
			const runBDir = join(runDirRoot, ORCHESTRATOR_NAME, RUN_B);
			// 1. run B holds a genuine, currently-valid SQLite ownership.
			const seeded = bootstrapForeignRun(runBDir, RUN_B);
			assert.ok(
				seeded.leaseUntilEpochMs > Date.now(),
				"test setup: run B lease must still be alive",
			);
			// 2. Make run B's RUN_DIR old enough to be retention-eligible
			//    while its ownership lease is still alive.
			ageDir(runBDir, 100);
			// 3. Trigger the real cleanup through the real orchestrator path.
			//    The beforeInitialDispatchClaim hook fires right after the
			//    retention cleanup and stops the run before phase execution.
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

	test("foreign run with live lease is kept by cleanupOldRuns under the production policy", () => {
		const root = makeTempDir();
		try {
			const runDirRoot = join(root, "runs");
			const runBDir = join(runDirRoot, ORCHESTRATOR_NAME, RUN_B);
			bootstrapForeignRun(runBDir, RUN_B);
			ageDir(runBDir, 100);
			const deleted = cleanupOldRuns(
				root,
				ORCHESTRATOR_NAME,
				7,
				RUN_A,
				productionProtection,
				runDirRoot,
			);
			assert.strictEqual(deleted, 0);
			assert.strictEqual(existsSync(runBDir), true);
			assert.strictEqual(existsSync(join(runBDir, "turnlock.sqlite3")), true);
		} finally {
			cleanupTempDir(root);
		}
	});

	test("foreign run with expired lease and old directory is deleted", () => {
		const root = makeTempDir();
		try {
			const runDirRoot = join(root, "runs");
			const runBDir = join(runDirRoot, ORCHESTRATOR_NAME, RUN_B);
			bootstrapForeignRun(runBDir, RUN_B);
			// Turnlock semantics: a HELD ownership whose lease expired may be
			// taken over via CAS.  Retention deletion of a run that is both
			// lease-expired AND past the retention threshold is the designed
			// policy — the protection must not disable retention wholesale.
			mutateOwnership(
				runBDir,
				`UPDATE run_ownership SET lease_until_epoch_ms = ${Date.now() - 1000} WHERE singleton = 1`,
			);
			ageDir(runBDir, 100);
			const deleted = cleanupOldRuns(
				root,
				ORCHESTRATOR_NAME,
				7,
				RUN_A,
				productionProtection,
				runDirRoot,
			);
			assert.strictEqual(deleted, 1);
			assert.strictEqual(existsSync(runBDir), false);
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
			mutateOwnership(
				runBDir,
				`UPDATE run_ownership SET lease_until_epoch_ms = ${Date.now() - 1000} WHERE singleton = 1`,
			);
			// Fresh directory — below the retention threshold, so it must not
			// be deleted regardless of the expired lease.
			const deleted = cleanupOldRuns(
				root,
				ORCHESTRATOR_NAME,
				7,
				RUN_A,
				productionProtection,
				runDirRoot,
			);
			assert.strictEqual(deleted, 0);
			assert.strictEqual(existsSync(runBDir), true);
		} finally {
			cleanupTempDir(root);
		}
	});

	test("current run is kept regardless of age and live ownership", () => {
		const root = makeTempDir();
		try {
			const runDirRoot = join(root, "runs");
			const runADir = join(runDirRoot, ORCHESTRATOR_NAME, RUN_A);
			bootstrapForeignRun(runADir, RUN_A);
			ageDir(runADir, 100);
			const deleted = cleanupOldRuns(
				root,
				ORCHESTRATOR_NAME,
				7,
				RUN_A,
				productionProtection,
				runDirRoot,
			);
			assert.strictEqual(deleted, 0);
			assert.strictEqual(existsSync(runADir), true);
		} finally {
			cleanupTempDir(root);
		}
	});

	test("old directory with an unreadable database is kept (fail-closed)", () => {
		const root = makeTempDir();
		try {
			const runDirRoot = join(root, "runs");
			const runBDir = join(runDirRoot, ORCHESTRATOR_NAME, RUN_B);
			mkdirSync(runBDir, { recursive: true });
			writeFileSync(join(runBDir, "turnlock.sqlite3"), "not a sqlite db");
			ageDir(runBDir, 100);
			const deleted = cleanupOldRuns(
				root,
				ORCHESTRATOR_NAME,
				7,
				RUN_A,
				productionProtection,
				runDirRoot,
			);
			assert.strictEqual(deleted, 0);
			assert.strictEqual(existsSync(runBDir), true);
		} finally {
			cleanupTempDir(root);
		}
	});

	test("old directory with incoherent HELD ownership (null lease) is kept", () => {
		const root = makeTempDir();
		try {
			const runDirRoot = join(root, "runs");
			const runBDir = join(runDirRoot, ORCHESTRATOR_NAME, RUN_B);
			bootstrapForeignRun(runBDir, RUN_B);
			mutateOwnership(
				runBDir,
				"UPDATE run_ownership SET lease_until_epoch_ms = NULL WHERE singleton = 1",
			);
			ageDir(runBDir, 100);
			const deleted = cleanupOldRuns(
				root,
				ORCHESTRATOR_NAME,
				7,
				RUN_A,
				productionProtection,
				runDirRoot,
			);
			assert.strictEqual(deleted, 0);
			assert.strictEqual(existsSync(runBDir), true);
		} finally {
			cleanupTempDir(root);
		}
	});

	test("old directory without any SQLite database is deleted (legacy behavior)", () => {
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
				productionProtection,
				runDirRoot,
			);
			assert.strictEqual(deleted, 1);
			assert.strictEqual(existsSync(runBDir), false);
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
				productionProtection,
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

	test("retentionDays = 0 deletes old unprotected directories and keeps the current run", () => {
		const root = makeTempDir();
		try {
			const runDirRoot = join(root, "runs");
			const base = join(runDirRoot, ORCHESTRATOR_NAME);
			const oldLegacyDir = join(base, RUN_B);
			mkdirSync(oldLegacyDir, { recursive: true });
			ageDir(oldLegacyDir, 1);
			const currentDir = join(base, RUN_A);
			mkdirSync(currentDir, { recursive: true });
			ageDir(currentDir, 100);
			const deleted = cleanupOldRuns(
				root,
				ORCHESTRATOR_NAME,
				0,
				RUN_A,
				productionProtection,
				runDirRoot,
			);
			assert.strictEqual(deleted, 1);
			assert.strictEqual(existsSync(oldLegacyDir), false);
			assert.strictEqual(existsSync(currentDir), true);
		} finally {
			cleanupTempDir(root);
		}
	});
});
