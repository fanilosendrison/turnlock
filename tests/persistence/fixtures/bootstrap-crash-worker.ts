#!/usr/bin/env bun
// Bootstrap crash worker — executes bootstrapNewRunAtomicCore or
// migrateLegacyRunAtomicCore with an injected fault point, signals
// the parent when the target point is reached via a signal file,
// then blocks the thread until killed by SIGKILL.
//
// The parent must kill this process with SIGKILL — no graceful
// shutdown, no db.close(), no ROLLBACK is executed by the worker.
//
// Usage:
//   bun run tests/persistence/fixtures/bootstrap-crash-worker.ts \
//     --db-path <path> \
//     --mode BOOTSTRAP|MIGRATION \
//     --crash-point <BootstrapFaultPoint> \
//     --run-id <runId> \
//     --orchestrator-name <name> \
//     --signal-file <path> \
//     [--legacy-state-file <path>]

import { readFileSync, writeFileSync } from "node:fs";
import { bunSqliteDriver } from "../../../src/persistence/sqlite/bun-sqlite-driver";
import {
	type BootstrapFaultPoint,
	bootstrapNewRunAtomicCore,
	migrateLegacyRunAtomicCore,
} from "../../../src/persistence/sqlite/run-bootstrap-core";
import { openRunDatabase } from "../../../src/persistence/sqlite/run-database";

// ---------------------------------------------------------------------------
// Parse CLI args
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]) {
	const args: Record<string, string> = {};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]!;
		if (arg.startsWith("--")) {
			const key = arg.slice(2);
			const value: string | undefined = argv[i + 1];
			if (value !== undefined && !value.startsWith("--")) {
				args[key] = value;
				i++;
			} else {
				args[key] = "true";
			}
		}
	}
	return args;
}

// ---------------------------------------------------------------------------
// Constants (deterministic, shared with tests)
// ---------------------------------------------------------------------------

const STATE_SCHEMA_VERSION = 4; // from constants.ts
const LEASE_MS = 30 * 60 * 1000;
const NOW_EPOCH = 1_000_000_000_000;
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

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
	const args = parseArgs(process.argv.slice(2));

	const dbPath = args["db-path"];
	const mode = args.mode;
	const crashPoint = args["crash-point"] as BootstrapFaultPoint;
	const runId = args["run-id"];
	const orchestratorName = args["orchestrator-name"];
	const signalFile = args["signal-file"];
	const legacyStateFile = args["legacy-state-file"];

	if (
		!dbPath ||
		!mode ||
		!crashPoint ||
		!runId ||
		!orchestratorName ||
		!signalFile
	) {
		process.stderr.write(
			"Missing required arguments. Need: --db-path --mode --crash-point --run-id --orchestrator-name --signal-file\n",
		);
		process.exit(1);
	}

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

	// Open the database — schema is created if needed.
	const runDb = openRunDatabase({
		driver: bunSqliteDriver,
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
			writeFileSync(signalFile!, point, "utf-8");

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
					generateId: () => `worker-${runId}`,
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
					generateId: () => `worker-${runId}`,
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
