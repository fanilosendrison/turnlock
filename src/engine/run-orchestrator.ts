import * as fs from "node:fs";
import * as path from "node:path";
import { OrchestratorError } from "../errors/base";
import {
	AbortedError,
	InvalidConfigError,
	ProtocolError,
	RunLockedError,
	StateMissingError,
} from "../errors/concrete";
import { clock } from "../services/clock";
import { acquireLock, type LockHandle, releaseLock } from "../services/lock";
import { createLogger, type InternalLogger } from "../services/logger";
import { writeProtocolBlock } from "../services/protocol";
import { cleanupOldRuns, resolveRunDir } from "../services/run-dir";
import { generateRunId } from "../services/run-id";
import {
	readState,
	type StateFile,
	writeStateAtomic,
} from "../services/state-io";
import { summarizeZodError, validateResult } from "../services/validator";
import type { OrchestratorConfig } from "../types/config";
import { type DispatchContext, doExit, isTestExitSignal } from "./context";
import { runDispatchLoop } from "./dispatch-loop";
import { runHandleResume } from "./handle-resume";

interface ParsedArgv {
	readonly resume: boolean;
	readonly runId?: string;
	readonly rest: readonly string[];
}

function parseArgv(args: readonly string[]): ParsedArgv {
	let resume = false;
	let runId: string | undefined;
	const rest: string[] = [];
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--resume") {
			resume = true;
			continue;
		}
		if (args[i] === "--run-id") {
			runId = args[i + 1];
			i++;
			continue;
		}
		const arg = args[i];
		if (arg !== undefined) rest.push(arg);
	}
	if (runId !== undefined) {
		return { resume, runId, rest };
	}
	return { resume, rest };
}

function validateConfig<S extends object>(config: OrchestratorConfig<S>): void {
	const nameRegex = /^[a-z][a-z0-9-]*$/;
	if (config === null || typeof config !== "object") {
		throw new InvalidConfigError("config must be an object");
	}
	if (typeof config.name !== "string" || !nameRegex.test(config.name)) {
		throw new InvalidConfigError(
			`config.name invalid (kebab-case required): ${String(config.name)}`,
		);
	}
	if (typeof config.phases !== "object" || config.phases === null) {
		throw new InvalidConfigError("config.phases must be an object");
	}
	const phaseKeys = Object.keys(config.phases);
	if (phaseKeys.length === 0) {
		throw new InvalidConfigError("config.phases cannot be empty");
	}
	for (const key of phaseKeys) {
		if (!nameRegex.test(key)) {
			throw new InvalidConfigError(
				`phase name invalid (kebab-case required): ${key}`,
			);
		}
	}
	if (
		typeof config.initial !== "string" ||
		!(config.initial in config.phases)
	) {
		throw new InvalidConfigError(
			`config.initial "${config.initial}" not in phases`,
		);
	}
	if (config.initialState === undefined) {
		throw new InvalidConfigError("config.initialState is required");
	}
	if (typeof config.resumeCommand !== "function") {
		throw new InvalidConfigError(
			"config.resumeCommand is required (must be a function)",
		);
	}
}

function emitRunLockedError<S extends object>(
	err: RunLockedError,
	config: OrchestratorConfig<S>,
	runId: string,
	logger: InternalLogger,
): void {
	logger.emit({
		eventType: "phase_error",
		runId,
		phase: "preflight",
		errorKind: "run_locked",
		message: err.message.slice(0, 200),
		timestamp: clock.nowWallIso(),
	});
	const block = writeProtocolBlock("ERROR", {
		runId,
		orchestrator: config.name,
		errorKind: "run_locked",
		message: err.message.slice(0, 200),
		phase: null,
		phasesExecuted: 0,
	});
	process.stdout.write(block);
}

function installSignalHandlers<S extends object>(
	ctx: DispatchContext<S>,
): void {
	const makeHandler = (signal: "SIGINT" | "SIGTERM") => () => {
		const code = signal === "SIGINT" ? 130 : 143;
		try {
			ctx.abortController.abort(new AbortedError(`Received ${signal}`));
		} catch {
			// silent
		}
		try {
			ctx.logger.emit({
				eventType: "phase_error",
				runId: ctx.runId,
				phase: ctx.currentPhase ?? "unknown",
				errorKind: "aborted",
				message: `Received ${signal}`,
				timestamp: clock.nowWallIso(),
			});
			ctx.logger.emit({
				eventType: "orchestrator_end",
				runId: ctx.runId,
				orchestratorName: ctx.config.name,
				success: false,
				durationMs: ctx.accumulatedDurationMs,
				phasesExecuted: ctx.phasesExecuted,
				timestamp: clock.nowWallIso(),
			});
		} catch {
			// silent
		}
		try {
			const block = writeProtocolBlock("ABORTED", {
				runId: ctx.runId,
				orchestrator: ctx.config.name,
				signal,
				phase: ctx.currentPhase ?? null,
			});
			process.stdout.write(block);
		} catch {
			// silent
		}
		try {
			releaseLock(ctx.lockPath, ctx.handle, clock, ctx.logger, ctx.runId);
		} catch {
			// silent
		}
		doExit(code);
	};

	process.on("SIGINT", makeHandler("SIGINT"));
	process.on("SIGTERM", makeHandler("SIGTERM"));
}

async function runInitialMode<S extends object>(
	config: OrchestratorConfig<S>,
	argv: ParsedArgv,
): Promise<void> {
	const runId = argv.runId ?? generateRunId();
	const cwd = process.cwd();
	const runDir = resolveRunDir(cwd, config.name, runId);

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
		schemaVersion: 1,
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
		cleanupOldRuns(cwd, config.name, config.retentionDays ?? 7, runId);
	} catch {
		// best-effort
	}

	await runDispatchLoop(ctx, initialState, undefined);
}

async function runResumeMode<S extends object>(
	config: OrchestratorConfig<S>,
	argv: ParsedArgv,
): Promise<void> {
	if (!argv.runId) {
		throw new InvalidConfigError("--resume requires --run-id");
	}
	const runId = argv.runId;
	const cwd = process.cwd();
	const runDir = resolveRunDir(cwd, config.name, runId);
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

function handleTopLevelError<S extends object>(
	err: unknown,
	config: OrchestratorConfig<S> | undefined,
): never {
	const orchestratorName =
		config && typeof config.name === "string" ? config.name : "unknown";

	if (err instanceof InvalidConfigError) {
		const block = writeProtocolBlock("ERROR", {
			runId: err.runId ?? null,
			orchestrator: err.orchestratorName ?? orchestratorName,
			errorKind: "invalid_config",
			message: err.message.slice(0, 200),
			phase: null,
			phasesExecuted: 0,
		});
		process.stdout.write(block);
		doExit(1);
	}

	if (err instanceof OrchestratorError) {
		const block = writeProtocolBlock("ERROR", {
			runId: err.runId ?? null,
			orchestrator: err.orchestratorName ?? orchestratorName,
			errorKind: err.kind,
			message: err.message.slice(0, 200),
			phase: err.phase ?? null,
			phasesExecuted: 0,
		});
		process.stdout.write(block);
		doExit(1);
	}

	const msg = err instanceof Error ? err.message : String(err);
	const block = writeProtocolBlock("ERROR", {
		runId: null,
		orchestrator: orchestratorName,
		errorKind: "phase_error",
		message: msg.slice(0, 200),
		phase: null,
		phasesExecuted: 0,
	});
	process.stdout.write(block);
	doExit(1);
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
