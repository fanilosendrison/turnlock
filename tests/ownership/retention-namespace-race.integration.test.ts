import assert from "node:assert/strict";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
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
import { retireRunDirectoryInternal } from "../../src/services/run-retirement.js";
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
	test("compliant new initial during the verify→rename window survives and remains at canonical (RED)", { timeout: 120_000 }, async () => {
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
});
