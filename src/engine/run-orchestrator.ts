import * as fs from "node:fs";
import * as path from "node:path";
import { STATE_SCHEMA_VERSION } from "../constants";
import {
	InvalidConfigError,
	ProtocolError,
	RunLockedError,
	StateMissingError,
} from "../errors/concrete";
import { clock } from "../services/clock";
import { acquireLock, type LockHandle, releaseLock } from "../services/lock";
import { createLogger } from "../services/logger";
import { cleanupOldRuns, resolveRunDir } from "../services/run-dir";
import { generateRunId } from "../services/run-id";
import {
	readStateSnapshot,
	type StateFile,
	writeStateAtomic,
} from "../services/state-io";
import { summarizeZodError, validateResult } from "../services/validator";
import type { OrchestratorConfig } from "../types/config";
import { type DispatchContext, doExit, isTestExitSignal } from "./context";
import { runDispatchLoop } from "./dispatch-loop";
import { emitRunLockedError, handleTopLevelError } from "./error-emitter";
import { runHandleResume } from "./handle-resume";
import {
	type ParsedArgv,
	parseArgv,
	validateConfig,
	validateExternalRunId,
} from "./preflight";
import { installSignalHandlers } from "./signal-handlers";

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
	fs.mkdirSync(path.join(runDir, "external-requests"), { recursive: true });
	fs.mkdirSync(path.join(runDir, "external-results"), { recursive: true });

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

	let state: StateFile<S>;
	try {
		const snapshot = readStateSnapshot<S>(runDir, config.stateSchema);
		if (snapshot.state === null) {
			throw new StateMissingError("state.json missing at RUN_DIR", {
				runId,
				orchestratorName: config.name,
			});
		}
		state = snapshot.state;
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
		fs.mkdirSync(path.join(runDir, "external-requests"), { recursive: true });
		fs.mkdirSync(path.join(runDir, "external-results"), { recursive: true });
		if (snapshot.migratedFromVersion !== null) {
			writeStateAtomic(runDir, state, config.stateSchema);
		}
	} catch (error) {
		releaseLock(lockPath, handle, clock, logger, runId);
		throw error;
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
