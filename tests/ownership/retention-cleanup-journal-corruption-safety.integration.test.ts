import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { beforeEach, describe, test } from "node:test";
import { nodeSqliteDriver } from "../../src/persistence/sqlite/node-sqlite-driver.js";
import {
	beginImmediate,
	rollback,
} from "../../src/persistence/sqlite/ownership.js";
import {
	applyRetirementInTransaction,
	RETENTION_STATUS_RETIRING,
	readRetentionStatus,
} from "../../src/persistence/sqlite/retention-state.js";
import { openRunDatabase } from "../../src/persistence/sqlite/run-database.js";
import {
	captureRetiredPayloadIdentity,
	publishRetirementReadyMarker,
	RETIREMENT_READY_MARKER_VERSION,
	type RetirementReadyMarkerV1,
	retiredDirectoryName,
} from "../../src/services/retirement-journal.js";
import { cleanupOldRuns } from "../../src/services/run-dir.js";
import {
	RETIRED_DIR_NAME,
	RETIRED_PAYLOAD_DIR_NAME,
	RETIRED_READY_DIR_NAME,
	renameRunDirectoryToRetired,
} from "../../src/services/run-retirement.js";
import { cleanupTempDir, makeTempDir } from "../helpers/temp-run-dir.js";
import {
	ageDir,
	bootstrapForeignRun,
	claimB,
	expireLease,
	mutateRun,
	ORCHESTRATOR_NAME,
	productionRetirement,
	RUN_A,
	RUN_B,
	resetRetentionTestEnvironment,
} from "./retention-cleanup-scenario-setup.js";

beforeEach(resetRetentionTestEnvironment);

describe("retirement journal and corruption safety", () => {
	test("partial rm with the SQLite DB already gone finishes via the durable READY marker", () => {
		const root = makeTempDir();
		try {
			const runDirRoot = join(root, "runs");
			const runBDir = join(runDirRoot, ORCHESTRATOR_NAME, RUN_B);
			// 1. Genuine retired payload through the production flow.
			bootstrapForeignRun(runBDir, RUN_B);
			expireLease(runBDir);
			ageDir(runBDir, 100);
			const claim = claimB(runBDir);
			assert.strictEqual(claim.kind, "CLAIMED");
			if (claim.kind !== "CLAIMED") throw new Error("setup");
			const rename = renameRunDirectoryToRetired({
				driver: nodeSqliteDriver,
				runDir: runBDir,
				runId: RUN_B,
				retirementToken: claim.retirementToken,
				incarnationId: claim.incarnationId,
				databaseIdentity: claim.databaseIdentity,
			});
			assert.strictEqual(rename.kind, "RENAMED");
			if (rename.kind !== "RENAMED") throw new Error("setup");
			const retiredPath = rename.retiredPath;
			// 2. Establish the payload was legitimately RETIRING, then publish
			//    the durable READY marker (exactly what the full flow does).
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
			const identity = captureRetiredPayloadIdentity(retiredPath);
			assert.ok(identity, "payload identity must be capturable");
			const marker: RetirementReadyMarkerV1 = {
				version: RETIREMENT_READY_MARKER_VERSION,
				orchestratorName: claim.orchestratorName,
				runId: claim.runId,
				incarnationId: claim.incarnationId,
				retirementToken: claim.retirementToken,
				retirementClaimedAtEpochMs: claim.retirementClaimedAtEpochMs,
				retiredEntryName: retiredDirectoryName(RUN_B, claim.retirementToken),
				payloadIdentity: identity,
			};
			const published = publishRetirementReadyMarker({
				retiredRoot: join(dirname(runBDir), RETIRED_DIR_NAME),
				marker,
			});
			assert.strictEqual(published.kind, "PUBLISHED");
			// 3. The payload lives in .retired/payload.
			assert.ok(retiredPath.includes(RETIRED_PAYLOAD_DIR_NAME));
			// 4. Delete the internal SQLite authority and its sidecars while
			//    at least one other file remains in the payload.
			const leftoversDir = join(retiredPath, "leftovers");
			mkdirSync(leftoversDir);
			writeFileSync(join(leftoversDir, "keep.txt"), "leftover");
			rmSync(join(retiredPath, "turnlock.sqlite3"));
			rmSync(join(retiredPath, "turnlock.sqlite3-wal"), { force: true });
			rmSync(join(retiredPath, "turnlock.sqlite3-shm"), { force: true });
			assert.strictEqual(existsSync(join(leftoversDir, "keep.txt")), true);
			// 5. The sweep finishes the destruction via the READY marker —
			//    without the DB, and without recreating it.
			const deleted = cleanupOldRuns(
				root,
				ORCHESTRATOR_NAME,
				7,
				RUN_A,
				productionRetirement,
				runDirRoot,
			);
			assert.strictEqual(deleted, 1);
			assert.strictEqual(
				existsSync(retiredPath),
				false,
				"expected: partial retired payload with DB gone is fully deleted; actual: unrecoverable orphan",
			);
			assert.strictEqual(
				existsSync(join(retiredPath, "turnlock.sqlite3")),
				false,
				"the sweep must never recreate the payload database",
			);
			// The READY marker is consumed with the payload.
			assert.strictEqual(
				existsSync(
					join(
						dirname(runBDir),
						RETIRED_DIR_NAME,
						RETIRED_READY_DIR_NAME,
						`${marker.retiredEntryName}.json`,
					),
				),
				false,
			);
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
