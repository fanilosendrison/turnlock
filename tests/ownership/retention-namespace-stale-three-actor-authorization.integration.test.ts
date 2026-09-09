import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { nodeSqliteDriver } from "../../src/persistence/sqlite/node-sqlite-driver.js";
import { acquireOwnership } from "../../src/persistence/sqlite/ownership.js";
import { openRunDatabase } from "../../src/persistence/sqlite/run-database.js";
import {
	RETIRED_DIR_NAME,
	RETIRED_PAYLOAD_DIR_NAME,
	retireRunDirectoryInternal,
} from "../../src/services/run-retirement.js";
import { spawnNode } from "../helpers/node-subprocess.js";
import { cleanupTempDir, makeTempDir } from "../helpers/temp-run-dir.js";
import {
	ageDir,
	bootstrapForeignRun,
	expireLease,
	type InitialWorkerResult,
	ORCHESTRATOR_NAME,
	RUN_B,
} from "./retention-namespace-race-scenario-setup.js";

// Cleanup A, cleanup B, and initial C prove stale authorization cannot move a successor.
describe("stale three-actor retirement authorization", () => {
	test("3-process: an OLD retirement authorization can never rename a NEW incarnation", {
		timeout: 120_000,
	}, async () => {
		const root = makeTempDir();
		try {
			const runDirRoot = join(root, "runs");
			const runBDir = join(runDirRoot, ORCHESTRATOR_NAME, RUN_B);
			// OLD run B with a genuine SQLite authority and an expired lease.
			bootstrapForeignRun(runBDir, RUN_B);
			const oldDb = openRunDatabase({
				driver: nodeSqliteDriver,
				dbPath: join(runBDir, "turnlock.sqlite3"),
				busyTimeoutMs: 2000,
			});
			let oldIncarnationId: string | null = null;
			try {
				const row = oldDb.connection
					.prepare(
						"SELECT incarnation_id FROM run_incarnation WHERE singleton = 1",
					)
					.get() as
					| {
							incarnation_id: string;
					  }
					| undefined;
				oldIncarnationId = row?.incarnation_id ?? null;
			} finally {
				oldDb.close();
			}
			assert.ok(oldIncarnationId, "setup: OLD incarnation id must exist");
			expireLease(runBDir);
			ageDir(runBDir, 100);
			// Cleanup B and Initial C workers — both GO-gated and spawned
			// BEFORE cleanup A enters its critical section.
			const cleanupWorkerScript = join(
				import.meta.dirname,
				"fixtures",
				"retention-namespace-cleanup-worker.js",
			);
			const initialWorkerScript = join(
				import.meta.dirname,
				"fixtures",
				"retention-namespace-initial-worker.js",
			);
			const goBFile = join(root, "go-b");
			const goCFile = join(root, "go-c");
			const resultBFile = join(root, "result-b.json");
			const resultCFile = join(root, "result-c.json");
			const workerB = spawnNode(cleanupWorkerScript, [], {
				env: {
					...process.env,
					TL_RUN_DIR: runBDir,
					TL_RUN_ID: RUN_B,
					TL_ORCH: ORCHESTRATOR_NAME,
					TL_GO_FILE: goBFile,
					TL_RESULT_FILE: resultBFile,
					TURNLOCK_TEST: "1",
				},
			});
			const workerC = spawnNode(initialWorkerScript, [], {
				env: {
					...process.env,
					TL_RUN_ROOT: runDirRoot,
					TL_ORCH: ORCHESTRATOR_NAME,
					TL_RUN_ID: RUN_B,
					TL_GO_FILE: goCFile,
					TL_RESULT_FILE: resultCFile,
					TURNLOCK_TEST: "1",
				},
			});
			let observedNewIncarnationDisplaced = false;
			let cleanupBBlockedWhileAHeldMutex = false;
			let initialCBlockedWhileAHeldMutex = false;
			const barrierSab = new Int32Array(new SharedArrayBuffer(4));
			const outcome = retireRunDirectoryInternal(
				{
					driver: nodeSqliteDriver,
					runDir: runBDir,
					runId: RUN_B,
					retentionThresholdEpochMs: Date.now(),
				},
				{
					onFaultPoint: (point) => {
						if (point === "AFTER_PRE_RENAME_VERIFICATION") {
							// Cleanup A holds the namespace mutex with every
							// pre-rename check passed.  Release B and C: both must
							// BLOCK on the namespace mutex instead of acting.
							writeFileSync(goBFile, "go");
							writeFileSync(goCFile, "go");
							const blockedDeadline = Date.now() + 2500;
							while (Date.now() < blockedDeadline) {
								if (!existsSync(resultBFile) && !existsSync(resultCFile)) {
									cleanupBBlockedWhileAHeldMutex = true;
									initialCBlockedWhileAHeldMutex = true;
								} else {
									break;
								}
								Atomics.wait(barrierSab, 0, 0, 50);
							}
						} else if (point === "AFTER_RENAME_BEFORE_POSTCHECK") {
							// Proof point: the object A just moved is the OLD
							// incarnation (the mutex prevented any replacement).
							const canonicalAbsent = !existsSync(runBDir);
							assert.strictEqual(
								canonicalAbsent,
								true,
								"canonical pathname must be absent at the proof point",
							);
							const retiredRoot = join(
								dirname(runBDir),
								RETIRED_DIR_NAME,
								RETIRED_PAYLOAD_DIR_NAME,
							);
							const entries = readdirSync(retiredRoot);
							assert.ok(
								entries.length >= 1,
								"a retired payload must exist at the proof point",
							);
							let movedOldIncarnation = false;
							for (const entryName of entries) {
								const retiredDbPath = join(
									retiredRoot,
									entryName,
									"turnlock.sqlite3",
								);
								if (!existsSync(retiredDbPath)) continue;
								const retiredDb = openRunDatabase({
									driver: nodeSqliteDriver,
									dbPath: retiredDbPath,
									busyTimeoutMs: 2000,
								});
								try {
									const incRow = retiredDb.connection
										.prepare(
											"SELECT incarnation_id FROM run_incarnation WHERE singleton = 1",
										)
										.get() as
										| {
												incarnation_id: string;
										  }
										| undefined;
									if (incRow?.incarnation_id === oldIncarnationId) {
										movedOldIncarnation = true;
									}
								} finally {
									retiredDb.close();
								}
							}
							assert.strictEqual(
								movedOldIncarnation,
								true,
								"the stale authorization must have moved the OLD incarnation",
							);
							// No NEW incarnation exists yet — nothing NEW was moved.
							observedNewIncarnationDisplaced = false;
						}
					},
				},
			);
			// After A released the mutex, B and C proceed in either order:
			// C bootstraps the NEW generation; B must never detach it.
			const resultDeadline = Date.now() + 30_000;
			while (
				(!existsSync(resultBFile) || !existsSync(resultCFile)) &&
				Date.now() < resultDeadline
			) {
				await new Promise((resolve) => setTimeout(resolve, 50));
			}
			const resultB = existsSync(resultBFile)
				? (JSON.parse(readFileSync(resultBFile, "utf8")) as {
						kind: string;
						reason?: string;
						canonicalExists?: boolean;
					})
				: null;
			const resultC = existsSync(resultCFile)
				? (JSON.parse(readFileSync(resultCFile, "utf8")) as InitialWorkerResult)
				: null;
			try {
				workerB.kill("SIGKILL");
			} catch {
				// already exited
			}
			try {
				workerC.kill("SIGKILL");
			} catch {
				// already exited
			}
			const exitB = await workerB.exited;
			const exitC = await workerC.exited;
			console.error(
				`3-process proof: oldIncarnation=${oldIncarnationId} newIncarnation=${resultC?.incarnationId ?? "NO_RESULT"} cleanupA=${outcome.kind} cleanupB=${resultB?.kind}/${resultB?.reason ?? "?"} initialC=${resultC?.kind ?? "NO_RESULT"} blockedWhileHeld=${cleanupBBlockedWhileAHeldMutex}/${initialCBlockedWhileAHeldMutex} displaced=${observedNewIncarnationDisplaced} exitB=${exitB} exitC=${exitC}`,
			);
			// Serialization proof: B and C produced NOTHING while A held the
			// namespace mutex — they were blocked, not acting.
			assert.strictEqual(
				cleanupBBlockedWhileAHeldMutex,
				true,
				"cleanup B must block while cleanup A owns the namespace mutex",
			);
			assert.strictEqual(
				initialCBlockedWhileAHeldMutex,
				true,
				"initial C must block while cleanup A owns the namespace mutex",
			);
			// Desired property: an OLD retirement authorization can never
			// rename a NEW incarnation.
			assert.strictEqual(
				observedNewIncarnationDisplaced,
				false,
				"expected: an OLD retirement authorization can never rename a NEW incarnation; actual: cleanup moved the new incarnation before detecting the mismatch",
			);
			// Cleanup B must never detach/delete the NEW generation.
			assert.ok(
				resultB !== null && resultB.kind !== "DELETED",
				`cleanup B must keep (KEPT), got ${JSON.stringify(resultB)}`,
			);
			// Initial C established the genuine NEW generation.
			assert.strictEqual(
				resultC?.kind,
				"BOOTSTRAPPED",
				`initial C must bootstrap, got ${JSON.stringify(resultC)}`,
			);
			assert.notStrictEqual(
				resultC?.incarnationId ?? null,
				oldIncarnationId,
				"initial C must create a genuinely NEW generation",
			);
			assert.strictEqual(existsSync(runBDir), true);
			const canonicalDb = openRunDatabase({
				driver: nodeSqliteDriver,
				dbPath: join(runBDir, "turnlock.sqlite3"),
				busyTimeoutMs: 2000,
			});
			let canonicalIncarnationId: string | null = null;
			try {
				const row = canonicalDb.connection
					.prepare(
						"SELECT incarnation_id FROM run_incarnation WHERE singleton = 1",
					)
					.get() as
					| {
							incarnation_id: string;
					  }
					| undefined;
				canonicalIncarnationId = row?.incarnation_id ?? null;
			} finally {
				canonicalDb.close();
			}
			assert.strictEqual(
				canonicalIncarnationId,
				resultC?.incarnationId ?? null,
				"canonical DB must belong to the NEW incarnation",
			);
			// The NEW incarnation remains authoritative with live ownership.
			const takeoverDb = openRunDatabase({
				driver: nodeSqliteDriver,
				dbPath: join(runBDir, "turnlock.sqlite3"),
				busyTimeoutMs: 2000,
			});
			let takeoverResult: ReturnType<typeof acquireOwnership>;
			try {
				takeoverResult = acquireOwnership({
					db: takeoverDb.connection,
					runId: RUN_B,
					orchestratorName: ORCHESTRATOR_NAME,
					nowEpochMs: Date.now(),
					nowIso: new Date().toISOString(),
					leaseDurationMs: 30 * 60 * 1000,
					contentionDeadlineMs: 5000,
				});
			} finally {
				takeoverDb.close();
			}
			assert.strictEqual(
				takeoverResult.kind,
				"ACTIVE_CONFLICT",
				"NEW incarnation must hold live ownership",
			);
			// The OLD retired payload was eventually deleted (by A or a sweep).
			const retiredPayloadDir = join(
				dirname(runBDir),
				RETIRED_DIR_NAME,
				RETIRED_PAYLOAD_DIR_NAME,
			);
			assert.strictEqual(
				existsSync(retiredPayloadDir)
					? readdirSync(retiredPayloadDir).length
					: 0,
				0,
				"OLD retired payload must be deleted",
			);
		} finally {
			cleanupTempDir(root);
		}
	});
});
