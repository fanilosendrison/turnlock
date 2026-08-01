// Orchestrator projection crash integration tests — TL-F-001 point 4.
//
// Proves that after a successful bootstrap COMMIT (SQLite fully durable)
// but before state.json is projected, a SIGKILL crash leaves:
//   - SQLite as the sole authority (all three tables durable)
//   - state.json absent (never projected)
//   - No LockHandle returned to the caller
//
// And that on resume, the orchestrator reads from SQLite, preserves
// the incarnation, does NOT re-initialize, and repairs state.json as
// a faithful projection of the authoritative state.

import { describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { STATE_SCHEMA_VERSION } from "../../src/constants";
import { bunSqliteDriver } from "../../src/persistence/sqlite/bun-sqlite-driver";
import {
	acquireOwnership,
	releaseOwnership,
} from "../../src/persistence/sqlite/ownership";
import { openRunDatabase } from "../../src/persistence/sqlite/run-database";
import {
	projectAuthoritativeStateFenced,
	readAuthoritativeState,
} from "../../src/persistence/sqlite/run-state-store";
import { cleanupTempDir, makeTempDir } from "../helpers/temp-run-dir";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LEASE_MS = 30 * 60 * 1000;
const NOW_EPOCH = 1_000_000_000_000;
const NOW_ISO = "2001-09-09T01:46:40.000Z";
const STATE_FILE = "state.json";

const WORKER_PATH = join(
	import.meta.dir,
	"fixtures",
	"orchestrator-bootstrap-crash-worker.ts",
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function readTableCoherence(db: ReturnType<typeof openRunDatabase>) {
	const incRow = db.connection
		.prepare(
			"SELECT incarnation_id, run_id, orchestrator_name FROM run_incarnation WHERE singleton = 1",
		)
		.get() as {
		incarnation_id: string;
		run_id: string;
		orchestrator_name: string;
	};
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
			"SELECT incarnation_id, state_revision, state_digest, committed_by_owner_token, committed_by_fence_token FROM run_state WHERE singleton = 1",
		)
		.get() as {
		incarnation_id: string;
		state_revision: number | bigint;
		state_digest: string;
		committed_by_owner_token: string;
		committed_by_fence_token: number | bigint;
	};

	return { incRow, ownRow, stateRow };
}

async function waitForSignalFile(
	path: string,
	timeoutMs: number,
): Promise<string> {
	const start = Date.now();
	while (!existsSync(path)) {
		if (Date.now() - start > timeoutMs) {
			throw new Error(`Timeout waiting for signal file: ${path}`);
		}
		await Bun.sleep(10);
	}
	const content = readFileSync(path, "utf-8").trim();
	try {
		unlinkSync(path);
	} catch {
		/* ok */
	}
	return content;
}

async function spawnAndKillAtPoint(
	args: string[],
	signalFile: string,
	timeoutMs: number,
): Promise<{ stdout: string; stderr: string }> {
	const child = Bun.spawn({
		cmd: ["bun", "run", WORKER_PATH, ...args],
		stdout: "pipe",
		stderr: "pipe",
	});

	const signalContent = await waitForSignalFile(signalFile, timeoutMs);

	try {
		if (child.pid !== undefined) {
			process.kill(child.pid, 0);
		}
	} catch {
		throw new Error(`Child died before SIGKILL. Signal: ${signalContent}`);
	}

	child.kill("SIGKILL");

	await child.exited;
	const stdout = await new Response(child.stdout).text();
	const stderr = await new Response(child.stderr).text();

	return { stdout, stderr };
}

// ---------------------------------------------------------------------------
// Test: crash after bootstrap commit, before state.json projection
// ---------------------------------------------------------------------------

describe("orchestrator bootstrap crash before projection", () => {
	test("SQLite durable, state.json absent after post-commit crash", async () => {
		const dir = makeTempDir("crash-orch-");
		const dbPath = join(dir, "turnlock.sqlite3");
		const runDir = join(dir, "run");
		const signalFile = join(dir, "signal.json");
		const runId = "crash-orch-bootstrap";

		try {
			const { stdout } = await spawnAndKillAtPoint(
				[
					"--db-path",
					dbPath,
					"--run-dir",
					runDir,
					"--run-id",
					runId,
					"--orchestrator-name",
					"crash-orch-test",
					"--signal-file",
					signalFile,
				],
				signalFile,
				10_000,
			);

			// Child must not have returned a result.
			expect(stdout).toContain("FAULT_POINT_REACHED");
			expect(stdout).not.toContain("RESULT_RETURNED");

			// DB must exist with all three tables.
			expect(existsSync(dbPath)).toBe(true);
			const reopened = openRunDatabase({
				driver: bunSqliteDriver,
				dbPath,
				busyTimeoutMs: 500,
			});

			try {
				assertAllThreeTablesPresent(reopened);
				const coh = readTableCoherence(reopened);

				// Coherence checks.
				expect(coh.ownRow.incarnation_id).toBe(coh.incRow.incarnation_id);
				expect(coh.stateRow.incarnation_id).toBe(coh.incRow.incarnation_id);
				expect(coh.stateRow.committed_by_owner_token).toBe(
					coh.ownRow.owner_token,
				);
				const ownFence =
					typeof coh.ownRow.fence_token === "bigint"
						? coh.ownRow.fence_token
						: BigInt(coh.ownRow.fence_token);
				const stateFence =
					typeof coh.stateRow.committed_by_fence_token === "bigint"
						? coh.stateRow.committed_by_fence_token
						: BigInt(coh.stateRow.committed_by_fence_token);
				expect(stateFence).toBe(ownFence);
				expect(ownFence).toBe(1n);

				const rev =
					typeof coh.stateRow.state_revision === "bigint"
						? coh.stateRow.state_revision
						: BigInt(coh.stateRow.state_revision);
				expect(rev).toBe(0n);

				// state.json must NOT exist — never projected.
				const stateJsonPath = join(runDir, STATE_FILE);
				expect(existsSync(stateJsonPath)).toBe(false);
			} finally {
				reopened.close();
			}
		} finally {
			cleanupTempDir(dir);
		}
	});

	test("resume before lease expiry — ACTIVE_CONFLICT", async () => {
		const dir = makeTempDir("crash-orch-2-");
		const dbPath = join(dir, "turnlock.sqlite3");
		const runDir = join(dir, "run");
		const signalFile = join(dir, "signal.json");
		const runId = "crash-orch-conflict";

		try {
			await spawnAndKillAtPoint(
				[
					"--db-path",
					dbPath,
					"--run-dir",
					runDir,
					"--run-id",
					runId,
					"--orchestrator-name",
					"crash-orch-test",
					"--signal-file",
					signalFile,
				],
				signalFile,
				10_000,
			);

			// Try to acquire ownership with current time — must fail.
			const db = openRunDatabase({
				driver: bunSqliteDriver,
				dbPath,
				busyTimeoutMs: 500,
			});

			try {
				const result = acquireOwnership({
					db: db.connection,
					runId,
					orchestratorName: "crash-orch-test",
					nowEpochMs: NOW_EPOCH,
					nowIso: NOW_ISO,
					leaseDurationMs: LEASE_MS,
					contentionDeadlineMs: 5000,
					leaseClockEpochMs: () => NOW_EPOCH,
				});

				expect(result.kind).toBe("ACTIVE_CONFLICT");
			} finally {
				db.close();
			}
		} finally {
			cleanupTempDir(dir);
		}
	});

	test("resume after lease expiry — same incarnation, fence+1, state.json repaired", async () => {
		const dir = makeTempDir("crash-orch-3-");
		const dbPath = join(dir, "turnlock.sqlite3");
		const runDir = join(dir, "run");
		const signalFile = join(dir, "signal.json");
		const runId = "crash-orch-repair";
		const orchName = "crash-orch-test";

		try {
			await spawnAndKillAtPoint(
				[
					"--db-path",
					dbPath,
					"--run-dir",
					runDir,
					"--run-id",
					runId,
					"--orchestrator-name",
					orchName,
					"--signal-file",
					signalFile,
				],
				signalFile,
				10_000,
			);

			// Read the pre-takeover state for comparison.
			const preDb = openRunDatabase({
				driver: bunSqliteDriver,
				dbPath,
				busyTimeoutMs: 500,
			});

			let preIncarnationId: string;
			let preStateDigest: string;
			try {
				const coh = readTableCoherence(preDb);
				preIncarnationId = coh.incRow.incarnation_id;
				preStateDigest = coh.stateRow.state_digest;
				expect(preIncarnationId).toBeTruthy();
			} finally {
				preDb.close();
			}

			// Simulate passage of time — acquire after lease expiry.
			const futureEpoch = NOW_EPOCH + LEASE_MS + 1000;

			const takeoverDb = openRunDatabase({
				driver: bunSqliteDriver,
				dbPath,
				busyTimeoutMs: 500,
			});

			try {
				const acqResult = acquireOwnership({
					db: takeoverDb.connection,
					runId,
					orchestratorName: orchName,
					nowEpochMs: futureEpoch,
					nowIso: new Date(futureEpoch).toISOString(),
					leaseDurationMs: LEASE_MS,
					contentionDeadlineMs: 5000,
					leaseClockEpochMs: () => futureEpoch,
				});

				expect(acqResult.kind).toBe("ACQUIRED");
				if (acqResult.kind !== "ACQUIRED") {
					takeoverDb.close();
					return;
				}

				const handle = acqResult.handle;

				// Fence incremented by exactly 1.
				expect(handle.fenceToken).toBe(2n);

				// Same incarnation preserved.
				expect(handle.incarnationId).toBe(preIncarnationId);

				// Read authoritative state.
				const authRead = readAuthoritativeState(takeoverDb.connection);
				expect(authRead.state).not.toBeNull();
				if (authRead.state === null) {
					releaseOwnership({
						db: takeoverDb.connection,
						handle,
					});
					takeoverDb.close();
					return;
				}

				// Verify consistency.
				expect(authRead.state.runIncarnationId).toBe(preIncarnationId);
				expect(authRead.state.stateRevision).toBe("0");
				expect(authRead.digest).toBe(preStateDigest);
				expect(authRead.state.runId).toBe(runId);
				expect(authRead.state.orchestratorName).toBe(orchName);

				// Project state.json from SQLite authority.
				projectAuthoritativeStateFenced(
					takeoverDb.connection,
					handle,
					runDir,
					authRead.state.stateRevision,
					authRead.digest!,
				() => futureEpoch,
				);

				// Verify state.json now exists.
				const stateJsonPath = join(runDir, STATE_FILE);
				expect(existsSync(stateJsonPath)).toBe(true);

				// Verify its content.
				const projected = JSON.parse(
					readFileSync(stateJsonPath, "utf-8"),
				) as Record<string, unknown>;
				expect(projected.runIncarnationId).toBe(preIncarnationId);
				expect(projected.stateRevision).toBe("0");
				expect(projected.runId).toBe(runId);
				expect(projected.orchestratorName).toBe(orchName);
				expect(projected.currentPhase).toBe("start");
				expect(projected.phasesExecuted).toBe(0);
				expect(projected.data).toEqual({ stage: "initial" });

				// Cleanup.
				releaseOwnership({
					db: takeoverDb.connection,
					handle,
				});
			} finally {
				takeoverDb.close();
			}
		} finally {
			cleanupTempDir(dir);
		}
	});
});

// ---------------------------------------------------------------------------
// Test: legacy migration post-commit crash before projection
// ---------------------------------------------------------------------------

describe("legacy migration crash before projection", () => {
	test("migration SQLite durable, state.json legacy intact, resume repairs projection", async () => {
		const dir = makeTempDir("crash-migproj-");
		const dbPath = join(dir, "turnlock.sqlite3");
		const runDir = join(dir, "run");
		const signalFile = join(dir, "signal.json");
		const runId = "crash-migproj";
		const orchName = "crash-orch-test";

		// Write legacy state.json in the run dir.
		mkdirSync(runDir, { recursive: true });
		const legacyState = {
			schemaVersion: STATE_SCHEMA_VERSION,
			runId,
			orchestratorName: orchName,
			startedAt: "2020-01-01T00:00:00.000Z",
			startedAtEpochMs: 1_577_836_800_000,
			lastTransitionAt: "2020-01-01T00:01:00.000Z",
			lastTransitionAtEpochMs: 1_577_836_860_000,
			currentPhase: "legacy-phase",
			phasesExecuted: 5,
			accumulatedDurationMs: 10000,
			data: { stage: "legacy" },
			usedLabels: ["old-label"],
		};
		const legacyBytes = Buffer.from(JSON.stringify(legacyState), "utf-8");
		writeFileSync(join(runDir, STATE_FILE), legacyBytes);

		try {
			// Use the bootstrap worker in MIGRATION mode via the primitive
			// worker (not the orchestrator worker — we simulate the
			// migration path).
			const primitiveWorkerPath = join(
				import.meta.dir,
				"..",
				"persistence",
				"fixtures",
				"bootstrap-crash-worker.ts",
			);

			const child = Bun.spawn({
				cmd: [
					"bun",
					"run",
					primitiveWorkerPath,
					"--db-path",
					dbPath,
					"--mode",
					"MIGRATION",
					"--crash-point",
					"AFTER_COMMIT_BEFORE_HANDLE",
					"--run-id",
					runId,
					"--orchestrator-name",
					orchName,
					"--signal-file",
					signalFile,
					"--legacy-state-file",
					join(runDir, STATE_FILE),
				],
				stdout: "pipe",
				stderr: "pipe",
			});

			await waitForSignalFile(signalFile, 10_000);
			child.kill("SIGKILL");
			await child.exited;

			// SQLite must be durable.
			expect(existsSync(dbPath)).toBe(true);
			const reopened = openRunDatabase({
				driver: bunSqliteDriver,
				dbPath,
				busyTimeoutMs: 500,
			});
			let preIncarnationId: string;

			try {
				assertAllThreeTablesPresent(reopened);

				const coh = readTableCoherence(reopened);
				preIncarnationId = coh.incRow.incarnation_id;
				const rev =
					typeof coh.stateRow.state_revision === "bigint"
						? coh.stateRow.state_revision
						: BigInt(coh.stateRow.state_revision);
				expect(rev).toBe(0n);

				// Legacy timestamps preserved.
				expect(coh.incRow.run_id).toBe(runId);
			} finally {
				reopened.close();
			}

			// state.json legacy still present.
			const stateJsonPath = join(runDir, STATE_FILE);
			expect(existsSync(stateJsonPath)).toBe(true);
			const currentBytes = readFileSync(stateJsonPath);
			expect(currentBytes.equals(legacyBytes)).toBe(true);

			// Takeover after expiry.
			const futureEpoch = NOW_EPOCH + LEASE_MS + 1000;
			const takeoverDb = openRunDatabase({
				driver: bunSqliteDriver,
				dbPath,
				busyTimeoutMs: 500,
			});

			try {
				const acqResult = acquireOwnership({
					db: takeoverDb.connection,
					runId,
					orchestratorName: orchName,
					nowEpochMs: futureEpoch,
					nowIso: new Date(futureEpoch).toISOString(),
					leaseDurationMs: LEASE_MS,
					contentionDeadlineMs: 5000,
					leaseClockEpochMs: () => futureEpoch,
				});

				expect(acqResult.kind).toBe("ACQUIRED");
				if (acqResult.kind !== "ACQUIRED") {
					takeoverDb.close();
					return;
				}

				const handle = acqResult.handle;

				// Fence must be 2 (original was 1 from migration).
				expect(handle.fenceToken).toBe(2n);
				expect(handle.incarnationId).toBe(preIncarnationId);

				// Read authoritative state — must return legacy phase.
				const authRead = readAuthoritativeState(takeoverDb.connection);
				expect(authRead.state).not.toBeNull();
				if (authRead.state === null) {
					releaseOwnership({
						db: takeoverDb.connection,
						handle,
					});
					takeoverDb.close();
					return;
				}

				expect(authRead.state.currentPhase).toBe("legacy-phase");
				expect(authRead.state.phasesExecuted).toBe(5);
				expect(authRead.state.runIncarnationId).toBe(preIncarnationId);
				expect(authRead.state.startedAt).toBe(legacyState.startedAt);
				expect(authRead.state.startedAtEpochMs).toBe(
					legacyState.startedAtEpochMs,
				);

				// Project from SQLite — must overwrite legacy state.json
				// with the authoritative projection.
				projectAuthoritativeStateFenced(
					takeoverDb.connection,
					handle,
					runDir,
					authRead.state.stateRevision,
					authRead.digest!,
				() => futureEpoch,
				);

				// state.json now contains the authoritative projection.
				const projected = JSON.parse(
					readFileSync(join(runDir, STATE_FILE), "utf-8"),
				) as Record<string, unknown>;
				expect(projected.runIncarnationId).toBe(preIncarnationId);
				expect(projected.currentPhase).toBe("legacy-phase");
				expect(projected.phasesExecuted).toBe(5);

				releaseOwnership({
					db: takeoverDb.connection,
					handle,
				});
			} finally {
				takeoverDb.close();
			}
		} finally {
			cleanupTempDir(dir);
		}
	});
});
