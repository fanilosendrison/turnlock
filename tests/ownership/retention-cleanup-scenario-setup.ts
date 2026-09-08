import assert from "node:assert/strict";
import { mkdirSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { STATE_SCHEMA_VERSION } from "../../src/constants.js";
import { nodeSqliteDriver } from "../../src/persistence/sqlite/node-sqlite-driver.js";
import { acquireOwnership } from "../../src/persistence/sqlite/ownership.js";
import { claimRunForRetentionDeletion } from "../../src/persistence/sqlite/retention-claim.js";
import { bootstrapNewRunAtomic } from "../../src/persistence/sqlite/run-bootstrap.js";
import { openRunDatabase } from "../../src/persistence/sqlite/run-database.js";
import { buildRunRetirement } from "../../src/services/run-retirement.js";
import type { OrchestratorConfig } from "../../src/types/config.js";

export const ORCHESTRATOR_NAME = "retention-orch";
export const RUN_A = "01HX000000000000000000000A";
export const RUN_B = "01HX000000000000000000000B";
const DAY_MS = 24 * 60 * 60 * 1000;

export interface RetentionTestState {
	readonly stage: string;
}

/** Hook abort marker: the orchestrator reached the post-cleanup boundary. */
export class StopAfterCleanup extends Error {}

export const productionRetirement = buildRunRetirement(nodeSqliteDriver);

export function resetRetentionTestEnvironment(): void {
	delete process.env.TURNLOCK_RUN_DIR_ROOT;
}

export function makeConfig(
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
 * Ownership is HELD with a live lease (now + 30min). Returns the bootstrap
 * result (including the LockHandle) for fencing proofs.
 */
export function bootstrapForeignRun(
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
export function mutateRun(runDir: string, sql: string): void {
	const dbPath = join(runDir, "turnlock.sqlite3");
	const runDb = openRunDatabase({
		driver: nodeSqliteDriver,
		dbPath,
		busyTimeoutMs: 2000,
	});
	runDb.connection.exec(sql);
	runDb.close();
}

export function expireLease(runDir: string): void {
	mutateRun(
		runDir,
		`UPDATE run_ownership SET lease_until_epoch_ms = ${Date.now() - 1000} WHERE singleton = 1`,
	);
}

export function ageDir(dir: string, days: number): void {
	const old = new Date(Date.now() - days * DAY_MS);
	utimesSync(dir, old, old);
}

export function claimB(runDir: string, runId = RUN_B) {
	return claimRunForRetentionDeletion({
		driver: nodeSqliteDriver,
		dbPath: join(runDir, "turnlock.sqlite3"),
		runId,
		busyTimeoutMs: 2000,
		contentionDeadlineMs: 5000,
	});
}

export function acquireB(runDir: string, runId = RUN_B) {
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
