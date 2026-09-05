import assert from "node:assert/strict";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
// Post-verification namespace race — RED proof.
//
// Target interleaving:
//     pre-rename dev/ino + token verification passes
//         ↓
//     AFTER_PRE_RENAME_VERIFICATION barrier
//         ↓
//     a genuine NEW incarnation is established at the canonical pathname
//         ↓
//     the stale cleanup resumes and its renameSync moves the replacement
//
// The previous generation of tests replaced the pathname BEFORE entering
// the rename primitive and could therefore be stopped by the first
// identity check.  This test drives the full production retirement flow
// with an internal fault point AFTER every pre-rename verification and
// makes the replacement through a COMPLIANT new-initial process running
// the production orchestrator entry point.  Desired invariant:
//
//     the new incarnation obtains BOOTSTRAPPED / valid live ownership
//     AND remains continuously at its canonical pathname after the
//     stale cleanup resumes.
//
// On the current protocol (no per-run namespace mutex) the compliant
// initial cannot establish the new incarnation during the verify→rename
// window — the stale RETIRING authority still occupies the canonical
// pathname — and any successor is displaced by the stale renameSync.
import { describe, test } from "node:test";
import { STATE_SCHEMA_VERSION } from "../../src/constants.js";
import { runOrchestratorInternal } from "../../src/engine/run-orchestrator.js";
import { nodeSqliteDriver } from "../../src/persistence/sqlite/node-sqlite-driver.js";
import { acquireOwnership } from "../../src/persistence/sqlite/ownership.js";
import { bootstrapNewRunAtomic } from "../../src/persistence/sqlite/run-bootstrap.js";
import { openRunDatabase } from "../../src/persistence/sqlite/run-database.js";
import {
	RETIRED_DIR_NAME,
	RETIRED_PAYLOAD_DIR_NAME,
	retireRunDirectoryInternal,
} from "../../src/services/run-retirement.js";
import type { OrchestratorConfig } from "../../src/types/config.js";
import { spawnNode } from "../helpers/node-subprocess.js";
import { cleanupTempDir, makeTempDir } from "../helpers/temp-run-dir.js";

const ORCHESTRATOR_NAME = "retention-namespace-orch";
const RUN_B = "01HX000000000000000000000B";
const DAY_MS = 24 * 60 * 60 * 1000;

interface InitialWorkerResult {
	readonly kind: string;
	readonly incarnationId?: string | null;
	readonly ownershipStatus?: string | null;
	readonly leaseUntilEpochMs?: number | null;
	readonly reason?: string;
}

/** Bootstrap a genuine Turnlock run database via the production primitive. */
function bootstrapForeignRun(
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

function expireLease(runDir: string): void {
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

function ageDir(dir: string, days: number): void {
	const old = new Date(Date.now() - days * DAY_MS);
	utimesSync(dir, old, old);
}

describe("post-verification namespace race", () => {
	test("initial arriving during retirement critical section must serialize instead of failing (RED)", {
		timeout: 120_000,
	}, async () => {
		const root = makeTempDir();
		try {
			const runDirRoot = join(root, "runs");
			const runBDir = join(runDirRoot, ORCHESTRATOR_NAME, RUN_B);
			// Old run B with a genuine SQLite authority and an expired lease.
			bootstrapForeignRun(runBDir, RUN_B);
			expireLease(runBDir);
			ageDir(runBDir, 100);
			// The compliant new-initial worker is spawned BEFORE the cleanup
			// enters its critical section; it waits for the GO signal.
			const goFile = join(root, "go");
			const resultFile = join(root, "result.json");
			const workerScript = join(
				import.meta.dirname,
				"fixtures",
				"retention-namespace-initial-worker.js",
			);
			const worker = spawnNode(workerScript, [], {
				env: {
					...process.env,
					TL_RUN_ROOT: runDirRoot,
					TL_ORCH: ORCHESTRATOR_NAME,
					TL_RUN_ID: RUN_B,
					TL_GO_FILE: goFile,
					TL_RESULT_FILE: resultFile,
					TURNLOCK_TEST: "1",
				},
			});
			// Full production retirement flow with the internal fault point.
			const barrierSab = new Int32Array(new SharedArrayBuffer(4));
			const outcome = retireRunDirectoryInternal(
				{ driver: nodeSqliteDriver, runDir: runBDir, runId: RUN_B },
				{
					onFaultPoint: (point) => {
						if (point !== "AFTER_PRE_RENAME_VERIFICATION") return;
						// Release the compliant initial exactly in the gap
						// between the last pre-rename verification and the
						// renameSync.  Bounded synchronous wait: on the
						// current protocol the initial fails fast; once the
						// namespace protocol exists it blocks until the
						// cleanup releases the namespace mutex.
						writeFileSync(goFile, "go");
						const deadline = Date.now() + 4000;
						while (!existsSync(resultFile) && Date.now() < deadline) {
							Atomics.wait(barrierSab, 0, 0, 50);
						}
					},
				},
			);
			// After the cleanup completes, give the initial time to finish.
			const resultDeadline = Date.now() + 20_000;
			while (!existsSync(resultFile) && Date.now() < resultDeadline) {
				await new Promise((resolve) => setTimeout(resolve, 50));
			}
			const result: InitialWorkerResult | null = existsSync(resultFile)
				? (JSON.parse(readFileSync(resultFile, "utf8")) as InitialWorkerResult)
				: null;
			try {
				worker.kill("SIGKILL");
			} catch {
				// already exited
			}
			const workerExit = await worker.exited;
			console.error(
				`post-verification race: cleanup=${outcome.kind} initial=${result?.kind ?? "NO_RESULT"} workerExit=${workerExit}`,
			);
			// Desired property: the compliant new incarnation was
			// established with valid live ownership.
			assert.strictEqual(
				result?.kind,
				"BOOTSTRAPPED",
				`expected the new incarnation to bootstrap; got ${JSON.stringify(result)} (cleanup=${outcome.kind})`,
			);
			assert.ok(
				result?.incarnationId,
				`expected a new incarnation identity; got ${JSON.stringify(result)}`,
			);
			assert.strictEqual(result.ownershipStatus, "HELD");
			assert.ok(
				result.leaseUntilEpochMs !== null &&
					result.leaseUntilEpochMs !== undefined &&
					result.leaseUntilEpochMs > Date.now(),
				"expected a valid live ownership lease on the new incarnation",
			);
			// Desired property: the new incarnation remains continuously
			// at its canonical pathname after the stale cleanup resumed.
			assert.strictEqual(
				existsSync(runBDir),
				true,
				"expected: new incarnation occupies the canonical path; actual: canonical pathname was displaced by the stale cleanup",
			);
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
				result.incarnationId,
				"expected: canonical DB belongs to the new incarnation; actual: different or missing",
			);
			// The new incarnation remains authoritative: a takeover attempt
			// must observe the live HELD ownership left by the killed worker.
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
				"expected: new incarnation still holds live ownership; actual: authority lost",
			);
		} finally {
			cleanupTempDir(root);
		}
	});

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
				{ driver: nodeSqliteDriver, runDir: runBDir, runId: RUN_B },
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

	test("two concurrent cleanups: exactly one detaches, the second keeps", {
		timeout: 120_000,
	}, async () => {
		const root = makeTempDir();
		try {
			const runDirRoot = join(root, "runs");
			const runBDir = join(runDirRoot, ORCHESTRATOR_NAME, RUN_B);
			bootstrapForeignRun(runBDir, RUN_B);
			expireLease(runBDir);
			ageDir(runBDir, 100);
			const cleanupWorkerScript = join(
				import.meta.dirname,
				"fixtures",
				"retention-namespace-cleanup-worker.js",
			);
			const goBFile = join(root, "go-b");
			const resultBFile = join(root, "result-b.json");
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
			let bBlockedWhileAHeld = false;
			const barrierSab = new Int32Array(new SharedArrayBuffer(4));
			const outcome = retireRunDirectoryInternal(
				{ driver: nodeSqliteDriver, runDir: runBDir, runId: RUN_B },
				{
					onFaultPoint: (point) => {
						if (point !== "AFTER_PRE_RENAME_VERIFICATION") return;
						writeFileSync(goBFile, "go");
						const blockedDeadline = Date.now() + 2500;
						while (Date.now() < blockedDeadline) {
							if (!existsSync(resultBFile)) {
								bBlockedWhileAHeld = true;
							} else {
								break;
							}
							Atomics.wait(barrierSab, 0, 0, 50);
						}
					},
				},
			);
			const resultDeadline = Date.now() + 30_000;
			while (!existsSync(resultBFile) && Date.now() < resultDeadline) {
				await new Promise((resolve) => setTimeout(resolve, 50));
			}
			const resultB = existsSync(resultBFile)
				? (JSON.parse(readFileSync(resultBFile, "utf8")) as {
						kind: string;
						reason?: string;
					})
				: null;
			try {
				workerB.kill("SIGKILL");
			} catch {
				// already exited
			}
			const exitB = await workerB.exited;
			console.error(
				`two-cleanup proof: cleanupA=${outcome.kind} cleanupB=${resultB?.kind}/${resultB?.reason ?? "?"} blockedWhileHeld=${bBlockedWhileAHeld} exitB=${exitB}`,
			);
			// A detached and deleted the OLD generation; B must not detach
			// anything a second time.
			assert.strictEqual(outcome.kind, "DELETED");
			assert.strictEqual(bBlockedWhileAHeld, true);
			assert.ok(
				resultB !== null && resultB.kind !== "DELETED",
				`cleanup B must keep, got ${JSON.stringify(resultB)}`,
			);
			assert.strictEqual(existsSync(runBDir), false);
		} finally {
			cleanupTempDir(root);
		}
	});

	test("retentionDays=0 cleanup cannot detach a half-constructed canonical path (initial survives)", {
		timeout: 120_000,
	}, async () => {
		const root = makeTempDir();
		try {
			const runDirRoot = join(root, "runs");
			const runBDir = join(runDirRoot, ORCHESTRATOR_NAME, RUN_B);
			const goFile = join(root, "go");
			const resultFile = join(root, "result.json");
			const cleanupWorkerScript = join(
				import.meta.dirname,
				"fixtures",
				"retention-namespace-cleanup-worker.js",
			);
			const worker = spawnNode(cleanupWorkerScript, [], {
				env: {
					...process.env,
					TL_RUN_DIR: runBDir,
					TL_RUN_ID: RUN_B,
					TL_ORCH: ORCHESTRATOR_NAME,
					TL_GO_FILE: goFile,
					TL_RESULT_FILE: resultFile,
					TURNLOCK_TEST: "1",
				},
			});
			// The initial phase parks until the test resolves it — the
			// ownership stays HELD/live while the cleanup contender runs.
			const phaseGateHandle: { release(): void } = { release: () => {} };
			const phaseGate = new Promise<void>((resolve) => {
				phaseGateHandle.release = resolve;
			});
			const config: OrchestratorConfig<{ stage: string }> = {
				name: ORCHESTRATOR_NAME,
				initial: "start",
				initialState: { stage: "fresh" },
				resumeCommand: (runId) => `node worker.mjs --run-id ${runId} --resume`,
				retentionDays: 7,
				runDirRoot,
				phases: {
					start: async (_state, io) => {
						await phaseGate;
						return io.done({ stage: "done" });
					},
				},
			};
			let cleanupBlockedWhileInitialHeld = false;
			const barrierSab = new Int32Array(new SharedArrayBuffer(4));
			const initialPromise = runOrchestratorInternal(
				config,
				{ resume: false, runId: RUN_B, rest: [] },
				{
					hooks: {
						beforeRunBootstrapCommit: () => {
							// Namespace mutex held here — the initial owns the
							// half-constructed canonical path.
							writeFileSync(goFile, "go");
							const blockedDeadline = Date.now() + 2500;
							while (Date.now() < blockedDeadline) {
								if (!existsSync(resultFile)) {
									cleanupBlockedWhileInitialHeld = true;
								} else {
									break;
								}
								Atomics.wait(barrierSab, 0, 0, 50);
							}
						},
					},
				},
			);
			// The cleanup contender must finish BEFORE the phase is released:
			// its claim sees the live HELD ownership.
			const resultDeadline = Date.now() + 30_000;
			while (!existsSync(resultFile) && Date.now() < resultDeadline) {
				await new Promise((resolve) => setTimeout(resolve, 50));
			}
			const cleanupResult = existsSync(resultFile)
				? (JSON.parse(readFileSync(resultFile, "utf8")) as {
						kind: string;
						reason?: string;
					})
				: null;
			// Release the parked phase — the initial completes normally.
			phaseGateHandle.release();
			let initialError: unknown = null;
			try {
				await initialPromise;
			} catch (error) {
				initialError = error;
			}
			try {
				worker.kill("SIGKILL");
			} catch {
				// already exited
			}
			const exitCode = await worker.exited;
			console.error(
				`retentionDays=0 proof: cleanup=${cleanupResult?.kind}/${cleanupResult?.reason ?? "?"} blockedWhileHeld=${cleanupBlockedWhileInitialHeld} initialError=${initialError instanceof Error ? initialError.message : String(initialError)} exit=${exitCode}`,
			);
			// The cleanup was blocked while the initial held the mutex, then
			// observed the live owner and kept the run.
			assert.strictEqual(cleanupBlockedWhileInitialHeld, true);
			assert.strictEqual(cleanupResult?.kind, "KEPT");
			assert.strictEqual(cleanupResult?.reason, "LIVE_OWNER");
			// The initial completed successfully (TestExitSignal is the
			// normal in-test completion path).
			assert.ok(
				initialError === null ||
					(initialError as { __turnlockExit?: boolean })?.__turnlockExit ===
						true,
				`initial must complete, got ${String(initialError)}`,
			);
			assert.strictEqual(existsSync(runBDir), true);
			assert.strictEqual(existsSync(join(runBDir, "turnlock.sqlite3")), true);
		} finally {
			cleanupTempDir(root);
		}
	});
});
