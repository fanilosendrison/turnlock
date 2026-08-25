import * as fs from "node:fs";
import * as path from "node:path";
import { STATE_SCHEMA_VERSION } from "../constants.ts";
import {
	InvalidConfigError,
	ProtocolError,
	RunLockedError,
	StateMissingError,
} from "../errors/concrete.ts";
import { clock } from "../services/clock.ts";
import { acquireLock, type LockHandle } from "../services/lock.ts";
import { createLogger } from "../services/logger.ts";
import { cleanupOldRuns, resolveRunDir } from "../services/run-dir.ts";
import { generateRunId } from "../services/run-id.ts";
import {
	readState,
	type StateFile,
	writeStateAtomic,
} from "../services/state-io.ts";
import { summarizeZodError, validateResult } from "../services/validator.ts";
import type { OrchestratorConfig } from "../types/config.ts";
import { type DispatchContext, doExit, isTestExitSignal } from "./context.ts";
import { runDispatchLoop } from "./dispatch-loop.ts";
import { emitRunLockedError, handleTopLevelError } from "./error-emitter.ts";
import { runHandleResume } from "./handle-resume.ts";
import {
	type ParsedArgv,
	parseArgv,
	validateConfig,
	validateExternalRunId,
} from "./preflight.ts";
import { installSignalHandlers } from "./signal-handlers.ts";

async function runInitialMode<S extends object>(
	config: OrchestratorConfig<S>,
	argv: ParsedArgv,
): Promise<void> {
	const runId = argv.runId ?? generateRunId();
	if (argv.runId !== undefined) {
		validateExternalRunId(runId, config.name);
	}
	const cwd = process.cwd();
	const runDir = resolveRunDir(cwd, config.name, runId, config.runDirRoot);

	fs.mkdirSync(runDir, { recursive: true });
	fs.mkdirSync(path.join(runDir, "delegations"), { recursive: true });
	fs.mkdirSync(path.join(runDir, "results"), { recursive: true });

	const logger = createLogger(config.logging);
	const lockPath = path.join(runDir, ".lock");
	let handle: LockHandle;
	try {
		handle = acquireLock(lockPath, clock, logger, runId);
	} catch (err) {
		if (err instanceof RunLockedError) {
			emitRunLockedError(err, config, runId, logger);
			doExit(2);
		}
		throw err;
	}

	logger.enableDiskEmit(path.join(runDir, "events.ndjson"));

	const nowEpoch = clock.nowEpochMs();
	const nowIso = clock.nowWallIso();

	logger.emit({
		eventType: "orchestrator_start",
		runId,
		orchestratorName: config.name,
		initialPhase: config.initial,
		timestamp: nowIso,
	});

	if (config.stateSchema) {
		const validation = validateResult(config.initialState, config.stateSchema);
		if (!validation.ok) {
			throw new InvalidConfigError(
				`config.initialState fails stateSchema: ${summarizeZodError(validation.error)}`,
				{
					cause: validation.error,
					runId,
					orchestratorName: config.name,
				},
			);
		}
	}

	const initialState: StateFile<S> = {
		schemaVersion: STATE_SCHEMA_VERSION,
		runId,
		orchestratorName: config.name,
		startedAt: nowIso,
		startedAtEpochMs: nowEpoch,
		lastTransitionAt: nowIso,
		lastTransitionAtEpochMs: nowEpoch,
		currentPhase: config.initial,
		phasesExecuted: 0,
		accumulatedDurationMs: 0,
		data: config.initialState,
		usedLabels: [],
	};
	writeStateAtomic(runDir, initialState, config.stateSchema);

	const abortController = new AbortController();
	const ctx: DispatchContext<S> = {
		config,
		runId,
		runDir,
		lockPath,
		handle,
		logger,
		abortController,
		currentPhase: config.initial,
		phasesExecuted: 0,
		accumulatedDurationMs: 0,
	};

	installSignalHandlers(ctx);
	try {
		cleanupOldRuns(
			cwd,
			config.name,
			config.retentionDays ?? 7,
			runId,
			config.runDirRoot,
		);
	} catch {
		// best-effort
	}

	await runDispatchLoop(ctx, initialState);
}

async function runResumeMode<S extends object>(
	config: OrchestratorConfig<S>,
	argv: ParsedArgv,
): Promise<void> {
	if (!argv.runId) {
		throw new InvalidConfigError("--resume requires --run-id");
	}
	const runId = argv.runId;
	validateExternalRunId(runId, config.name);
	const cwd = process.cwd();
	const runDir = resolveRunDir(cwd, config.name, runId, config.runDirRoot);
	if (!fs.existsSync(runDir)) {
		throw new StateMissingError(`RUN_DIR does not exist: ${runDir}`, {
			runId,
			orchestratorName: config.name,
		});
	}

	const state = readState<S>(runDir, config.stateSchema);
	if (state === null) {
		throw new StateMissingError("state.json missing at RUN_DIR", {
			runId,
			orchestratorName: config.name,
		});
	}

	if (state.runId !== runId) {
		throw new ProtocolError(
			`RUN_DIR mismatch with argv — state.runId=${state.runId}, argv.runId=${runId}`,
			{ runId, orchestratorName: config.name },
		);
	}
	if (state.orchestratorName !== config.name) {
		throw new ProtocolError(
			`orchestrator name mismatch — state.orchestratorName=${state.orchestratorName}, config.name=${config.name}`,
			{ runId, orchestratorName: config.name },
		);
	}

	const logger = createLogger(config.logging);
	const lockPath = path.join(runDir, ".lock");
	let handle: LockHandle;
	try {
		handle = acquireLock(lockPath, clock, logger, runId);
	} catch (err) {
		if (err instanceof RunLockedError) {
			emitRunLockedError(err, config, runId, logger);
			doExit(2);
		}
		throw err;
	}

	logger.enableDiskEmit(path.join(runDir, "events.ndjson"));

	const abortController = new AbortController();
	const ctx: DispatchContext<S> = {
		config,
		runId,
		runDir,
		lockPath,
		handle,
		logger,
		abortController,
		currentPhase: state.currentPhase,
		phasesExecuted: state.phasesExecuted,
		accumulatedDurationMs: state.accumulatedDurationMs,
	};

	installSignalHandlers(ctx);

	await runHandleResume(ctx, state);
}

export async function runOrchestrator<S extends object>(
	config: OrchestratorConfig<S>,
): Promise<void> {
	try {
		validateConfig(config);
		const argv = parseArgv(process.argv.slice(2));
		if (argv.resume) {
			await runResumeMode(config, argv);
		} else {
			await runInitialMode(config, argv);
		}
	} catch (err) {
		if (isTestExitSignal(err)) return;
		try {
			handleTopLevelError(err, config);
		} catch (e) {
			if (isTestExitSignal(e)) return;
			// Don't rethrow — fail-closed discipline (I-4).
		}
	}
}
