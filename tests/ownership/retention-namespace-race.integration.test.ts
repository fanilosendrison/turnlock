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
import { nodeSqliteDriver } from "../../src/persistence/sqlite/node-sqlite-driver.js";
import { acquireOwnership } from "../../src/persistence/sqlite/ownership.js";
import { bootstrapNewRunAtomic } from "../../src/persistence/sqlite/run-bootstrap.js";
import { openRunDatabase } from "../../src/persistence/sqlite/run-database.js";
import {
	RETIRED_DIR_NAME,
	retireRunDirectory,
	retireRunDirectoryInternal,
} from "../../src/services/run-retirement.js";
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

	test("stale retirement authorization can rename a NEW incarnation after pre-rename verification (RED)", {
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
			// Initial C worker — spawned before cleanup A enters its
			// critical section; waits for the GO signal.
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
			let cleanupAToken: string | null = null;
			let cleanupBOutcome: string | null = null;
			let initialCResult: InitialWorkerResult | null = null;
			let proofInitialCKind = "NO_RESULT";
			let newIncarnationId: string | null = null;
			let observedNewIncarnationDisplaced = false;
			const barrierSab = new Int32Array(new SharedArrayBuffer(4));
			const outcome = retireRunDirectoryInternal(
				{ driver: nodeSqliteDriver, runDir: runBDir, runId: RUN_B },
				{
					onFaultPoint: (point) => {
						if (point === "AFTER_PRE_RENAME_VERIFICATION") {
							// Cleanup A already claimed and passed every
							// pre-rename check against the OLD generation.
							// Capture the durable retirement token it will use.
							const tokenDb = openRunDatabase({
								driver: nodeSqliteDriver,
								dbPath: join(runBDir, "turnlock.sqlite3"),
								busyTimeoutMs: 2000,
							});
							try {
								const tokenRow = tokenDb.connection
									.prepare(
										"SELECT retirement_token FROM run_retention WHERE singleton = 1",
									)
									.get() as
									| {
											retirement_token: string | null;
									  }
									| undefined;
								cleanupAToken = tokenRow?.retirement_token ?? null;
							} finally {
								tokenDb.close();
							}
							assert.ok(
								cleanupAToken,
								"cleanup A must hold a durable retirement token",
							);
							// Cleanup B — a second compliant cleanup — finishes
							// the retirement of the OLD generation while A is
							// parked.  B observes ALREADY_RETIRING, renames the
							// OLD canonical and deletes the retired payload.
							cleanupBOutcome = retireRunDirectory({
								driver: nodeSqliteDriver,
								runDir: runBDir,
								runId: RUN_B,
							}).kind;
							assert.strictEqual(
								cleanupBOutcome,
								"DELETED",
								"cleanup B must fully retire and delete the OLD generation",
							);
							assert.strictEqual(
								existsSync(runBDir),
								false,
								"cleanup B must have detached the OLD canonical",
							);
							// Initial C — a genuine NEW generation through the
							// production initial path.
							writeFileSync(goFile, "go");
							const bootstrapDeadline = Date.now() + 15_000;
							while (
								!existsSync(resultFile) &&
								Date.now() < bootstrapDeadline
							) {
								Atomics.wait(barrierSab, 0, 0, 50);
							}
							assert.ok(
								existsSync(resultFile),
								"initial C must bootstrap while cleanup A is parked",
							);
							initialCResult = JSON.parse(
								readFileSync(resultFile, "utf8"),
							) as InitialWorkerResult;
							assert.strictEqual(
								initialCResult.kind,
								"BOOTSTRAPPED",
								`initial C must bootstrap a NEW incarnation, got ${JSON.stringify(initialCResult)}`,
							);
							proofInitialCKind = initialCResult.kind;
							newIncarnationId = initialCResult.incarnationId ?? null;
							assert.ok(
								newIncarnationId,
								"initial C must report a NEW incarnation identity",
							);
							assert.notStrictEqual(
								newIncarnationId,
								oldIncarnationId,
								"initial C must create a genuinely NEW generation",
							);
							assert.strictEqual(initialCResult.ownershipStatus, "HELD");
							assert.ok(
								initialCResult.leaseUntilEpochMs !== null &&
									initialCResult.leaseUntilEpochMs !== undefined &&
									initialCResult.leaseUntilEpochMs > Date.now(),
								"initial C must hold a live lease",
							);
							assert.strictEqual(
								existsSync(runBDir),
								true,
								"canonical RUN_B must exist for the NEW generation",
							);
							const canonicalDb = openRunDatabase({
								driver: nodeSqliteDriver,
								dbPath: join(runBDir, "turnlock.sqlite3"),
								busyTimeoutMs: 2000,
							});
							try {
								const incRow = canonicalDb.connection
									.prepare(
										"SELECT incarnation_id FROM run_incarnation WHERE singleton = 1",
									)
									.get() as
									| {
											incarnation_id: string;
									  }
									| undefined;
								assert.strictEqual(
									incRow?.incarnation_id ?? null,
									newIncarnationId,
									"canonical DB must belong to the NEW incarnation before A resumes",
								);
							} finally {
								canonicalDb.close();
							}
						} else if (point === "AFTER_RENAME_BEFORE_POSTCHECK") {
							// Proof point: the stale renameSync has completed
							// and the post-check has NOT yet had a chance to
							// detect the mismatch nor restore the directory.
							const canonicalAbsent = !existsSync(runBDir);
							assert.strictEqual(
								canonicalAbsent,
								true,
								"at the proof point the canonical pathname must have been moved",
							);
							const retiredRoot = join(dirname(runBDir), RETIRED_DIR_NAME);
							const entries = readdirSync(retiredRoot);
							assert.ok(
								entries.length >= 1,
								"a retired payload must exist at the proof point",
							);
							for (const entryName of entries) {
								const retiredPath = join(retiredRoot, entryName);
								const retiredDbPath = join(retiredPath, "turnlock.sqlite3");
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
									if (incRow?.incarnation_id === newIncarnationId) {
										observedNewIncarnationDisplaced = true;
									}
								} finally {
									retiredDb.close();
								}
							}
							assert.strictEqual(
								observedNewIncarnationDisplaced,
								true,
								"proof point: the stale renameSync must have moved the NEW incarnation into the retired area",
							);
						}
					},
				},
			);
			try {
				worker.kill("SIGKILL");
			} catch {
				// already exited
			}
			const workerExit = await worker.exited;
			console.error(
				`stale-rename proof: oldIncarnation=${oldIncarnationId} newIncarnation=${newIncarnationId} cleanupAToken=${cleanupAToken} cleanupB=${cleanupBOutcome} initialC=${proofInitialCKind} displaced=${observedNewIncarnationDisplaced} cleanupA=${outcome.kind} workerExit=${workerExit}`,
			);
			// Desired property: an OLD retirement authorization can never
			// rename a NEW incarnation.  The violation was already observed
			// at the AFTER_RENAME_BEFORE_POSTCHECK proof point, before any
			// post-check restoration.
			assert.strictEqual(
				observedNewIncarnationDisplaced,
				false,
				"expected: an OLD retirement authorization can never rename a NEW incarnation; actual: cleanup moved the new incarnation before detecting the mismatch",
			);
		} finally {
			cleanupTempDir(root);
		}
	});
});
