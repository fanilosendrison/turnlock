#!/usr/bin/env bun

import { renameSync, writeFileSync } from "node:fs";
import {
	type RunOrchestratorInternalDependencies,
	runOrchestratorInternal,
} from "../../../src/engine/run-orchestrator";
import { runOrchestrator } from "../../../src/index";
import type { ProjectionFaultPoint } from "../../../src/persistence/sqlite/run-state-store";
import type { OrchestratorConfig } from "../../../src/types/config";

interface WorkerState {
	readonly source: string;
	readonly marker: string;
}

type LifecycleFaultPoint =
	| "AFTER_BOOTSTRAP_RESULT"
	| "BEFORE_INITIAL_PROJECTION"
	| "AFTER_INITIAL_PROJECTION";

type WorkerFaultPoint = LifecycleFaultPoint | ProjectionFaultPoint;

interface WorkerSignal {
	readonly type: "FAULT_POINT_REACHED" | "PHASE_ENTERED";
	readonly point?: WorkerFaultPoint;
	readonly observedPoints?: readonly WorkerFaultPoint[];
	readonly phase?: string;
	readonly runId?: string;
	readonly runDir?: string;
	readonly state?: WorkerState;
}

function parseArgs(argv: readonly string[]): Readonly<Record<string, string>> {
	const args: Record<string, string> = {};
	for (let index = 0; index < argv.length; index++) {
		const argument = argv[index];
		if (argument === undefined || !argument.startsWith("--")) continue;
		const value = argv[index + 1];
		if (value === undefined || value.startsWith("--")) {
			args[argument.slice(2)] = "true";
			continue;
		}
		args[argument.slice(2)] = value;
		index++;
	}
	return args;
}

const blocker = new Int32Array(new SharedArrayBuffer(4));

function signalAndBlock(signalFile: string, signal: WorkerSignal): never {
	const temporarySignalFile = `${signalFile}.${process.pid}.tmp`;
	writeFileSync(temporarySignalFile, JSON.stringify(signal), {
		encoding: "utf-8",
	});
	renameSync(temporarySignalFile, signalFile);
	Atomics.wait(blocker, 0, 0);
	throw new Error("Fault-point blocker unexpectedly resumed");
}

function requiredArg(
	args: Readonly<Record<string, string>>,
	name: string,
): string {
	const value = args[name];
	if (value === undefined || value === "") {
		throw new Error(`Missing required argument --${name}`);
	}
	return value;
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	const workerMode = requiredArg(args, "worker-mode");
	const runDirRoot = requiredArg(args, "run-dir-root");
	const runId = requiredArg(args, "run-id");
	const orchestratorName = requiredArg(args, "orchestrator-name");
	const phaseSignalFile = args["phase-signal-file"];

	const initialMode = workerMode === "initial";
	const config: OrchestratorConfig<WorkerState> = {
		name: orchestratorName,
		initial: initialMode ? "start" : "decoy",
		initialState: initialMode
			? { source: "sqlite-authority", marker: runId }
			: { source: "resume-config-decoy", marker: "must-not-run" },
		resumeCommand: (id) => `bun run worker --resume --run-id ${id}`,
		runDirRoot,
		phases: {
			start: async (state, io) => {
				if (phaseSignalFile === undefined) {
					throw new Error("Missing --phase-signal-file for start phase");
				}
				signalAndBlock(phaseSignalFile, {
					type: "PHASE_ENTERED",
					phase: "start",
					runId: io.runId,
					runDir: io.runDir,
					state,
				});
			},
			decoy: async (state, io) => {
				if (phaseSignalFile === undefined) {
					throw new Error("Missing --phase-signal-file for decoy phase");
				}
				signalAndBlock(phaseSignalFile, {
					type: "PHASE_ENTERED",
					phase: "decoy",
					runId: io.runId,
					runDir: io.runDir,
					state,
				});
			},
		},
	};

	if (workerMode === "resume") {
		await runOrchestrator(config);
		return;
	}
	if (!initialMode) {
		throw new Error(`Unknown --worker-mode: ${workerMode}`);
	}

	const signalFile = requiredArg(args, "signal-file");
	const faultPoint = requiredArg(args, "fault-point") as WorkerFaultPoint;
	const observedPoints: WorkerFaultPoint[] = [];

	function reach(point: WorkerFaultPoint): void {
		observedPoints.push(point);
		if (point === faultPoint) {
			signalAndBlock(signalFile, {
				type: "FAULT_POINT_REACHED",
				point,
				observedPoints,
			});
		}
	}

	const dependencies: RunOrchestratorInternalDependencies = {
		hooks: {
			afterBootstrapResult: () => reach("AFTER_BOOTSTRAP_RESULT"),
			beforeInitialProjection: () => reach("BEFORE_INITIAL_PROJECTION"),
			afterInitialProjection: () => reach("AFTER_INITIAL_PROJECTION"),
		},
		projectionDependencies: {
			onFaultPoint: reach,
		},
	};

	await runOrchestratorInternal(
		config,
		{ resume: false, runId, rest: [] },
		dependencies,
	);
	throw new Error(`Fault point was not reached: ${faultPoint}`);
}

main().catch((error: unknown) => {
	process.stderr.write(
		`orchestrator crash worker failed: ${error instanceof Error ? error.message : String(error)}\n`,
	);
	process.exit(1);
});
