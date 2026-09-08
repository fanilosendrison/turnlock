import * as fs from "node:fs";
import * as path from "node:path";
import {
	PENDING_INITIAL_DISPATCH_STATE_FIELD,
	PENDING_INITIAL_DISPATCH_VERSION,
	PENDING_INITIAL_DISPATCH_VERSION_STATE_FIELD,
	RUN_DB_FILENAME,
	STATE_SCHEMA_VERSION,
} from "../constants.js";
import {
	InvalidConfigError,
	ProtocolError,
	RunLockedError,
} from "../errors/concrete.js";
import { nodeSqliteDriver } from "../persistence/sqlite/node-sqlite-driver.js";
import {
	type LockHandle,
	releaseOwnership,
} from "../persistence/sqlite/ownership.js";
import {
	bootstrapNewRunAtomic,
	type CommittedState,
} from "../persistence/sqlite/run-bootstrap.js";
import { openRunDatabase } from "../persistence/sqlite/run-database.js";
import { projectAuthoritativeStateFenced } from "../persistence/sqlite/run-state-store.js";
import { clock } from "../services/clock.js";
import { ensureDirectoryPathWithoutSymlinks } from "../services/durable-fs.js";
import { createLogger } from "../services/logger.js";
import { cleanupOldRuns, resolveRunDir } from "../services/run-dir.js";
import { generateRunId } from "../services/run-id.js";
import {
	acquireRunNamespaceMutex,
	NAMESPACE_MUTEX_BUSY_TIMEOUT_MS,
	resolveNamespaceMutexPath,
} from "../services/run-namespace-mutex.js";
import { buildRunRetirement } from "../services/run-retirement.js";
import type { StateFile } from "../services/state-io.js";
import { summarizeZodError, validateResult } from "../services/validator.js";
import type { OrchestratorConfig } from "../types/config.js";
import type { DispatchContext } from "./context.js";
import { doExit } from "./context.js";
import { runDispatchLoop } from "./dispatch-loop.js";
import { emitRunLockedError } from "./error-emitter.js";
import { assertOwnershipStorageCompatibility } from "./ownership-storage-compatibility.js";
import { type ParsedArgv, validateExternalRunId } from "./preflight.js";
import type { RunOrchestratorInternalDependencies } from "./run-orchestrator-contracts.js";
import { installSignalHandlers } from "./signal-handlers.js";
import { claimInitialDispatchWithProjection } from "./state-commit.js";

export async function runInitialMode<S extends object>(
	config: OrchestratorConfig<S>,
	argv: ParsedArgv,
	dependencies: RunOrchestratorInternalDependencies,
): Promise<void> {
	const runId = argv.runId ?? generateRunId();
	if (argv.runId !== undefined) {
		validateExternalRunId(runId, config.name);
	}
	const cwd = process.cwd();
	const runDir = resolveRunDir(cwd, config.name, runId, config.runDirRoot);
	const logger = createLogger(config.logging);
	const nowEpoch = clock.nowEpochMs();
	const nowIso = clock.nowWallIso();
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
	const namespaceMutexResult = acquireRunNamespaceMutex({
		driver: nodeSqliteDriver,
		mutexPath: resolveNamespaceMutexPath(path.dirname(runDir), runId),
		busyTimeoutMs: NAMESPACE_MUTEX_BUSY_TIMEOUT_MS,
	});
	if (namespaceMutexResult.kind !== "ACQUIRED") {
		throw new ProtocolError(
			`namespace mutex unavailable for runId ${runId}: ${namespaceMutexResult.kind}`,
			{ runId, orchestratorName: config.name },
		);
	}
	const namespaceMutex = namespaceMutexResult.handle;
	let runDb: ReturnType<typeof openRunDatabase> | null = null;
	let bootstrappedHandle: LockHandle | null = null;
	let bootstrappedCommitted: CommittedState | null = null;
	try {
		createCanonicalRunDirectories(runDir);
		const databasePath = path.join(runDir, RUN_DB_FILENAME);
		const databaseExistsBeforeOpen = fs.existsSync(databasePath);
		assertOwnershipStorageCompatibility({
			runDir,
			sqliteDatabaseExists: databaseExistsBeforeOpen,
			mode: "initial",
			runId,
			orchestratorName: config.name,
		});
		runDb = openRunDatabase({
			driver: nodeSqliteDriver,
			dbPath: databasePath,
			busyTimeoutMs: 2000,
		});
		const initialRecord: Record<string, unknown> = {
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
			[PENDING_INITIAL_DISPATCH_STATE_FIELD]: true,
			[PENDING_INITIAL_DISPATCH_VERSION_STATE_FIELD]:
				PENDING_INITIAL_DISPATCH_VERSION,
		};
		dependencies.hooks?.beforeRunBootstrapCommit?.();
		const bootstrapResult = bootstrapNewRunAtomic({
			db: runDb.connection,
			runId,
			orchestratorName: config.name,
			nowEpochMs: nowEpoch,
			nowIso,
			leaseDurationMs: 30 * 60 * 1000,
			initialState: initialRecord,
			stateSchemaVersion: STATE_SCHEMA_VERSION,
			contentionDeadlineMs: 5000,
		});
		if (bootstrapResult.kind !== "BOOTSTRAPPED") {
			runDb.close();
			runDb = null;
			if (bootstrapResult.kind === "ACTIVE_CONFLICT") {
				emitRunLockedError(
					new RunLockedError(
						`Run is locked by another process, lease until ${new Date(bootstrapResult.leaseUntilEpochMs).toISOString()}`,
						{
							ownerPid: 0,
							acquiredAtEpochMs: nowEpoch,
							leaseUntilEpochMs: bootstrapResult.leaseUntilEpochMs,
							runId,
						},
					),
					config,
					runId,
					logger,
				);
				doExit(2);
			}
			if (bootstrapResult.kind === "ALREADY_ESTABLISHED") {
				throw new ProtocolError("Run already established", {
					runId,
					orchestratorName: config.name,
				});
			}
			if (bootstrapResult.kind === "RUN_RETIRING") {
				throw new ProtocolError(
					"Run is retired by retention cleanup — no new ownership may be acquired",
					{ runId, orchestratorName: config.name },
				);
			}
			throw new ProtocolError(
				`Failed to bootstrap run: ${bootstrapResult.kind}`,
				{ runId, orchestratorName: config.name },
			);
		}
		bootstrappedHandle = bootstrapResult.handle;
		bootstrappedCommitted = bootstrapResult.committed;
	} catch (error) {
		namespaceMutex.rollbackAndRelease();
		throw error;
	}
	// Bootstrap established ownership and canonical directories. Release the
	// namespace mutex before projection, dispatch setup, and cleanup.
	namespaceMutex.release();
	if (
		runDb === null ||
		bootstrappedHandle === null ||
		bootstrappedCommitted === null
	) {
		throw new ProtocolError(
			"internal error: bootstrap artifacts missing after bootstrap",
			{ runId, orchestratorName: config.name },
		);
	}
	const handle = bootstrappedHandle;
	const committed = bootstrappedCommitted;
	const initialFile = buildInitialStateFile(
		committed,
		config,
		runId,
		nowIso,
		nowEpoch,
	);
	const initialPhase = initialFile.currentPhase;
	const ctx: DispatchContext<S> = {
		config,
		runId,
		runDir,
		runDb,
		handle,
		logger,
		abortController: new AbortController(),
		currentPhase: initialPhase,
		phasesExecuted: initialFile.phasesExecuted,
		accumulatedDurationMs: initialFile.accumulatedDurationMs,
		stateRevision: committed.stateRevision,
	};
	try {
		dependencies.hooks?.afterBootstrapResult?.();
		dependencies.hooks?.beforeInitialProjection?.();
		projectAuthoritativeStateFenced(
			runDb.connection,
			handle,
			runDir,
			committed.stateRevision,
			committed.stateDigest,
			undefined,
			dependencies.projectionDependencies,
		);
		dependencies.hooks?.afterInitialProjection?.();
		logger.enableDiskEmit(path.join(runDir, "events.ndjson"));
		logger.emit({
			eventType: "orchestrator_start",
			runId,
			orchestratorName: config.name,
			initialPhase,
			timestamp: nowIso,
		});
		installSignalHandlers(ctx);
		try {
			cleanupOldRuns(
				cwd,
				config.name,
				config.retentionDays ?? 7,
				runId,
				buildRunRetirement(nodeSqliteDriver),
				config.runDirRoot,
			);
		} catch {
			// Retention cleanup is best-effort.
		}
		dependencies.hooks?.beforeInitialDispatchClaim?.();
		claimInitialDispatchWithProjection(ctx);
		dependencies.hooks?.afterInitialDispatchClaim?.();
	} catch (setupError) {
		const releaseResult = releaseOwnership({ db: runDb.connection, handle });
		runDb.close();
		if (
			releaseResult.kind !== "SUCCESS" &&
			releaseResult.kind !== "STALE_HANDLE"
		) {
			throw new ProtocolError(
				"Initial setup or dispatch claim failed and ownership release also failed",
				{
					runId,
					orchestratorName: config.name,
					cause: new AggregateError(
						[
							setupError,
							releaseResult.kind === "DB_FAILURE"
								? releaseResult.cause
								: new Error(releaseResult.kind),
						],
						"initial setup and release both failed",
					),
				},
			);
		}
		throw setupError;
	}
	await runDispatchLoop(ctx, initialFile);
}

function createCanonicalRunDirectories(runDir: string): void {
	ensureDirectoryPathWithoutSymlinks(runDir, path.dirname(runDir));
	for (const relativePath of [
		"delegations",
		"results",
		"external-requests",
		"external-results",
		"accepted-external-resolutions",
		path.join("artifacts", "sha256"),
	]) {
		ensureDirectoryPathWithoutSymlinks(path.join(runDir, relativePath), runDir);
	}
}

function buildInitialStateFile<S extends object>(
	committed: CommittedState,
	config: OrchestratorConfig<S>,
	runId: string,
	nowIso: string,
	nowEpoch: number,
): StateFile<S> {
	const state = committed.state as Record<string, unknown>;
	return {
		schemaVersion:
			(state.schemaVersion as typeof STATE_SCHEMA_VERSION) ??
			STATE_SCHEMA_VERSION,
		runId: (state.runId as string) ?? runId,
		orchestratorName: (state.orchestratorName as string) ?? config.name,
		startedAt: (state.startedAt as string) ?? nowIso,
		startedAtEpochMs: (state.startedAtEpochMs as number) ?? nowEpoch,
		lastTransitionAt: (state.lastTransitionAt as string) ?? nowIso,
		lastTransitionAtEpochMs:
			(state.lastTransitionAtEpochMs as number) ?? nowEpoch,
		currentPhase: (state.currentPhase as string) ?? config.initial,
		phasesExecuted: (state.phasesExecuted as number) ?? 0,
		accumulatedDurationMs: (state.accumulatedDurationMs as number) ?? 0,
		data: (state.data as S) ?? config.initialState,
		usedLabels: (state.usedLabels as readonly string[]) ?? [],
	};
}
