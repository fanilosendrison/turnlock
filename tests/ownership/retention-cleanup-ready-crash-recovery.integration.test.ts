import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { beforeEach, describe, test } from "node:test";
import { nodeSqliteDriver } from "../../src/persistence/sqlite/node-sqlite-driver.js";
import {
	captureRetiredPayloadIdentity,
	publishRetirementReadyMarker,
	RETIREMENT_READY_MARKER_VERSION,
	type RetirementReadyMarkerV1,
	retiredDirectoryName,
} from "../../src/services/retirement-journal.js";
import { cleanupOldRuns } from "../../src/services/run-dir.js";
import {
	deleteRetiredRunDirectory,
	RETIRED_DIR_NAME,
	RETIRED_READY_DIR_NAME,
	renameRunDirectoryToRetired,
} from "../../src/services/run-retirement.js";
import { cleanupTempDir, makeTempDir } from "../helpers/temp-run-dir.js";
import {
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

describe("READY crash recovery", () => {
	test("crash C | after READY before rm: the sweep deletes the payload via the marker", () => {
		const root = makeTempDir();
		try {
			const runDirRoot = join(root, "runs");
			const runBDir = join(runDirRoot, ORCHESTRATOR_NAME, RUN_B);
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
			const identity = captureRetiredPayloadIdentity(rename.retiredPath);
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
			assert.strictEqual(
				publishRetirementReadyMarker({
					retiredRoot: join(dirname(runBDir), RETIRED_DIR_NAME),
					marker,
				}).kind,
				"PUBLISHED",
			);
			// Crash before rm: READY + full payload.
			const deleted = cleanupOldRuns(
				root,
				ORCHESTRATOR_NAME,
				7,
				RUN_A,
				productionRetirement,
				runDirRoot,
			);
			assert.strictEqual(deleted, 1);
			assert.strictEqual(existsSync(rename.retiredPath), false);
		} finally {
			cleanupTempDir(root);
		}
	});

	test("crash E | after payload gone before READY removal: the sweep removes the marker", () => {
		const root = makeTempDir();
		try {
			const runDirRoot = join(root, "runs");
			const runBDir = join(runDirRoot, ORCHESTRATOR_NAME, RUN_B);
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
			const identity = captureRetiredPayloadIdentity(rename.retiredPath);
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
			assert.strictEqual(
				publishRetirementReadyMarker({
					retiredRoot: join(dirname(runBDir), RETIRED_DIR_NAME),
					marker,
				}).kind,
				"PUBLISHED",
			);
			// Crash state: rm completed but the marker removal did not.
			const deletion = deleteRetiredRunDirectory(rename.retiredPath);
			assert.strictEqual(deletion.kind, "DELETED");
			const markerPath = join(
				dirname(runBDir),
				RETIRED_DIR_NAME,
				RETIRED_READY_DIR_NAME,
				`${marker.retiredEntryName}.json`,
			);
			assert.strictEqual(existsSync(markerPath), true);
			const deleted = cleanupOldRuns(
				root,
				ORCHESTRATOR_NAME,
				7,
				RUN_A,
				productionRetirement,
				runDirRoot,
			);
			assert.strictEqual(deleted, 1);
			assert.strictEqual(existsSync(markerPath), false);
		} finally {
			cleanupTempDir(root);
		}
	});
});
