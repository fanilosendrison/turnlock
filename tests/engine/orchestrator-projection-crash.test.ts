// Real-process crash recovery across the orchestrator/bootstrap/projection seam.
//
// These tests deliberately SIGKILL a worker while it is executing the real
// initial-mode engine path, then resume through the public `--resume` path.
// SQLite is the authority throughout; state.json is only a repairable view.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PENDING_INITIAL_DISPATCH_STATE_FIELD } from "../../src/constants";
import {
	CRASH_TEST_ORCHESTRATOR_NAME,
	crashInitialModeAt,
	expireOnlyOwnershipLease,
	killAndCollect,
	type PersistenceSnapshot,
	readPersistenceSnapshot,
	spawnPublicResumeAtPhase,
	type WorkerSignal,
} from "../helpers/orchestrator-crash-harness";
import { cleanupTempDir, makeTempDir } from "../helpers/temp-run-dir";

const STATE_FILENAME = "state.json";
const TEMP_STATE_FILENAME = "state.json.tmp";

function assertAuthorityUnchangedAcrossResume(
	before: PersistenceSnapshot,
	after: PersistenceSnapshot,
): void {
	expect(after.schemaVersion).toBe(before.schemaVersion);
	expect(after.incarnation).toEqual(before.incarnation);
	expect(after.ownership.count).toBe(1);
	expect(after.ownership.incarnationId).toBe(before.incarnation.id);
	expect(after.ownership.status).toBe("HELD");
	expect(after.ownership.ownerToken).not.toBe(before.ownership.ownerToken);
	expect(BigInt(after.ownership.fenceToken)).toBe(
		BigInt(before.ownership.fenceToken) + 1n,
	);
	expect(after.state).toEqual(before.state);
	expect(after.state.revision).toBe("0");
	expect(after.state.committedByFenceToken).toBe("1");
}

async function assertPublicResumeRepairsFromSqlite(params: {
	readonly dir: string;
	readonly runDirRoot: string;
	readonly runDir: string;
	readonly runId: string;
	readonly dbPath: string;
	readonly before: PersistenceSnapshot;
}): Promise<void> {
	const statePath = join(params.runDir, STATE_FILENAME);
	const temporaryStatePath = join(params.runDir, TEMP_STATE_FILENAME);
	const phaseSignalFile = join(params.dir, "phase-signal.json");

	// A deliberately invalid projection proves that resume does not use it as
	// migration input when the authoritative database already exists.
	writeFileSync(statePath, JSON.stringify({ source: "state-json-decoy" }), {
		encoding: "utf-8",
	});
	expireOnlyOwnershipLease(params.dbPath);

	const resumed = await spawnPublicResumeAtPhase(
		params.runDirRoot,
		params.runId,
		phaseSignalFile,
	);
	const expectedState = {
		source: "sqlite-authority",
		marker: params.runId,
	};
	const expectedPhaseSignal: WorkerSignal = {
		type: "PHASE_ENTERED",
		phase: "start",
		runId: params.runId,
		runDir: params.runDir,
		state: expectedState,
	};
	let output: Awaited<ReturnType<typeof killAndCollect>> | undefined;
	try {
		expect(resumed.signal).toEqual(expectedPhaseSignal);

		const after = readPersistenceSnapshot(params.dbPath);
		assertAuthorityUnchangedAcrossResume(params.before, after);

		expect(existsSync(statePath)).toBe(true);
		expect(existsSync(temporaryStatePath)).toBe(false);
		const projected = JSON.parse(readFileSync(statePath, "utf-8")) as Record<
			string,
			unknown
		>;
		expect(projected.runId).toBe(params.runId);
		expect(projected.orchestratorName).toBe(CRASH_TEST_ORCHESTRATOR_NAME);
		expect(projected.runIncarnationId).toBe(params.before.incarnation.id);
		expect(projected.currentPhase).toBe("start");
		expect(projected.stateRevision).toBe("0");
		expect(projected.committedFenceToken).toBe("1");
		expect(projected.stateDigest).toBe(params.before.state.digest);
		expect(projected).not.toHaveProperty(PENDING_INITIAL_DISPATCH_STATE_FIELD);
		expect(projected.data).toEqual(expectedState);
	} finally {
		output = await killAndCollect(resumed.worker);
	}

	expect(output.exitCode).not.toBe(0);
	expect(output.stdout).toBe("");
	expect(output.stderr).not.toContain("orchestrator crash worker failed");
}

describe("orchestrator projection crash recovery", () => {
	test("real initial path dies after bootstrap returns and real --resume repairs and dispatches SQLite state", async () => {
		const dir = makeTempDir("orchestrator-boundary-crash-");
		const runDirRoot = join(dir, "runs");
		const runId = "01HX0000000000000000000001";
		const runDir = join(runDirRoot, CRASH_TEST_ORCHESTRATOR_NAME, runId);
		const dbPath = join(runDir, "turnlock.sqlite3");
		const signalFile = join(dir, "initial-signal.json");

		try {
			const crashed = await crashInitialModeAt(
				runDirRoot,
				runId,
				signalFile,
				"BEFORE_INITIAL_PROJECTION",
			);
			expect(crashed.signal).toEqual({
				type: "FAULT_POINT_REACHED",
				point: "BEFORE_INITIAL_PROJECTION",
				observedPoints: ["AFTER_BOOTSTRAP_RESULT", "BEFORE_INITIAL_PROJECTION"],
			});
			expect(crashed.exitCode).not.toBe(0);
			expect(crashed.stdout).toBe("");
			expect(crashed.stderr).not.toContain("orchestrator crash worker failed");

			expect(existsSync(dbPath)).toBe(true);
			expect(existsSync(join(runDir, STATE_FILENAME))).toBe(false);
			expect(existsSync(join(runDir, TEMP_STATE_FILENAME))).toBe(false);

			const before = readPersistenceSnapshot(dbPath);
			expect(before.incarnation.count).toBe(1);
			expect(before.ownership.count).toBe(1);
			expect(before.state.count).toBe(1);
			expect(before.incarnation.runId).toBe(runId);
			expect(before.incarnation.orchestratorName).toBe(
				CRASH_TEST_ORCHESTRATOR_NAME,
			);
			expect(before.ownership.incarnationId).toBe(before.incarnation.id);
			expect(before.state.incarnationId).toBe(before.incarnation.id);
			expect(before.ownership.fenceToken).toBe("1");
			expect(before.state.revision).toBe("0");
			expect(before.state.committedByFenceToken).toBe("1");

			await assertPublicResumeRepairsFromSqlite({
				dir,
				runDirRoot,
				runDir,
				runId,
				dbPath,
				before,
			});
		} finally {
			cleanupTempDir(dir);
		}
	});

	test("SIGKILL after temporary projection write leaves SQLite unchanged and real --resume replaces the temp", async () => {
		const dir = makeTempDir("projection-write-crash-");
		const runDirRoot = join(dir, "runs");
		const runId = "01HX0000000000000000000002";
		const runDir = join(runDirRoot, CRASH_TEST_ORCHESTRATOR_NAME, runId);
		const dbPath = join(runDir, "turnlock.sqlite3");
		const signalFile = join(dir, "projection-signal.json");
		const statePath = join(runDir, STATE_FILENAME);
		const temporaryStatePath = join(runDir, TEMP_STATE_FILENAME);

		try {
			const crashed = await crashInitialModeAt(
				runDirRoot,
				runId,
				signalFile,
				"AFTER_TEMP_FILE_WRITE",
			);
			expect(crashed.signal).toEqual({
				type: "FAULT_POINT_REACHED",
				point: "AFTER_TEMP_FILE_WRITE",
				observedPoints: [
					"AFTER_BOOTSTRAP_RESULT",
					"BEFORE_INITIAL_PROJECTION",
					"AFTER_TEMP_FILE_WRITE",
				],
			});
			expect(crashed.exitCode).not.toBe(0);
			expect(crashed.stdout).toBe("");
			expect(crashed.stderr).not.toContain("orchestrator crash worker failed");

			const before = readPersistenceSnapshot(dbPath);
			expect(before.ownership.fenceToken).toBe("1");
			expect(before.state.revision).toBe("0");
			expect(existsSync(statePath)).toBe(false);
			expect(existsSync(temporaryStatePath)).toBe(true);

			const interruptedProjection = JSON.parse(
				readFileSync(temporaryStatePath, "utf-8"),
			) as Record<string, unknown>;
			expect(interruptedProjection.runIncarnationId).toBe(
				before.incarnation.id,
			);
			expect(interruptedProjection.stateRevision).toBe("0");
			expect(interruptedProjection.stateDigest).toBe(before.state.digest);

			await assertPublicResumeRepairsFromSqlite({
				dir,
				runDirRoot,
				runDir,
				runId,
				dbPath,
				before,
			});
		} finally {
			cleanupTempDir(dir);
		}
	});

	test("process-only SIGKILL after rename preserves a visible projection without claiming power-loss durability", async () => {
		const dir = makeTempDir("projection-rename-crash-");
		const runDirRoot = join(dir, "runs");
		const runId = "01HX0000000000000000000003";
		const runDir = join(runDirRoot, CRASH_TEST_ORCHESTRATOR_NAME, runId);
		const dbPath = join(runDir, "turnlock.sqlite3");
		const signalFile = join(dir, "rename-signal.json");
		const statePath = join(runDir, STATE_FILENAME);
		const temporaryStatePath = join(runDir, TEMP_STATE_FILENAME);

		try {
			const crashed = await crashInitialModeAt(
				runDirRoot,
				runId,
				signalFile,
				"AFTER_RENAME",
			);
			expect(crashed.signal).toEqual({
				type: "FAULT_POINT_REACHED",
				point: "AFTER_RENAME",
				observedPoints: [
					"AFTER_BOOTSTRAP_RESULT",
					"BEFORE_INITIAL_PROJECTION",
					"AFTER_TEMP_FILE_WRITE",
					"AFTER_TEMP_FILE_FSYNC",
					"AFTER_RENAME",
				],
			});
			expect(crashed.exitCode).not.toBe(0);
			expect(crashed.stdout).toBe("");

			const before = readPersistenceSnapshot(dbPath);
			expect(existsSync(statePath)).toBe(true);
			expect(existsSync(temporaryStatePath)).toBe(false);
			const renamedProjection = JSON.parse(
				readFileSync(statePath, "utf-8"),
			) as Record<string, unknown>;
			expect(renamedProjection.runIncarnationId).toBe(before.incarnation.id);
			expect(renamedProjection.stateDigest).toBe(before.state.digest);

			await assertPublicResumeRepairsFromSqlite({
				dir,
				runDirRoot,
				runDir,
				runId,
				dbPath,
				before,
			});
		} finally {
			cleanupTempDir(dir);
		}
	});
});
