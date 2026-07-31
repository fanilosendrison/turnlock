import * as fs from "node:fs";
import * as path from "node:path";
import { STATE_SCHEMA_VERSION } from "../constants";
import {
	InvalidConfigError,
	ProtocolError,
	RunLockedError,
	StateMissingError,
} from "../errors/concrete";
import { bunSqliteDriver } from "../persistence/sqlite/bun-sqlite-driver";
import { acquireOwnership } from "../persistence/sqlite/ownership";
import { openRunDatabase } from "../persistence/sqlite/run-database";
import {
	ensureInitialStateRow,
	projectStateJson,
	readAuthoritativeState,
	type StateRecord,
} from "../persistence/sqlite/run-state-store";
import { clock } from "../services/clock";
import { createLogger } from "../services/logger";
import { cleanupOldRuns, resolveRunDir } from "../services/run-dir";
import { generateRunId } from "../services/run-id";
import { readStateSnapshot, type StateFile } from "../services/state-io";
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

const DB_FILENAME = "turnlock.sqlite3";

function migrateLegacyStateToSqlite<S extends object>(
	runDir: string,
	runId: string,
	state: StateFile<S>,
): void {
	const dbPath = path.join(runDir, DB_FILENAME);
	const runDb = openRunDatabase({
		driver: bunSqliteDriver,
		dbPath,
		busyTimeoutMs: 2000,
	});

	try {
		// Acquire ownership to seed the initial state row.
		const acquireResult = acquireOwnership({
			db: runDb.connection,
			runId,
			orchestratorName: state.orchestratorName,
			nowEpochMs: state.lastTransitionAtEpochMs,
			nowIso: state.lastTransitionAt,
			leaseDurationMs: 30 * 60 * 1000,
			contentionDeadlineMs: 5000,
		});

		if (acquireResult.kind !== "ACQUIRED") {
			throw new StateMissingError(
				`Failed to acquire ownership during legacy migration: ${acquireResult.kind}`,
				{ runId, orchestratorName: state.orchestratorName },
			);
		}

		ensureInitialStateRow(
			runDb.connection,
			acquireResult.handle.incarnationId,
			state.schemaVersion,
			JSON.stringify(state),
			state.lastTransitionAtEpochMs,
			state.lastTransitionAt,
		);

		// Project state.json for readers that haven't switched to SQLite.
		projectStateJson(runDir, state as unknown as StateRecord<S>, "");
	} finally {
		runDb.close();
	}
}

function stateRecordToStateFile<S extends object>(
	record: StateRecord<S>,
): StateFile<S> {
	const base = {
		schemaVersion: record.schemaVersion as typeof STATE_SCHEMA_VERSION,
		runId: record.runId,
		orchestratorName: record.orchestratorName,
		startedAt: record.startedAt,
		startedAtEpochMs: record.startedAtEpochMs,
		lastTransitionAt: record.lastTransitionAt,
		lastTransitionAtEpochMs: record.lastTransitionAtEpochMs,
		currentPhase: record.currentPhase,
		phasesExecuted: record.phasesExecuted,
		accumulatedDurationMs: record.accumulatedDurationMs,
		data: record.data,
		usedLabels: record.usedLabels,
	};
	const result = { ...base } as StateFile<S>;
	if (record.pendingDelegation !== undefined) {
		(result as unknown as Record<string, unknown>).pendingDelegation =
			record.pendingDelegation;
	}
	if (record.pendingExternalRequest !== undefined) {
		(result as unknown as Record<string, unknown>).pendingExternalRequest =
			record.pendingExternalRequest;
	}
	return result;
}

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
	fs.mkdirSync(path.join(runDir, "accepted-external-resolutions"), {
		recursive: true,
	});

	const logger = createLogger(config.logging);

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

	const nowEpoch = clock.nowEpochMs();
	const nowIso = clock.nowWallIso();

	// Open SQLite database and acquire ownership transactionally.
	const dbPath = path.join(runDir, DB_FILENAME);
	const runDb = openRunDatabase({
		driver: bunSqliteDriver,
		dbPath,
		busyTimeoutMs: 2000,
	});

	let acquireResult: ReturnType<typeof acquireOwnership>;
	try {
		acquireResult = acquireOwnership({
			db: runDb.connection,
			runId,
			orchestratorName: config.name,
			nowEpochMs: nowEpoch,
			nowIso,
			leaseDurationMs: 30 * 60 * 1000,
			contentionDeadlineMs: 5000,
		});
	} catch (err) {
		runDb.close();
		throw err;
	}

	if (acquireResult.kind === "ACTIVE_CONFLICT") {
		runDb.close();
		emitRunLockedError(
			new RunLockedError(
				`Run is locked by PID ${acquireResult.ownerPid}, lease until ${new Date(acquireResult.leaseUntilEpochMs).toISOString()}`,
				{
					ownerPid: acquireResult.ownerPid,
					acquiredAtEpochMs: nowEpoch,
					leaseUntilEpochMs: acquireResult.leaseUntilEpochMs,
					runId,
				},
			),
			config,
			runId,
			logger,
		);
		doExit(2);
	}

	if (acquireResult.kind !== "ACQUIRED") {
		runDb.close();
		throw new ProtocolError(
			`Failed to acquire ownership: ${acquireResult.kind}`,
			{ runId, orchestratorName: config.name },
		);
	}

	const handle = acquireResult.handle;
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

	// Write initial state row in SQLite and project state.json.
	ensureInitialStateRow(
		runDb.connection,
		handle.incarnationId,
		STATE_SCHEMA_VERSION,
		JSON.stringify(initialState),
		nowEpoch,
		nowIso,
	);
	projectStateJson(runDir, initialState as unknown as StateRecord<S>, "");

	logger.enableDiskEmit(path.join(runDir, "events.ndjson"));

	logger.emit({
		eventType: "orchestrator_start",
		runId,
		orchestratorName: config.name,
		initialPhase: config.initial,
		timestamp: nowIso,
	});

	const abortController = new AbortController();
	const ctx: DispatchContext<S> = {
		config,
		runId,
		runDir,
		runDb,
		handle,
		logger,
		abortController,
		currentPhase: config.initial,
		phasesExecuted: 0,
		accumulatedDurationMs: 0,
		stateRevision: "0",
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
	const dbPath = path.join(runDir, DB_FILENAME);
	const dbExists = fs.existsSync(dbPath);

	if (!dbExists) {
		// Legacy migration path: state.json exists but no SQLite DB.
		const snapshot = readStateSnapshot<S>(runDir, config.stateSchema);
		if (snapshot.state === null) {
			throw new StateMissingError("state.json missing at RUN_DIR", {
				runId,
				orchestratorName: config.name,
			});
		}
		migrateLegacyStateToSqlite(runDir, runId, snapshot.state);
	}

	const runDb = openRunDatabase({
		driver: bunSqliteDriver,
		dbPath,
		busyTimeoutMs: 2000,
	});

	// Acquire ownership via SQLite.
	const nowEpoch = clock.nowEpochMs();
	const nowIso = clock.nowWallIso();

	const acquireResult = acquireOwnership({
		db: runDb.connection,
		runId,
		orchestratorName: config.name,
		nowEpochMs: nowEpoch,
		nowIso,
		leaseDurationMs: 30 * 60 * 1000,
		contentionDeadlineMs: 5000,
	});

	if (acquireResult.kind === "ACTIVE_CONFLICT") {
		runDb.close();
		emitRunLockedError(
			new RunLockedError(
				`Run is locked by PID ${acquireResult.ownerPid}, lease until ${new Date(acquireResult.leaseUntilEpochMs).toISOString()}`,
				{
					ownerPid: acquireResult.ownerPid,
					acquiredAtEpochMs: nowEpoch,
					leaseUntilEpochMs: acquireResult.leaseUntilEpochMs,
					runId,
				},
			),
			config,
			runId,
			logger,
		);
		doExit(2);
	}

	if (acquireResult.kind !== "ACQUIRED") {
		runDb.close();
		throw new ProtocolError(
			`Failed to acquire ownership: ${acquireResult.kind}`,
			{ runId, orchestratorName: config.name },
		);
	}

	const handle = acquireResult.handle;

	// Read authoritative state from SQLite.
	const readResult = readAuthoritativeState<S>(runDb.connection);
	if (readResult.state === null) {
		runDb.close();
		throw new StateMissingError("state missing in SQLite", {
			runId,
			orchestratorName: config.name,
		});
	}

	const state = stateRecordToStateFile(readResult.state);

	// Always project state.json after resume so direct readers see current state.
	projectStateJson(runDir, readResult.state, readResult.digest ?? "");

	if (state.runId !== runId) {
		runDb.close();
		throw new ProtocolError(
			`RUN_DIR mismatch with argv — state.runId=${state.runId}, argv.runId=${runId}`,
			{ runId, orchestratorName: config.name },
		);
	}
	if (state.orchestratorName !== config.name) {
		runDb.close();
		throw new ProtocolError(
			`orchestrator name mismatch — state.orchestratorName=${state.orchestratorName}, config.name=${config.name}`,
			{ runId, orchestratorName: config.name },
		);
	}

	fs.mkdirSync(path.join(runDir, "external-requests"), { recursive: true });
	fs.mkdirSync(path.join(runDir, "external-results"), { recursive: true });
	fs.mkdirSync(path.join(runDir, "accepted-external-resolutions"), {
		recursive: true,
	});

	logger.enableDiskEmit(path.join(runDir, "events.ndjson"));

	const abortController = new AbortController();
	const ctx: DispatchContext<S> = {
		config,
		runId,
		runDir,
		runDb,
		handle,
		logger,
		abortController,
		currentPhase: state.currentPhase,
		phasesExecuted: state.phasesExecuted,
		accumulatedDurationMs: state.accumulatedDurationMs,
		stateRevision: readResult.state.stateRevision,
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
		}
	}
}
