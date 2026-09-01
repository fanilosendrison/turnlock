#!/usr/bin/env node
// Bootstrap crash worker — executes bootstrapNewRunAtomicCore or
// migrateLegacyRunAtomicCore with an injected fault point, signals
// the parent when the target point is reached via a signal file,
// then blocks the thread until killed by SIGKILL.
//
// The parent must kill this process with SIGKILL — no graceful
// shutdown, no db.close(), no ROLLBACK is executed by the worker.
//
// Usage:
//   node tests/persistence/fixtures/bootstrap-crash-worker.ts \
//     --run-dir <path> \
//     --mode BOOTSTRAP|MIGRATION \
//     --crash-point <BootstrapFaultPoint> \
//     --run-id <runId> \
//     --orchestrator-name <name> \
//     --signal-file <path> \
//     [--legacy-state-file <path>]
//
// The database path is derived from --run-dir:
//   dbPath = runDir + "/turnlock.sqlite3"
// This matches the production convention in runInitialMode().
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { STATE_SCHEMA_VERSION } from "../../../src/constants.js";
import { nodeSqliteDriver } from "../../../src/persistence/sqlite/node-sqlite-driver.js";
import {
	type BootstrapFaultPoint,
	bootstrapNewRunAtomicCore,
	migrateLegacyRunAtomicCore,
} from "../../../src/persistence/sqlite/run-bootstrap-core.js";
import { openRunDatabase } from "../../../src/persistence/sqlite/run-database.js";

// ---------------------------------------------------------------------------
// Parse CLI args
// ---------------------------------------------------------------------------
function parseArgs(argv: string[]) {
	const args: Record<string, string> = {};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === undefined || !arg.startsWith("--")) continue;
		const key = arg.slice(2);
		const value: string | undefined = argv[i + 1];
		if (value !== undefined && !value.startsWith("--")) {
			args[key] = value;
			i++;
		} else {
			args[key] = "true";
		}
	}
	return args;
}
// ---------------------------------------------------------------------------
// Constants (deterministic, shared with tests)
// ---------------------------------------------------------------------------
const LEASE_MS = 30 * 60 * 1000;
const NOW_EPOCH = 1000000000000;
const NOW_ISO = "2001-09-09T01:46:40.000Z";
const CONTENTION_DEADLINE_MS = 2000;
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeInitialState(
	runId: string,
	orchestratorName: string,
): Record<string, unknown> {
	return {
		schemaVersion: STATE_SCHEMA_VERSION,
		runId,
		orchestratorName,
		startedAt: NOW_ISO,
		startedAtEpochMs: NOW_EPOCH,
		lastTransitionAt: NOW_ISO,
		lastTransitionAtEpochMs: NOW_EPOCH,
		currentPhase: "start",
		phasesExecuted: 0,
		accumulatedDurationMs: 0,
		data: { stage: "initial" },
		usedLabels: [],
	};
}
function makeWorkerIdGenerator(runId: string): () => string {
	let idIndex = 0;
	return () => {
		idIndex++;
		return idIndex === 1 ? `owner-${runId}` : `incarnation-${runId}`;
	};
}
// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function main() {
	const args = parseArgs(process.argv.slice(2));
	const runDir = args["run-dir"];
	const mode = args.mode;
	const crashPoint = args["crash-point"] as BootstrapFaultPoint;
	const runId = args["run-id"];
	const orchestratorName = args["orchestrator-name"];
	const signalFile = args["signal-file"];
	const legacyStateFile = args["legacy-state-file"];
	if (
		!runDir ||
		!mode ||
		!crashPoint ||
		!runId ||
		!orchestratorName ||
		!signalFile
	) {
		process.stderr.write(
			"Missing required arguments. Need: --run-dir --mode --crash-point --run-id --orchestrator-name --signal-file\n",
		);
		process.exit(1);
	}
	const validatedSignalFile = signalFile;
	if (mode !== "BOOTSTRAP" && mode !== "MIGRATION") {
		process.stderr.write(
			`Invalid mode: ${mode}. Must be BOOTSTRAP or MIGRATION\n`,
		);
		process.exit(1);
	}
	if (mode === "MIGRATION" && !legacyStateFile) {
		process.stderr.write("MIGRATION mode requires --legacy-state-file\n");
		process.exit(1);
	}
	// Ensure the RUN_DIR exists, then derive the database path from it.
	// This matches the production convention in runInitialMode():
	//   const dbPath = path.join(runDir, "turnlock.sqlite3");
	mkdirSync(runDir, { recursive: true });
	const dbPath = join(runDir, "turnlock.sqlite3");
	// Open the database — schema is created if needed.
	const runDb = openRunDatabase({
		driver: nodeSqliteDriver,
		dbPath,
		busyTimeoutMs: 500,
	});
	const blocker = new Int32Array(new SharedArrayBuffer(4));
	function signalAndBlock(point: BootstrapFaultPoint): void {
		if (point === crashPoint) {
			// Signal the parent via stdout and the signal file.
			const msg = JSON.stringify({
				type: "FAULT_POINT_REACHED",
				point,
			});
			process.stdout.write(`${msg}\n`);
			writeFileSync(validatedSignalFile, point, "utf-8");
			// Block the thread until killed by SIGKILL.
			// Atomics.wait blocks synchronously — no microtasks,
			// no cleanup, no db.close().
			Atomics.wait(blocker, 0, 0);
			// Never reached.
		}
	}
	try {
		if (mode === "BOOTSTRAP") {
			const result = bootstrapNewRunAtomicCore(
				{
					db: runDb.connection,
					runId,
					orchestratorName,
					nowEpochMs: NOW_EPOCH,
					nowIso: NOW_ISO,
					leaseDurationMs: LEASE_MS,
					leaseClockEpochMs: () => NOW_EPOCH,
					initialState: makeInitialState(runId, orchestratorName),
					stateSchemaVersion: STATE_SCHEMA_VERSION,
					contentionDeadlineMs: CONTENTION_DEADLINE_MS,
				},
				{
					generateId: makeWorkerIdGenerator(runId),
					onFaultPoint: signalAndBlock,
				},
			);
			// If we get here, the function returned before the crash point
			// (should not happen for pre-commit or post-commit points).
			process.stdout.write(
				`${JSON.stringify({ type: "RESULT_RETURNED", kind: result.kind })}\n`,
			);
		} else {
			// MIGRATION mode.
			const legacyStateRaw = readFileSync(legacyStateFile as string, "utf-8");
			const legacyState = JSON.parse(legacyStateRaw) as Record<string, unknown>;
			// Extract legacy timestamps from the state file.
			const legacyStartedAtEpochMs =
				(legacyState.startedAtEpochMs as number) ?? NOW_EPOCH;
			const legacyStartedAt = (legacyState.startedAt as string) ?? NOW_ISO;
			const legacyLastTransitionAtEpochMs =
				(legacyState.lastTransitionAtEpochMs as number) ?? NOW_EPOCH;
			const legacyLastTransitionAt =
				(legacyState.lastTransitionAt as string) ?? NOW_ISO;
			const result = migrateLegacyRunAtomicCore(
				{
					db: runDb.connection,
					runId,
					orchestratorName,
					nowEpochMs: NOW_EPOCH,
					nowIso: NOW_ISO,
					leaseDurationMs: LEASE_MS,
					leaseClockEpochMs: () => NOW_EPOCH,
					legacyState,
					legacyStartedAtEpochMs,
					legacyStartedAt,
					legacyLastTransitionAtEpochMs,
					legacyLastTransitionAt,
					stateSchemaVersion: STATE_SCHEMA_VERSION,
					contentionDeadlineMs: CONTENTION_DEADLINE_MS,
				},
				{
					generateId: makeWorkerIdGenerator(runId),
					onFaultPoint: signalAndBlock,
				},
			);
			process.stdout.write(
				`${JSON.stringify({ type: "RESULT_RETURNED", kind: result.kind })}\n`,
			);
		}
	} catch (error) {
		// An unexpected error occurred (not from our fault injection).
		// This is normal for pre-commit fault points where the internal
		// transaction logic throws after we blocked (if we didn't block).
		// But since we block before throwing, this should only happen
		// if the function fails for another reason.
		const msg = String(error);
		if (!msg.includes("InjectedBootstrapFailure")) {
			process.stderr.write(`UNEXPECTED_ERROR: ${msg}\n`);
			process.exit(1);
		}
		// If we somehow get an InjectedBootstrapFailure here, it means
		// we didn't block — shouldn't happen but exit cleanly.
	}
	// Close the DB (only reached if we DIDN'T block, e.g., for
	// RESULT_RETURNED before crash point, or unexpected path).
	runDb.close();
	process.exit(0);
}
main();
