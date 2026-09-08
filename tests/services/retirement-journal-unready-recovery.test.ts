import assert from "node:assert/strict";
import {
	existsSync,
	mkdirSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { STATE_SCHEMA_VERSION } from "../../src/constants.js";
import { nodeSqliteDriver } from "../../src/persistence/sqlite/node-sqlite-driver.js";
import { bootstrapNewRunAtomic } from "../../src/persistence/sqlite/run-bootstrap.js";
import { openRunDatabase } from "../../src/persistence/sqlite/run-database.js";
import {
	RETIRED_PAYLOAD_DIR_NAME,
	RETIRED_READY_DIR_NAME,
	retiredDirectoryName,
	sweepUnreadyRetiredPayloads,
} from "../../src/services/retirement-journal.js";
import { cleanupTempDir, makeTempDir } from "../helpers/temp-run-dir.js";
import {
	makeRetiredPayload,
	ORCHESTRATOR_NAME,
	RUN_ID,
	TOKEN,
} from "./retirement-journal-scenario-setup.js";

describe("retirement READY journal — UNREADY recovery", () => {
	test("valid RETIRING DB without marker → READY published, payload deleted", () => {
		const root = makeTempDir();
		try {
			const { retiredRoot, payloadPath, entryName } = makeRetiredPayload(root);
			assert.strictEqual(
				existsSync(
					join(retiredRoot, RETIRED_READY_DIR_NAME, `${entryName}.json`),
				),
				false,
			);
			const completed = sweepUnreadyRetiredPayloads({
				driver: nodeSqliteDriver,
				retiredRoot,
			});
			assert.strictEqual(completed, 1);
			assert.strictEqual(existsSync(payloadPath), false);
			// The transient READY marker is removed after completion.
			assert.strictEqual(
				existsSync(
					join(retiredRoot, RETIRED_READY_DIR_NAME, `${entryName}.json`),
				),
				false,
			);
		} finally {
			cleanupTempDir(root);
		}
	});

	test("payload with missing DB → KEEP, DB not recreated", () => {
		const root = makeTempDir();
		try {
			const { retiredRoot, payloadPath, entryName, dbPath } =
				makeRetiredPayload(root);
			rmSync(dbPath);
			writeFileSync(join(payloadPath, "leftover.txt"), "leftover");
			const completed = sweepUnreadyRetiredPayloads({
				driver: nodeSqliteDriver,
				retiredRoot,
			});
			assert.strictEqual(completed, 0);
			assert.strictEqual(existsSync(payloadPath), true);
			assert.strictEqual(
				existsSync(dbPath),
				false,
				"inspection must never recreate the database",
			);
			assert.strictEqual(existsSync(join(payloadPath, "leftover.txt")), true);
			assert.strictEqual(
				existsSync(
					join(retiredRoot, RETIRED_READY_DIR_NAME, `${entryName}.json`),
				),
				false,
			);
		} finally {
			cleanupTempDir(root);
		}
	});

	test("ACTIVE (never claimed) payload DB → KEEP", () => {
		const root = makeTempDir();
		try {
			const runDirRoot = join(root, "runs");
			const runDir = join(runDirRoot, ORCHESTRATOR_NAME, RUN_ID);
			mkdirSync(runDir, { recursive: true });
			const runDb = openRunDatabase({
				driver: nodeSqliteDriver,
				dbPath: join(runDir, "turnlock.sqlite3"),
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
			runDb.close();
			const retiredRoot = join(runDirRoot, ORCHESTRATOR_NAME, ".retired");
			const payloadDir = join(retiredRoot, RETIRED_PAYLOAD_DIR_NAME);
			mkdirSync(payloadDir, { recursive: true });
			const entryName = retiredDirectoryName(RUN_ID, TOKEN);
			const payloadPath = join(payloadDir, entryName);
			renameSync(runDir, payloadPath);
			const completed = sweepUnreadyRetiredPayloads({
				driver: nodeSqliteDriver,
				retiredRoot,
			});
			assert.strictEqual(completed, 0);
			assert.strictEqual(existsSync(payloadPath), true);
		} finally {
			cleanupTempDir(root);
		}
	});
});
