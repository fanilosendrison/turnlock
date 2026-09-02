import assert from "node:assert/strict";
import { existsSync, mkdirSync, utimesSync } from "node:fs";
import { join } from "node:path";
// Simultaneous retention-cleanup vs ownership-takeover race.
//
// Two real processes contend on the same SQLite authority: one attempts
// the durable retirement claim (+ deletion on success), the other attempts
// a real ownership takeover.  The protocol linearizes both on the same
// BEGIN IMMEDIATE, so EXACTLY ONE side wins per round, and the forbidden
// interleaving — a valid ACQUIRED LockHandle whose RUN_DIR is deleted by
// retention — must never occur.
import { describe, test } from "node:test";
import { STATE_SCHEMA_VERSION } from "../../src/constants.js";
import { nodeSqliteDriver } from "../../src/persistence/sqlite/node-sqlite-driver.js";
import { bootstrapNewRunAtomic } from "../../src/persistence/sqlite/run-bootstrap.js";
import { openRunDatabase } from "../../src/persistence/sqlite/run-database.js";
import { spawnNode } from "../helpers/node-subprocess.js";
import { cleanupTempDir, makeTempDir } from "../helpers/temp-run-dir.js";

const ORCHESTRATOR_NAME = "retention-race-orch";
const RUN_ID = "01HX000000000000000000000B";
const DAY_MS = 24 * 60 * 60 * 1000;

function seedExpiredForeignRun(runDir: string): void {
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
		runId: RUN_ID,
		orchestratorName: ORCHESTRATOR_NAME,
		nowEpochMs,
		nowIso,
		leaseDurationMs: 30 * 60 * 1000,
		initialState: {
			schemaVersion: STATE_SCHEMA_VERSION,
			runId: RUN_ID,
			orchestratorName: ORCHESTRATOR_NAME,
			startedAt: nowIso,
			startedAtEpochMs: nowEpochMs,
			lastTransitionAt: nowIso,
			lastTransitionAtEpochMs: nowEpochMs,
			currentPhase: "start",
			phasesExecuted: 0,
			accumulatedDurationMs: 0,
			data: {},
			usedLabels: [],
		},
		stateSchemaVersion: STATE_SCHEMA_VERSION,
		contentionDeadlineMs: 5000,
	});
	assert.strictEqual(result.kind, "BOOTSTRAPPED");
	// Adversarial initial state: HELD with an expired lease — both the
	// takeover and the retirement claim consider it a valid target.
	runDb.connection.exec(
		`UPDATE run_ownership SET lease_until_epoch_ms = ${Date.now() - 1000} WHERE singleton = 1`,
	);
	runDb.close();
	// Retention-eligible mtime (aged AFTER every DB open that could
	// refresh the directory mtime via WAL sidecar files).
	const old = new Date(Date.now() - 100 * DAY_MS);
	utimesSync(runDir, old, old);
}

function spawnWorker(
	workerScript: string,
	args: readonly string[],
	env: Readonly<Record<string, string>>,
): Promise<{ stdout: string; exitCode: number }> {
	const subprocess = spawnNode(workerScript, args, { env });
	return subprocess.exited.then(async (exitCode) => ({
		stdout: await subprocess.stdout,
		exitCode,
	}));
}

describe("retention cleanup vs takeover race", () => {
	test("exactly one side wins; ACQUIRED and deletion are mutually exclusive", {
		timeout: 120000,
	}, async () => {
		const ROUNDS = 5;
		const workerScript = join(
			import.meta.dirname,
			"fixtures",
			"retention-race-worker.js",
		);
		for (let round = 0; round < ROUNDS; round++) {
			const root = makeTempDir();
			try {
				const runDir = join(root, "runs", ORCHESTRATOR_NAME, RUN_ID);
				seedExpiredForeignRun(runDir);
				const env = {
					...process.env,
					TL_DB_PATH: join(runDir, "turnlock.sqlite3"),
					TL_RUN_ID: RUN_ID,
					TL_ORCH: ORCHESTRATOR_NAME,
					TL_RUN_DIR: runDir,
				};
				const [cleanupProc, resumeProc] = await Promise.all([
					spawnWorker(workerScript, ["--cleanup"], env),
					spawnWorker(workerScript, ["--resume"], env),
				]);
				const cleanupReport = JSON.parse(cleanupProc.stdout.trim()) as {
					claim: string;
					deleted: boolean;
				};
				const resumeReport = JSON.parse(resumeProc.stdout.trim()) as {
					result: string;
				};
				const dirExists = existsSync(runDir);
				// Forbidden interleaving: a valid ownership acquisition AND a
				// deletion of the same RUN_DIR.
				assert.ok(
					!(resumeReport.result === "ACQUIRED" && !dirExists),
					`round ${round}: ACQUIRED LockHandle + RUN_DIR deleted — forbidden: ${JSON.stringify({ cleanupReport, resumeReport })}`,
				);
				// Exactly one side wins.
				const resumeWon = resumeReport.result === "ACQUIRED";
				const cleanupWon = cleanupReport.claim === "CLAIMED";
				assert.ok(
					resumeWon !== cleanupWon,
					`round ${round}: exactly one side must win — resume=${resumeReport.result} cleanup=${cleanupReport.claim}`,
				);
				if (cleanupWon) {
					assert.strictEqual(cleanupReport.deleted, true);
					assert.ok(
						!dirExists,
						`round ${round}: cleanup won, directory must be deleted`,
					);
				} else {
					assert.ok(
						dirExists,
						`round ${round}: resume won, directory must survive: ${JSON.stringify({ cleanupReport, resumeReport })}`,
					);
				}
			} finally {
				cleanupTempDir(root);
			}
		}
	});
});
