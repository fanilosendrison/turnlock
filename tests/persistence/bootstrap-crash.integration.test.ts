// Bootstrap crash integration tests — TL-F-001 point 4.
//
// Multiprocess tests proving the durability properties of
// bootstrapNewRunAtomic and migrateLegacyRunAtomic under real
// SIGKILL crashes.
//
// The parent spawns a real child process, waits for it to reach a
// specific fault-point boundary, then sends SIGKILL.  After the
// child dies the parent reopens the database and verifies the
// expected state:
//
//   Pre-commit crash  →  zero durable rows (all three tables empty)
//   Post-commit crash →  incarnation + ownership + state durable
//                        (but no LockHandle received by the child)
//
// No sleep-based synchronization — the child writes a signal file
// and the parent polls for it.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { STATE_SCHEMA_VERSION } from "../../src/constants";
import { bunSqliteDriver } from "../../src/persistence/sqlite/bun-sqlite-driver";
import {
	acquireOwnership,
	releaseOwnership,
} from "../../src/persistence/sqlite/ownership";
import {
	bootstrapNewRunAtomic,
	migrateLegacyRunAtomic,
} from "../../src/persistence/sqlite/run-bootstrap";
import { openRunDatabase } from "../../src/persistence/sqlite/run-database";
import { cleanupTempDir, makeTempDir } from "../helpers/temp-run-dir";

// ---------------------------------------------------------------------------
// Constants (must match bootstrap-crash-worker.ts)
// ---------------------------------------------------------------------------

const LEASE_MS = 30 * 60 * 1000;
const NOW_EPOCH = 1_000_000_000_000;
const CONTENTION_DEADLINE_MS = 2000;
const WORKER_PATH = join(
	import.meta.dir,
	"fixtures",
	"bootstrap-crash-worker.ts",
);

const PRE_COMMIT_POINTS = [
	"AFTER_INCARNATION_WRITE",
	"AFTER_OWNERSHIP_WRITE",
	"AFTER_STATE_WRITE",
	"BEFORE_COMMIT",
] as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function assertTablesEmpty(db: ReturnType<typeof openRunDatabase>) {
	const inc = db.connection
		.prepare("SELECT COUNT(*) AS cnt FROM run_incarnation")
		.get() as { cnt: number };
	const own = db.connection
		.prepare("SELECT COUNT(*) AS cnt FROM run_ownership")
		.get() as { cnt: number };
	const state = db.connection
		.prepare("SELECT COUNT(*) AS cnt FROM run_state")
		.get() as { cnt: number };
	expect(inc.cnt).toBe(0);
	expect(own.cnt).toBe(0);
	expect(state.cnt).toBe(0);
}

function assertAllThreeTablesPresent(db: ReturnType<typeof openRunDatabase>) {
	const inc = db.connection
		.prepare("SELECT COUNT(*) AS cnt FROM run_incarnation")
		.get() as { cnt: number };
	const own = db.connection
		.prepare("SELECT COUNT(*) AS cnt FROM run_ownership")
		.get() as { cnt: number };
	const state = db.connection
		.prepare("SELECT COUNT(*) AS cnt FROM run_state")
		.get() as { cnt: number };
	expect(inc.cnt).toBe(1);
	expect(own.cnt).toBe(1);
	expect(state.cnt).toBe(1);
}

function assertThreeTableCoherence(db: ReturnType<typeof openRunDatabase>) {
	const incRow = db.connection
		.prepare("SELECT incarnation_id FROM run_incarnation WHERE singleton = 1")
		.get() as { incarnation_id: string };
	const ownRow = db.connection
		.prepare(
			"SELECT incarnation_id, ownership_status, owner_token, fence_token, lease_until_epoch_ms FROM run_ownership WHERE singleton = 1",
		)
		.get() as {
		incarnation_id: string;
		ownership_status: string;
		owner_token: string;
		fence_token: number | bigint;
		lease_until_epoch_ms: number;
	};
	const stateRow = db.connection
		.prepare(
			"SELECT incarnation_id, state_revision, committed_by_owner_token, committed_by_fence_token FROM run_state WHERE singleton = 1",
		)
		.get() as {
		incarnation_id: string;
		state_revision: number | bigint;
		committed_by_owner_token: string;
		committed_by_fence_token: number | bigint;
	};

	// incarnation_id matches across all three tables.
	expect(ownRow.incarnation_id).toBe(incRow.incarnation_id);
	expect(stateRow.incarnation_id).toBe(incRow.incarnation_id);

	// owner_token matches between ownership and state.
	expect(stateRow.committed_by_owner_token).toBe(ownRow.owner_token);

	// fence_token matches between ownership and state.
	const ownFence =
		typeof ownRow.fence_token === "bigint"
			? ownRow.fence_token
			: BigInt(ownRow.fence_token);
	const stateFence =
		typeof stateRow.committed_by_fence_token === "bigint"
			? stateRow.committed_by_fence_token
			: BigInt(stateRow.committed_by_fence_token);
	expect(stateFence).toBe(ownFence);

	// Ownership is HELD (orphaned lease).
	expect(ownRow.ownership_status).toBe("HELD");

	// State revision is 0 (first commit).
	const rev =
		typeof stateRow.state_revision === "bigint"
			? stateRow.state_revision
			: BigInt(stateRow.state_revision);
	expect(rev).toBe(0n);
}

function legacyState(overrides: Record<string, unknown> = {}) {
	return {
		schemaVersion: STATE_SCHEMA_VERSION,
		runId: "01HX0000000000000000000001",
		orchestratorName: "crash-test",
		startedAt: "2020-01-01T00:00:00.000Z",
		startedAtEpochMs: 1_577_836_800_000,
		lastTransitionAt: "2020-01-01T00:01:00.000Z",
		lastTransitionAtEpochMs: 1_577_836_860_000,
		currentPhase: "legacy-phase",
		phasesExecuted: 5,
		accumulatedDurationMs: 10000,
		data: { stage: "legacy" },
		usedLabels: ["old-label"],
		...overrides,
	};
}

/** Poll for a signal file to appear, returning its content.
 *  Throws after `timeoutMs`. */
async function waitForSignalFile(
	path: string,
	timeoutMs: number,
): Promise<string> {
	const start = Date.now();
	while (!existsSync(path)) {
		if (Date.now() - start > timeoutMs) {
			throw new Error(
				`Timeout waiting for signal file: ${path} (${timeoutMs}ms)`,
			);
		}
		await Bun.sleep(10);
	}
	const content = readFileSync(path, "utf-8").trim();
	// Clean up the signal file.
	try {
		unlinkSync(path);
	} catch {
		/* ok */
	}
	return content;
}

/** Spawn the crash worker and wait for it to reach the target fault point,
 *  then kill it with SIGKILL.  Returns the child process info for cleanup. */
async function spawnAndKillAtPoint(
	args: string[],
	signalFile: string,
	timeoutMs: number,
): Promise<{
	stdout: string;
	stderr: string;
	exitSignal: NodeJS.Signals | null;
}> {
	const child = Bun.spawn({
		cmd: ["bun", "run", WORKER_PATH, ...args],
		stdout: "pipe",
		stderr: "pipe",
	});

	// Wait for the signal file to appear.
	const signalContent = await waitForSignalFile(signalFile, timeoutMs);

	// Verify the child is still alive.
	try {
		if (child.pid !== undefined) {
			process.kill(child.pid, 0);
		}
	} catch {
		throw new Error(
			`Child died before SIGKILL. Signal content: ${signalContent}`,
		);
	}

	// Send SIGKILL.
	child.kill("SIGKILL");

	// Wait for the child to exit, collecting stdout/stderr.
	await child.exited;
	const stdout = await new Response(child.stdout).text();
	const stderr = await new Response(child.stderr).text();

	return {
		stdout,
		stderr,
		exitSignal: child.killed ? ("SIGKILL" as NodeJS.Signals) : null,
	};
}

// ---------------------------------------------------------------------------
// Pre-commit crash tests — bootstrap
// ---------------------------------------------------------------------------

describe("bootstrap pre-commit crash", () => {
	for (const point of PRE_COMMIT_POINTS) {
		test(`SIGKILL at ${point} — zero durable rows`, async () => {
			const dir = makeTempDir("crash-bootstrap-");
			const dbPath = join(dir, "turnlock.sqlite3");
			const signalFile = join(dir, "signal.json");
			const runId = `crash-${point.toLowerCase().replace(/_/g, "-")}`;

			try {
				// Spawn the worker — it will open/init the DB, start
				// bootstrap, reach the fault point, signal, and block.
				await spawnAndKillAtPoint(
					[
						"--db-path",
						dbPath,
						"--mode",
						"BOOTSTRAP",
						"--crash-point",
						point,
						"--run-id",
						runId,
						"--orchestrator-name",
						"crash-test",
						"--signal-file",
						signalFile,
					],
					signalFile,
					10_000,
				);

				// Reopen the DB and verify all three tables are empty.
				const reopened = openRunDatabase({
					driver: bunSqliteDriver,
					dbPath,
					busyTimeoutMs: 500,
				});

				try {
					assertTablesEmpty(reopened);
				} finally {
					reopened.close();
				}

				// Verify a fresh bootstrap can succeed on the same DB.
				const retry = openRunDatabase({
					driver: bunSqliteDriver,
					dbPath,
					busyTimeoutMs: 500,
				});

				try {
					const result = bootstrapNewRunAtomic({
						db: retry.connection,
						runId,
						orchestratorName: "crash-test",
						nowEpochMs: NOW_EPOCH,
						nowIso: "2001-09-09T01:46:40.000Z",
						leaseDurationMs: LEASE_MS,
						leaseClockEpochMs: () => NOW_EPOCH,
						initialState: {
							schemaVersion: STATE_SCHEMA_VERSION,
							runId,
							orchestratorName: "crash-test",
							startedAt: "2001-09-09T01:46:40.000Z",
							startedAtEpochMs: NOW_EPOCH,
							lastTransitionAt: "2001-09-09T01:46:40.000Z",
							lastTransitionAtEpochMs: NOW_EPOCH,
							currentPhase: "retry",
							phasesExecuted: 0,
							accumulatedDurationMs: 0,
							data: {},
							usedLabels: [],
						},
						stateSchemaVersion: STATE_SCHEMA_VERSION,
						contentionDeadlineMs: CONTENTION_DEADLINE_MS,
					});

					expect(result.kind).toBe("BOOTSTRAPPED");
					if (result.kind === "BOOTSTRAPPED") {
						releaseOwnership({
							db: retry.connection,
							handle: result.handle,
						});
					}
				} finally {
					retry.close();
				}
			} finally {
				cleanupTempDir(dir);
			}
		});
	}
});

// ---------------------------------------------------------------------------
// Post-commit crash — bootstrap
// ---------------------------------------------------------------------------

describe("bootstrap post-commit crash", () => {
	test("SIGKILL at AFTER_COMMIT_BEFORE_HANDLE — durable state, no handle", async () => {
		const dir = makeTempDir("crash-postcommit-");
		const dbPath = join(dir, "turnlock.sqlite3");
		const signalFile = join(dir, "signal.json");
		const runId = "crash-postcommit";

		try {
			const { stdout } = await spawnAndKillAtPoint(
				[
					"--db-path",
					dbPath,
					"--mode",
					"BOOTSTRAP",
					"--crash-point",
					"AFTER_COMMIT_BEFORE_HANDLE",
					"--run-id",
					runId,
					"--orchestrator-name",
					"crash-test",
					"--signal-file",
					signalFile,
				],
				signalFile,
				10_000,
			);

			// The child must NOT have received a BOOTSTRAPPED result.
			expect(stdout).not.toContain("RESULT_RETURNED");
			expect(stdout).not.toContain("BOOTSTRAPPED");
			expect(stdout).toContain("FAULT_POINT_REACHED");

			// Reopen — all three tables must be populated.
			const reopened = openRunDatabase({
				driver: bunSqliteDriver,
				dbPath,
				busyTimeoutMs: 500,
			});

			try {
				assertAllThreeTablesPresent(reopened);
				assertThreeTableCoherence(reopened);
			} finally {
				reopened.close();
			}

			// Verify orphaned lease: immediate attempt → ACTIVE_CONFLICT.
			const conflict = openRunDatabase({
				driver: bunSqliteDriver,
				dbPath,
				busyTimeoutMs: 500,
			});

			try {
				const result = bootstrapNewRunAtomic({
					db: conflict.connection,
					runId,
					orchestratorName: "crash-test",
					nowEpochMs: NOW_EPOCH,
					nowIso: "2001-09-09T01:46:40.000Z",
					leaseDurationMs: LEASE_MS,
					leaseClockEpochMs: () => NOW_EPOCH,
					initialState: {
						schemaVersion: STATE_SCHEMA_VERSION,
						runId,
						orchestratorName: "crash-test",
						startedAt: "2001-09-09T01:46:40.000Z",
						startedAtEpochMs: NOW_EPOCH,
						lastTransitionAt: "2001-09-09T01:46:40.000Z",
						lastTransitionAtEpochMs: NOW_EPOCH,
						currentPhase: "recovery",
						phasesExecuted: 0,
						accumulatedDurationMs: 0,
						data: {},
						usedLabels: [],
					},
					stateSchemaVersion: STATE_SCHEMA_VERSION,
					contentionDeadlineMs: CONTENTION_DEADLINE_MS,
				});

				// Lease is still active → conflict.
				expect(result.kind).toBe("ACTIVE_CONFLICT");
			} finally {
				conflict.close();
			}

			// Takeover after lease expiration.
			// Use a clock that simulates time after lease expiry.
			const futureEpoch = NOW_EPOCH + LEASE_MS + 1000;

			const takeover = openRunDatabase({
				driver: bunSqliteDriver,
				dbPath,
				busyTimeoutMs: 500,
			});

			try {
				// Read the old fence token before takeover.
				const oldFence = takeover.connection
					.prepare("SELECT fence_token FROM run_ownership WHERE singleton = 1")
					.get() as { fence_token: number | bigint };
				const oldFenceValue =
					typeof oldFence.fence_token === "bigint"
						? oldFence.fence_token
						: BigInt(oldFence.fence_token);

				// Acquire ownership via acquireOwnership (not bootstrap,
				// since the DB is already established).
				const acqResult = acquireOwnership({
					db: takeover.connection,
					runId,
					orchestratorName: "crash-test",
					nowEpochMs: futureEpoch,
					nowIso: new Date(futureEpoch).toISOString(),
					leaseDurationMs: LEASE_MS,
					contentionDeadlineMs: CONTENTION_DEADLINE_MS,
					leaseClockEpochMs: () => futureEpoch,
				});

				expect(acqResult.kind).toBe("ACQUIRED");
				if (acqResult.kind === "ACQUIRED") {
					// fenceToken must have incremented by exactly 1.
					expect(acqResult.handle.fenceToken).toBe(oldFenceValue + 1n);

					// Release immediately for cleanup.
					releaseOwnership({
						db: takeover.connection,
						handle: acqResult.handle,
					});
				}
			} finally {
				takeover.close();
			}
		} finally {
			cleanupTempDir(dir);
		}
	});
});

// ---------------------------------------------------------------------------
// Migration crash tests
// ---------------------------------------------------------------------------

describe("legacy migration crash", () => {
	test("migration pre-commit SIGKILL — zero rows, state.json intact", async () => {
		const dir = makeTempDir("crash-migration-pre-");
		const dbPath = join(dir, "turnlock.sqlite3");
		const signalFile = join(dir, "signal.json");
		const legacyStatePath = join(dir, "state.json");
		const runId = "crash-migration-pre";

		// Write legacy state.json.
		const stateJson = legacyState({ currentPhase: "legacy-crash-pre" });
		const stateJsonBytes = Buffer.from(JSON.stringify(stateJson), "utf-8");
		writeFileSync(legacyStatePath, stateJsonBytes);

		try {
			await spawnAndKillAtPoint(
				[
					"--db-path",
					dbPath,
					"--mode",
					"MIGRATION",
					"--crash-point",
					"AFTER_OWNERSHIP_WRITE",
					"--run-id",
					runId,
					"--orchestrator-name",
					"crash-test",
					"--signal-file",
					signalFile,
					"--legacy-state-file",
					legacyStatePath,
				],
				signalFile,
				10_000,
			);

			// Verify state.json unchanged byte-for-byte.
			expect(existsSync(legacyStatePath)).toBe(true);
			const currentBytes = readFileSync(legacyStatePath);
			expect(currentBytes.equals(stateJsonBytes)).toBe(true);

			// Verify tables empty.
			const reopened = openRunDatabase({
				driver: bunSqliteDriver,
				dbPath,
				busyTimeoutMs: 500,
			});

			try {
				assertTablesEmpty(reopened);
			} finally {
				reopened.close();
			}
		} finally {
			cleanupTempDir(dir);
		}
	});

	test("migration post-commit SIGKILL — durable state, legacy timestamps preserved", async () => {
		const dir = makeTempDir("crash-migration-post-");
		const dbPath = join(dir, "turnlock.sqlite3");
		const signalFile = join(dir, "signal.json");
		const legacyStatePath = join(dir, "state.json");
		const runId = "crash-migration-post";

		const stateJson = legacyState({ currentPhase: "legacy-crash-post" });
		writeFileSync(
			legacyStatePath,
			Buffer.from(JSON.stringify(stateJson), "utf-8"),
		);

		try {
			const { stdout } = await spawnAndKillAtPoint(
				[
					"--db-path",
					dbPath,
					"--mode",
					"MIGRATION",
					"--crash-point",
					"AFTER_COMMIT_BEFORE_HANDLE",
					"--run-id",
					runId,
					"--orchestrator-name",
					"crash-test",
					"--signal-file",
					signalFile,
					"--legacy-state-file",
					legacyStatePath,
				],
				signalFile,
				10_000,
			);

			// Must not have received MIGRATED result.
			expect(stdout).not.toContain("RESULT_RETURNED");
			expect(stdout).not.toContain("MIGRATED");
			expect(stdout).toContain("FAULT_POINT_REACHED");

			// Reopen — all three tables populated.
			const reopened = openRunDatabase({
				driver: bunSqliteDriver,
				dbPath,
				busyTimeoutMs: 500,
			});

			try {
				assertAllThreeTablesPresent(reopened);
				assertThreeTableCoherence(reopened);

				// Legacy timestamps preserved in incarnation.
				const incRow = reopened.connection
					.prepare(
						"SELECT created_at_epoch_ms, created_at_iso FROM run_incarnation WHERE singleton = 1",
					)
					.get() as {
					created_at_epoch_ms: number;
					created_at_iso: string;
				};
				expect(incRow.created_at_epoch_ms).toBe(stateJson.startedAtEpochMs);
				expect(incRow.created_at_iso).toBe(stateJson.startedAt);

				// state.json still present on disk (legacy file, not authoritative).
				expect(existsSync(legacyStatePath)).toBe(true);

				// SQLite is authoritative — a resume should use it, not
				// re-import the legacy file as a new incarnation.
				const authRead = reopened.connection
					.prepare("SELECT state_json FROM run_state WHERE singleton = 1")
					.get() as { state_json: string };
				const authState = JSON.parse(authRead.state_json) as Record<
					string,
					unknown
				>;
				expect(authState.currentPhase).toBe("legacy-crash-post");
				expect(authState.phasesExecuted).toBe(5);

				// Ownership is HELD (orphaned).
				const ownRow = reopened.connection
					.prepare(
						"SELECT ownership_status FROM run_ownership WHERE singleton = 1",
					)
					.get() as { ownership_status: string };
				expect(ownRow.ownership_status).toBe("HELD");
			} finally {
				reopened.close();
			}

			// Re-migration should detect already established.
			const retry = openRunDatabase({
				driver: bunSqliteDriver,
				dbPath,
				busyTimeoutMs: 500,
			});

			try {
				// First release the orphaned lease (by takeover).
				const acqResult = acquireOwnership({
					db: retry.connection,
					runId,
					orchestratorName: "crash-test",
					nowEpochMs: NOW_EPOCH + LEASE_MS + 1000,
					nowIso: new Date(NOW_EPOCH + LEASE_MS + 1000).toISOString(),
					leaseDurationMs: LEASE_MS,
					contentionDeadlineMs: CONTENTION_DEADLINE_MS,
					leaseClockEpochMs: () => NOW_EPOCH + LEASE_MS + 1000,
				});

				expect(acqResult.kind).toBe("ACQUIRED");
				if (acqResult.kind === "ACQUIRED") {
					releaseOwnership({
						db: retry.connection,
						handle: acqResult.handle,
					});
				}

				// Now the DB is FREE. Re-migration should say ALREADY_ESTABLISHED.
				const result = migrateLegacyRunAtomic({
					db: retry.connection,
					runId,
					orchestratorName: "crash-test",
					nowEpochMs: NOW_EPOCH,
					nowIso: "2001-09-09T01:46:40.000Z",
					leaseDurationMs: LEASE_MS,
					leaseClockEpochMs: () => NOW_EPOCH,
					legacyState: stateJson,
					legacyStartedAtEpochMs: stateJson.startedAtEpochMs as number,
					legacyStartedAt: stateJson.startedAt as string,
					legacyLastTransitionAtEpochMs:
						stateJson.lastTransitionAtEpochMs as number,
					legacyLastTransitionAt: stateJson.lastTransitionAt as string,
					stateSchemaVersion: STATE_SCHEMA_VERSION,
					contentionDeadlineMs: CONTENTION_DEADLINE_MS,
				});

				expect(result.kind).toBe("ALREADY_ESTABLISHED");
			} finally {
				retry.close();
			}
		} finally {
			cleanupTempDir(dir);
		}
	});
});

// ---------------------------------------------------------------------------
// No handle received by child
// ---------------------------------------------------------------------------

describe("no handle received before kill", () => {
	test("pre-commit crash — child never receives BOOTSTRAPPED", async () => {
		const dir = makeTempDir("crash-nohandle-");
		const dbPath = join(dir, "turnlock.sqlite3");
		const signalFile = join(dir, "signal.json");

		try {
			const { stdout } = await spawnAndKillAtPoint(
				[
					"--db-path",
					dbPath,
					"--mode",
					"BOOTSTRAP",
					"--crash-point",
					"BEFORE_COMMIT",
					"--run-id",
					"crash-nohandle",
					"--orchestrator-name",
					"crash-test",
					"--signal-file",
					signalFile,
				],
				signalFile,
				10_000,
			);

			// The child stdout must contain only FAULT_POINT_REACHED,
			// not RESULT_RETURNED or BOOTSTRAPPED.
			expect(stdout).toContain("FAULT_POINT_REACHED");
			expect(stdout).not.toContain("RESULT_RETURNED");
			expect(stdout).not.toContain("BOOTSTRAPPED");
		} finally {
			cleanupTempDir(dir);
		}
	});
});
