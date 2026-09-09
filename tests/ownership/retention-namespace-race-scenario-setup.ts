import assert from "node:assert/strict";
import { mkdirSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { STATE_SCHEMA_VERSION } from "../../src/constants.js";
import { nodeSqliteDriver } from "../../src/persistence/sqlite/node-sqlite-driver.js";
import { bootstrapNewRunAtomic } from "../../src/persistence/sqlite/run-bootstrap.js";
import { openRunDatabase } from "../../src/persistence/sqlite/run-database.js";
import { commitTerminalDone } from "../helpers/terminal-workflow.js";

export const ORCHESTRATOR_NAME = "retention-namespace-orch";
export const RUN_B = "01HX000000000000000000000B";
const DAY_MS = 24 * 60 * 60 * 1000;

export interface InitialWorkerResult {
	readonly kind: string;
	readonly incarnationId?: string | null;
	readonly ownershipStatus?: string | null;
	readonly leaseUntilEpochMs?: number | null;
	readonly reason?: string;
}

/** Bootstrap a genuine Turnlock run database via the production primitive. */
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
	assert.strictEqual(result.kind, "BOOTSTRAPPED");
	if (result.kind === "BOOTSTRAPPED") {
		commitTerminalDone(runDb.connection, result, Date.now() - 100 * DAY_MS);
	}
	runDb.close();
	return result;
}

export function expireLease(runDir: string): void {
	const dbPath = join(runDir, "turnlock.sqlite3");
	const runDb = openRunDatabase({
		driver: nodeSqliteDriver,
		dbPath,
		busyTimeoutMs: 2000,
	});
	runDb.connection.exec(
		`UPDATE run_ownership SET lease_until_epoch_ms = ${Date.now() - 1000} WHERE singleton = 1`,
	);
	runDb.close();
}

export function ageDir(dir: string, days: number): void {
	const old = new Date(Date.now() - days * DAY_MS);
	utimesSync(dir, old, old);
}
