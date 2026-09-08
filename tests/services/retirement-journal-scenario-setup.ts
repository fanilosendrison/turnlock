import assert from "node:assert/strict";
import { mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { STATE_SCHEMA_VERSION } from "../../src/constants.js";
import { nodeSqliteDriver } from "../../src/persistence/sqlite/node-sqlite-driver.js";
import { claimRunForRetentionDeletion } from "../../src/persistence/sqlite/retention-claim.js";
import { bootstrapNewRunAtomic } from "../../src/persistence/sqlite/run-bootstrap.js";
import { openRunDatabase } from "../../src/persistence/sqlite/run-database.js";
import {
	captureRetiredPayloadIdentity,
	RETIRED_PAYLOAD_DIR_NAME,
	type RetirementReadyMarkerV1,
	retiredDirectoryName,
} from "../../src/services/retirement-journal.js";

export const RUN_ID = "01HX000000000000000000000B";
export const ORCHESTRATOR_NAME = "journal-orch";
export const TOKEN = "01HX000000000000000000000C";

export function buildMarker(
	overrides: Partial<RetirementReadyMarkerV1> = {},
): RetirementReadyMarkerV1 {
	return {
		version: 1,
		orchestratorName: ORCHESTRATOR_NAME,
		runId: RUN_ID,
		incarnationId: "01HX000000000000000000000D",
		retirementToken: TOKEN,
		retirementClaimedAtEpochMs: 1234567890,
		retiredEntryName: retiredDirectoryName(RUN_ID, TOKEN),
		payloadIdentity: { dev: "16777220", ino: "42424242" },
		...overrides,
	};
}

/** Build a genuine retired payload: bootstrap, expire lease, claim, then
 * move the directory into the .retired/payload structure.
 */
export function makeRetiredPayload(root: string): {
	retiredRoot: string;
	payloadPath: string;
	entryName: string;
	dbPath: string;
} {
	const runDirRoot = join(root, "runs");
	const runDir = join(runDirRoot, ORCHESTRATOR_NAME, RUN_ID);
	mkdirSync(runDir, { recursive: true });
	const dbPath = join(runDir, "turnlock.sqlite3");
	const runDb = openRunDatabase({
		driver: nodeSqliteDriver,
		dbPath,
		busyTimeoutMs: 2000,
	});
	const now = Date.now();
	const iso = new Date(now).toISOString();
	const bootstrapped = bootstrapNewRunAtomic({
		db: runDb.connection,
		runId: RUN_ID,
		orchestratorName: ORCHESTRATOR_NAME,
		nowEpochMs: now,
		nowIso: iso,
		leaseDurationMs: 30 * 60 * 1000,
		initialState: {
			schemaVersion: STATE_SCHEMA_VERSION,
			runId: RUN_ID,
			orchestratorName: ORCHESTRATOR_NAME,
			startedAt: iso,
			startedAtEpochMs: now,
			lastTransitionAt: iso,
			lastTransitionAtEpochMs: now,
			currentPhase: "start",
			phasesExecuted: 0,
			accumulatedDurationMs: 0,
			data: {},
			usedLabels: [],
		},
		stateSchemaVersion: STATE_SCHEMA_VERSION,
		contentionDeadlineMs: 5000,
	});
	assert.strictEqual(bootstrapped.kind, "BOOTSTRAPPED");
	runDb.connection.exec(
		`UPDATE run_ownership SET lease_until_epoch_ms = ${Date.now() - 1000} WHERE singleton = 1`,
	);
	runDb.close();
	const claim = claimRunForRetentionDeletion({
		driver: nodeSqliteDriver,
		dbPath,
		runId: RUN_ID,
		busyTimeoutMs: 2000,
		contentionDeadlineMs: 5000,
	});
	assert.strictEqual(claim.kind, "CLAIMED");
	if (claim.kind !== "CLAIMED") throw new Error("setup");
	const retiredRoot = join(runDirRoot, ORCHESTRATOR_NAME, ".retired");
	const payloadDir = join(retiredRoot, RETIRED_PAYLOAD_DIR_NAME);
	mkdirSync(payloadDir, { recursive: true });
	const entryName = retiredDirectoryName(RUN_ID, claim.retirementToken);
	const payloadPath = join(payloadDir, entryName);
	renameSync(runDir, payloadPath);
	return {
		retiredRoot,
		payloadPath,
		entryName,
		dbPath: join(payloadPath, "turnlock.sqlite3"),
	};
}

export function markerForPayload(
	payloadPath: string,
	entryName: string,
	token: string,
	incarnationId: string,
	claimedAt: number,
	orchestratorName: string,
): RetirementReadyMarkerV1 {
	const identity = captureRetiredPayloadIdentity(payloadPath);
	assert.ok(identity, "payload identity must be capturable");
	return {
		version: 1,
		orchestratorName,
		runId: RUN_ID,
		incarnationId,
		retirementToken: token,
		retirementClaimedAtEpochMs: claimedAt,
		retiredEntryName: entryName,
		payloadIdentity: identity,
	};
}
