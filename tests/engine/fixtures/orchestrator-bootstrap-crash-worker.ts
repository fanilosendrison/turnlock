#!/usr/bin/env bun
// Orchestrator bootstrap crash worker — simulates what runInitialMode
// does: creates RUN_DIR structure, opens the SQLite DB, calls
// bootstrapNewRunAtomicCore, then blocks at AFTER_COMMIT_BEFORE_HANDLE
// (after COMMIT, before projection/result construction).
//
// The parent kills this process with SIGKILL.  After the kill:
//   - SQLite is fully durable (all three tables)
//   - state.json was never projected
//   - No LockHandle was returned to the caller
//
// Usage:
//   bun run tests/engine/fixtures/orchestrator-bootstrap-crash-worker.ts \
//     --db-path <path> \
//     --run-dir <path> \
//     --run-id <runId> \
//     --orchestrator-name <name> \
//     --signal-file <path>

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bunSqliteDriver } from "../../../src/persistence/sqlite/bun-sqlite-driver";
import {
	type BootstrapFaultPoint,
	bootstrapNewRunAtomicCore,
} from "../../../src/persistence/sqlite/run-bootstrap-core";
import { openRunDatabase } from "../../../src/persistence/sqlite/run-database";

// ---------------------------------------------------------------------------
// Constants (match run-orchestrator.ts)
// ---------------------------------------------------------------------------

const STATE_SCHEMA_VERSION = 4;
const LEASE_MS = 30 * 60 * 1000;
const NOW_EPOCH = 1_000_000_000_000;
const NOW_ISO = "2001-09-09T01:46:40.000Z";
const CONTENTION_DEADLINE_MS = 5000;

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
// Main
// ---------------------------------------------------------------------------

function main() {
	const args = parseArgs(process.argv.slice(2));

	const dbPath = args["db-path"];
	const runDir = args["run-dir"];
	const runId = args["run-id"];
	const orchestratorName = args["orchestrator-name"];
	const signalFile = args["signal-file"];

	if (!dbPath || !runDir || !runId || !orchestratorName || !signalFile) {
		process.stderr.write("Missing required arguments.\n");
		process.exit(1);
	}

	// Create the RUN_DIR structure (mirrors runInitialMode).
	mkdirSync(runDir, { recursive: true });
	mkdirSync(join(runDir, "delegations"), { recursive: true });
	mkdirSync(join(runDir, "results"), { recursive: true });
	mkdirSync(join(runDir, "external-requests"), { recursive: true });
	mkdirSync(join(runDir, "external-results"), { recursive: true });
	mkdirSync(join(runDir, "accepted-external-resolutions"), { recursive: true });
	mkdirSync(join(runDir, "artifacts", "sha256"), { recursive: true });

	// Open SQLite and bootstrap.
	const runDb = openRunDatabase({
		driver: bunSqliteDriver,
		dbPath,
		busyTimeoutMs: 2000,
	});

	const initialState: Record<string, unknown> = {
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

	const blocker = new Int32Array(new SharedArrayBuffer(4));

	function signalAndBlock(point: BootstrapFaultPoint): void {
		if (point === "AFTER_COMMIT_BEFORE_HANDLE") {
			const msg = JSON.stringify({
				type: "FAULT_POINT_REACHED",
				point,
			});
			process.stdout.write(`${msg}\n`);
			writeFileSync(signalFile!, point, "utf-8");

			Atomics.wait(blocker, 0, 0);
		}
	}

	try {
		const result = bootstrapNewRunAtomicCore(
			{
				db: runDb.connection,
				runId,
				orchestratorName,
				nowEpochMs: NOW_EPOCH,
				nowIso: NOW_ISO,
				leaseDurationMs: LEASE_MS,
				leaseClockEpochMs: () => NOW_EPOCH,
				initialState,
				stateSchemaVersion: STATE_SCHEMA_VERSION,
				contentionDeadlineMs: CONTENTION_DEADLINE_MS,
			},
			{
				generateId: () => `worker-${runId}`,
				onFaultPoint: signalAndBlock,
			},
		);

		// Should not reach — blocked at AFTER_COMMIT_BEFORE_HANDLE.
		process.stdout.write(
			`${JSON.stringify({ type: "RESULT_RETURNED", kind: result.kind })}\n`,
		);
	} catch (error) {
		const msg = String(error);
		if (!msg.includes("InjectedBootstrapFailure")) {
			process.stderr.write(`UNEXPECTED_ERROR: ${msg}\n`);
			process.exit(1);
		}
	}

	runDb.close();
	process.exit(0);
}

main();
