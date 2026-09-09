import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, test } from "node:test";
import { cleanupOldRuns } from "../../src/services/run-dir.js";
import { cleanupTempDir, makeTempDir } from "../helpers/temp-run-dir.js";
import {
	ageDir,
	bootstrapForeignRun,
	expireLease,
	mutateRun,
	ORCHESTRATOR_NAME,
	productionRetirement,
	RUN_A,
	RUN_B,
	resetRetentionTestEnvironment,
} from "./retention-cleanup-scenario-setup.js";

beforeEach(resetRetentionTestEnvironment);

describe("retention eligibility and fail-closed selection", () => {
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
				retireRunDirectory: (
					runDir,
					runId,
					orchestratorName,
					retentionThresholdEpochMs,
				) => {
					retirements++;
					return productionRetirement.retireRunDirectory(
						runDir,
						runId,
						orchestratorName,
						retentionThresholdEpochMs,
					);
				},
				sweepRetiredDirectories: (retiredRoot, orchestratorName) =>
					productionRetirement.sweepRetiredDirectories(
						retiredRoot,
						orchestratorName,
					),
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
});
