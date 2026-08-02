// Real-process crash recovery across the orchestrator/bootstrap/projection seam.
//
// These tests deliberately SIGKILL a worker while it is executing the real
// initial-mode engine path, then resume through the public `--resume` path.
// SQLite is the authority throughout; state.json is only a repairable view.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	PENDING_INITIAL_DISPATCH_STATE_FIELD,
	PENDING_INITIAL_DISPATCH_VERSION_STATE_FIELD,
} from "../../src/constants";
import {
	CRASH_TEST_ORCHESTRATOR_NAME,
	crashInitialModeAt,
	expireOnlyOwnershipLease,
	killAndCollect,
	type PersistenceSnapshot,
	readPersistenceSnapshot,
	runInitialToCompletion,
	runPublicResumeToCompletion,
	spawnPublicResumeAtPhase,
	type WorkerSignal,
} from "../helpers/orchestrator-crash-harness";
import { cleanupTempDir, makeTempDir } from "../helpers/temp-run-dir";

const STATE_FILENAME = "state.json";
const TEMP_STATE_FILENAME = "state.json.tmp";

function readSentinelEntries(sentinelFile: string): readonly string[] {
	return readFileSync(sentinelFile, "utf-8")
		.split("\n")
		.filter((entry) => entry.length > 0);
}

function assertInitialDispatchClaimCommittedOnResume(
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
	expect(after.state.count).toBe(1);
	expect(after.state.incarnationId).toBe(before.state.incarnationId);
	expect(after.state.revision).toBe("1");
	expect(after.state.committedByFenceToken).toBe(after.ownership.fenceToken);
	if (after.ownership.ownerToken === null) {
		throw new Error("resumed worker must hold an ownership token");
	}
	expect(after.state.committedByOwnerToken).toBe(after.ownership.ownerToken);

	const expectedClaimedState = JSON.parse(before.state.json) as Record<
		string,
		unknown
	>;
	delete expectedClaimedState[PENDING_INITIAL_DISPATCH_STATE_FIELD];
	delete expectedClaimedState[PENDING_INITIAL_DISPATCH_VERSION_STATE_FIELD];
	expect(JSON.parse(after.state.json)).toEqual(expectedClaimedState);
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
		assertInitialDispatchClaimCommittedOnResume(params.before, after);

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
		expect(projected.stateRevision).toBe("1");
		expect(projected.committedFenceToken).toBe(
			after.state.committedByFenceToken,
		);
		expect(projected.stateDigest).toBe(after.state.digest);
		expect(projected).not.toHaveProperty(PENDING_INITIAL_DISPATCH_STATE_FIELD);
		expect(projected).not.toHaveProperty(
			PENDING_INITIAL_DISPATCH_VERSION_STATE_FIELD,
		);
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

	test("SIGKILL before the initial dispatch claim permits one public resume", async () => {
		const dir = makeTempDir("initial-dispatch-preclaim-crash-");
		const runDirRoot = join(dir, "runs");
		const runId = "01HX0000000000000000000005";
		const runDir = join(runDirRoot, CRASH_TEST_ORCHESTRATOR_NAME, runId);
		const dbPath = join(runDir, "turnlock.sqlite3");
		const initialSignalFile = join(dir, "initial-signal.json");
		const phaseSignalFile = join(dir, "phase-signal.json");
		const sentinelFile = join(dir, "phase-sentinel.txt");

		try {
			const crashed = await crashInitialModeAt(
				runDirRoot,
				runId,
				initialSignalFile,
				"BEFORE_INITIAL_DISPATCH_CLAIM",
			);
			expect(crashed.signal).toMatchObject({
				type: "FAULT_POINT_REACHED",
				point: "BEFORE_INITIAL_DISPATCH_CLAIM",
			});

			const before = readPersistenceSnapshot(dbPath);
			expect(before.state.revision).toBe("0");
			const beforeClaim = JSON.parse(before.state.json) as Record<
				string,
				unknown
			>;
			expect(beforeClaim[PENDING_INITIAL_DISPATCH_STATE_FIELD]).toBe(true);
			expect(beforeClaim[PENDING_INITIAL_DISPATCH_VERSION_STATE_FIELD]).toBe(1);

			expireOnlyOwnershipLease(dbPath);
			const resumed = await spawnPublicResumeAtPhase(
				runDirRoot,
				runId,
				phaseSignalFile,
				{ sentinelFile },
			);
			let output: Awaited<ReturnType<typeof killAndCollect>> | undefined;
			try {
				expect(resumed.signal).toMatchObject({
					type: "PHASE_ENTERED",
					phase: "start",
					runId,
				});
				expect(readSentinelEntries(sentinelFile)).toEqual(["start"]);

				const after = readPersistenceSnapshot(dbPath);
				expect(after.state.revision).toBe("1");
				const claimed = JSON.parse(after.state.json) as Record<string, unknown>;
				expect(claimed).not.toHaveProperty(
					PENDING_INITIAL_DISPATCH_STATE_FIELD,
				);
				expect(claimed).not.toHaveProperty(
					PENDING_INITIAL_DISPATCH_VERSION_STATE_FIELD,
				);
			} finally {
				output = await killAndCollect(resumed.worker);
			}
			expect(output.exitCode).not.toBe(0);
		} finally {
			cleanupTempDir(dir);
		}
	});

	test("SIGKILL after the initial dispatch claim refuses resume before phase entry", async () => {
		const dir = makeTempDir("initial-dispatch-postclaim-crash-");
		const runDirRoot = join(dir, "runs");
		const runId = "01HX0000000000000000000006";
		const runDir = join(runDirRoot, CRASH_TEST_ORCHESTRATOR_NAME, runId);
		const dbPath = join(runDir, "turnlock.sqlite3");
		const initialSignalFile = join(dir, "initial-signal.json");
		const sentinelFile = join(dir, "phase-sentinel.txt");

		try {
			const crashed = await crashInitialModeAt(
				runDirRoot,
				runId,
				initialSignalFile,
				"AFTER_INITIAL_DISPATCH_CLAIM",
			);
			expect(crashed.signal).toMatchObject({
				type: "FAULT_POINT_REACHED",
				point: "AFTER_INITIAL_DISPATCH_CLAIM",
			});

			const claimed = readPersistenceSnapshot(dbPath);
			expect(claimed.state.revision).toBe("1");
			const claimedState = JSON.parse(claimed.state.json) as Record<
				string,
				unknown
			>;
			expect(claimedState).not.toHaveProperty(
				PENDING_INITIAL_DISPATCH_STATE_FIELD,
			);
			expect(claimedState).not.toHaveProperty(
				PENDING_INITIAL_DISPATCH_VERSION_STATE_FIELD,
			);

			expireOnlyOwnershipLease(dbPath);
			const resumed = await runPublicResumeToCompletion(runDirRoot, runId, {
				sentinelFile,
			});
			expect(resumed.exitCode).not.toBe(0);
			expect(resumed.stdout).toContain("resume without pending delegation");
			expect(existsSync(sentinelFile)).toBe(false);

			const after = readPersistenceSnapshot(dbPath);
			expect(after.state.revision).toBe("1");
			expect(after.state.json).toBe(claimed.state.json);
		} finally {
			cleanupTempDir(dir);
		}
	});

	test("normal initial execution claims revision 1 before its durable phase result", async () => {
		const dir = makeTempDir("initial-dispatch-normal-");
		const runDirRoot = join(dir, "runs");
		const runId = "01HX0000000000000000000007";
		const runDir = join(runDirRoot, CRASH_TEST_ORCHESTRATOR_NAME, runId);
		const dbPath = join(runDir, "turnlock.sqlite3");
		const sentinelFile = join(dir, "phase-sentinel.txt");

		try {
			const completed = await runInitialToCompletion(runDirRoot, runId, {
				sentinelFile,
			});
			expect(completed.exitCode).toBe(0);
			expect(completed.stdout).toContain("@@TURNLOCK@@");
			expect(readSentinelEntries(sentinelFile)).toEqual(["start"]);

			const state = readPersistenceSnapshot(dbPath);
			expect(state.state.revision).toBe("2");
			const authoritativeState = JSON.parse(state.state.json) as Record<
				string,
				unknown
			>;
			expect(authoritativeState.phasesExecuted).toBe(1);
			expect(authoritativeState).toHaveProperty("terminalResult");
			expect(authoritativeState).not.toHaveProperty(
				PENDING_INITIAL_DISPATCH_STATE_FIELD,
			);
			expect(authoritativeState).not.toHaveProperty(
				PENDING_INITIAL_DISPATCH_VERSION_STATE_FIELD,
			);
			const projectedState = JSON.parse(
				readFileSync(join(runDir, STATE_FILENAME), "utf-8"),
			) as Record<string, unknown>;
			expect(projectedState.stateRevision).toBe("2");
		} finally {
			cleanupTempDir(dir);
		}
	});

	test("refuses a second public resume after SIGKILL interrupts the first freely executing phase", async () => {
		const dir = makeTempDir("initial-phase-replay-crash-");
		const runDirRoot = join(dir, "runs");
		const runId = "01HX0000000000000000000004";
		const runDir = join(runDirRoot, CRASH_TEST_ORCHESTRATOR_NAME, runId);
		const dbPath = join(runDir, "turnlock.sqlite3");
		const initialSignalFile = join(dir, "initial-signal.json");
		const phaseSignalFile = join(dir, "phase-signal.json");
		const sentinelFile = join(dir, "phase-sentinel.txt");

		try {
			const crashed = await crashInitialModeAt(
				runDirRoot,
				runId,
				initialSignalFile,
				"AFTER_INITIAL_PROJECTION",
			);
			expect(crashed.signal).toEqual({
				type: "FAULT_POINT_REACHED",
				point: "AFTER_INITIAL_PROJECTION",
				observedPoints: [
					"AFTER_BOOTSTRAP_RESULT",
					"BEFORE_INITIAL_PROJECTION",
					"AFTER_TEMP_FILE_WRITE",
					"AFTER_TEMP_FILE_FSYNC",
					"AFTER_RENAME",
					"BEFORE_DIRECTORY_FSYNC",
					"AFTER_INITIAL_PROJECTION",
				],
			});
			expect(crashed.exitCode).not.toBe(0);

			expireOnlyOwnershipLease(dbPath);
			const firstResume = await spawnPublicResumeAtPhase(
				runDirRoot,
				runId,
				phaseSignalFile,
				{ sentinelFile },
			);
			let firstResumeOutput:
				| Awaited<ReturnType<typeof killAndCollect>>
				| undefined;
			try {
				expect(firstResume.signal).toMatchObject({
					type: "PHASE_ENTERED",
					phase: "start",
					runId,
				});
				expect(readSentinelEntries(sentinelFile)).toEqual(["start"]);
			} finally {
				firstResumeOutput = await killAndCollect(firstResume.worker);
			}
			expect(firstResumeOutput.exitCode).not.toBe(0);
			expect(firstResumeOutput.stdout).toBe("");

			expireOnlyOwnershipLease(dbPath);
			const secondResume = await runPublicResumeToCompletion(
				runDirRoot,
				runId,
				{
					sentinelFile,
				},
			);

			expect(secondResume.exitCode).not.toBe(0);
			expect(secondResume.stdout).toContain(
				"resume without pending delegation",
			);
			expect(readSentinelEntries(sentinelFile)).toEqual(["start"]);
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
