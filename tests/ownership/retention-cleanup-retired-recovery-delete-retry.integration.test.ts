import assert from "node:assert/strict";
import { chmodSync, existsSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, test } from "node:test";
import { nodeSqliteDriver } from "../../src/persistence/sqlite/node-sqlite-driver.js";
import {
	RETENTION_STATUS_RETIRING,
	readRetentionStatus,
} from "../../src/persistence/sqlite/retention-state.js";
import { openRunDatabase } from "../../src/persistence/sqlite/run-database.js";
import { cleanupOldRuns } from "../../src/services/run-dir.js";
import {
	deleteRetiredRunDirectory,
	renameRunDirectoryToRetired,
} from "../../src/services/run-retirement.js";
import { cleanupTempDir, makeTempDir } from "../helpers/temp-run-dir.js";
import {
	acquireB,
	ageDir,
	bootstrapForeignRun,
	claimB,
	expireLease,
	ORCHESTRATOR_NAME,
	productionRetirement,
	RUN_A,
	RUN_B,
	resetRetentionTestEnvironment,
} from "./retention-cleanup-scenario-setup.js";

beforeEach(resetRetentionTestEnvironment);

describe("retired recovery and deletion retry", () => {
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
				incarnationId: claim.incarnationId,
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
			const runDir = join(root, "runs", ORCHESTRATOR_NAME, RUN_B);
			bootstrapForeignRun(runDir, RUN_B);
			expireLease(runDir);
			ageDir(runDir, 100);
			// 1. Claim + atomic rename succeed (production primitives).
			const claim = claimB(runDir);
			assert.strictEqual(claim.kind, "CLAIMED");
			if (claim.kind !== "CLAIMED") throw new Error("setup");
			const rename = renameRunDirectoryToRetired({
				driver: nodeSqliteDriver,
				runDir,
				runId: RUN_B,
				retirementToken: claim.retirementToken,
				incarnationId: claim.incarnationId,
				databaseIdentity: claim.databaseIdentity,
			});
			assert.strictEqual(rename.kind, "RENAMED");
			if (rename.kind !== "RENAMED") throw new Error("setup");
			assert.strictEqual(existsSync(runDir), false);
			// 2. Make the RETIRED directory undeletable (deterministic rm
			//    failure — no reliance on readdir order or partial rm): the
			//    recursive delete fails on every child.
			chmodSync(rename.retiredPath, 0o555);
			const deletion = deleteRetiredRunDirectory(rename.retiredPath);
			assert.strictEqual(deletion.kind, "FAILED");
			assert.strictEqual(existsSync(rename.retiredPath), true);
			chmodSync(rename.retiredPath, 0o755);
			// 3. The retired DB stays RETIRING and refuses new ownership.
			const checkDb = openRunDatabase({
				driver: nodeSqliteDriver,
				dbPath: join(rename.retiredPath, "turnlock.sqlite3"),
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
			const takeover = acquireB(rename.retiredPath);
			assert.strictEqual(takeover.kind, "RUN_RETIRING");
			// 4. A future cleanup sweep completes the deletion.
			const deletedRetry = cleanupOldRuns(
				root,
				ORCHESTRATOR_NAME,
				7,
				RUN_A,
				productionRetirement,
				join(root, "runs"),
			);
			assert.strictEqual(deletedRetry, 1);
			assert.strictEqual(existsSync(rename.retiredPath), false);
		} finally {
			cleanupTempDir(root);
		}
	});
});
