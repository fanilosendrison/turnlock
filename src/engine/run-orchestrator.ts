import * as fs from "node:fs";
import * as path from "node:path";
import {
	PENDING_INITIAL_DISPATCH_STATE_FIELD,
	PENDING_INITIAL_DISPATCH_VERSION,
	PENDING_INITIAL_DISPATCH_VERSION_STATE_FIELD,
	STATE_SCHEMA_VERSION,
} from "../constants";
import {
	InvalidConfigError,
	ProtocolError,
	RunLockedError,
	StateMigrationBlockedError,
	StateMissingError,
} from "../errors/concrete";
import { bunSqliteDriver } from "../persistence/sqlite/bun-sqlite-driver";
import {
	acquireOwnership,
	releaseOwnership,
} from "../persistence/sqlite/ownership";
import {
	bootstrapNewRunAtomic,
	type CommittedState,
	migrateLegacyRunAtomic,
} from "../persistence/sqlite/run-bootstrap";
import { openRunDatabase } from "../persistence/sqlite/run-database";
import {
	type ProjectionInternalDependencies,
	projectAuthoritativeStateFenced,
	readAuthoritativeState,
	type StateRecord,
} from "../persistence/sqlite/run-state-store";
import { clock } from "../services/clock";
import { createLogger } from "../services/logger";
import { cleanupOldRuns, resolveRunDir } from "../services/run-dir";
import { generateRunId } from "../services/run-id";
import {
	migrateV3ToV4,
	readStateSnapshot,
	type StateFile,
} from "../services/state-io";
import { summarizeZodError, validateResult } from "../services/validator";
import type { TerminalDoneRecord } from "../types/artifacts";
import type { OrchestratorConfig } from "../types/config";
import { type DispatchContext, doExit, isTestExitSignal } from "./context";
import { runDispatchLoop } from "./dispatch-loop";
import { emitRunLockedError, handleTopLevelError } from "./error-emitter";
import { runHandleResume } from "./handle-resume";
import { assertOwnershipStorageCompatibility } from "./ownership-storage-compatibility";
import {
	type ParsedArgv,
	parseArgv,
	validateConfig,
	validateExternalRunId,
} from "./preflight";
import { installSignalHandlers } from "./signal-handlers";
import { claimInitialDispatchWithProjection } from "./state-commit";

const DB_FILENAME = "turnlock.sqlite3";

export interface RunOrchestratorInternalHooks {
	afterBootstrapResult?(): void;
	beforeInitialProjection?(): void;
	afterInitialProjection?(): void;
	beforeInitialDispatchClaim?(): void;
	afterInitialDispatchClaim?(): void;
}

export interface RunOrchestratorInternalDependencies {
	readonly hooks?: RunOrchestratorInternalHooks;
	readonly projectionDependencies?: ProjectionInternalDependencies;
}

const productionRunOrchestratorDependencies: RunOrchestratorInternalDependencies =
	{};

/** Migrate a legacy state.json snapshot into an authoritative SQLite run
 *  atomically (single BEGIN IMMEDIATE ... COMMIT).
 *
 *  Preserves legacy startedAt/lastTransitionAt timestamps.
 *  Ownership is established with current wall-clock time.
 *  Returns the open connection + active handle only after COMMIT succeeds.
 *
 *  On any failure the transaction is rolled back — no partial state,
 *  no LockHandle, the state.json legacy file is untouched. */
function seedLegacyStateToSqlite<S extends object>(
	runDir: string,
	runId: string,
	state: StateFile<S>,
): {
	runDb: ReturnType<typeof openRunDatabase>;
	handle: import("../persistence/sqlite/ownership").LockHandle;
	committed: CommittedState;
} {
	const dbPath = path.join(runDir, DB_FILENAME);
	const runDb = openRunDatabase({
		driver: bunSqliteDriver,
		dbPath,
		busyTimeoutMs: 2000,
	});

	try {
		const migrateResult = migrateLegacyRunAtomic({
			db: runDb.connection,
			runId,
			orchestratorName: state.orchestratorName,
			nowEpochMs: clock.nowEpochMs(),
			nowIso: clock.nowWallIso(),
			leaseDurationMs: 30 * 60 * 1000,
			legacyState: state as unknown as Record<string, unknown>,
			legacyStartedAtEpochMs: state.startedAtEpochMs,
			legacyStartedAt: state.startedAt,
			legacyLastTransitionAtEpochMs: state.lastTransitionAtEpochMs,
			legacyLastTransitionAt: state.lastTransitionAt,
			stateSchemaVersion: STATE_SCHEMA_VERSION,
			contentionDeadlineMs: 5000,
		});

		if (migrateResult.kind === "MIGRATED") {
			return {
				runDb,
				handle: migrateResult.handle,
				committed: migrateResult.committed,
			};
		}

		if (migrateResult.kind === "ALREADY_ESTABLISHED") {
			// Another process seeded between our pre-check and this call.
			// We must close this connection — the caller will re-open or
			// re-acquire on the existing DB.  But we need to return the
			// DB and a handle.  Since we can't provide a valid handle,
			// we throw and let the caller recover via re-acquisition.
			runDb.close();
			throw new StateMissingError(
				"Legacy migration: run already established by another process",
				{ runId, orchestratorName: state.orchestratorName },
			);
		}

		if (migrateResult.kind === "ACTIVE_CONFLICT") {
			runDb.close();
			throw new StateMissingError("Legacy migration: active owner conflict", {
				runId,
				orchestratorName: state.orchestratorName,
			});
		}

		if (migrateResult.kind === "INCOMPLETE_EXISTING_BOOTSTRAP") {
			runDb.close();
			throw new StateMissingError(
				`Legacy migration: incomplete existing bootstrap — ${migrateResult.details}`,
				{ runId, orchestratorName: state.orchestratorName },
			);
		}

		if (migrateResult.kind === "DB_FAILURE") {
			runDb.close();
			throw new StateMissingError("Legacy migration: DB failure", {
				runId,
				orchestratorName: state.orchestratorName,
				cause: migrateResult.cause,
			});
		}

		// DB_CONTENTION_TIMEOUT
		runDb.close();
		throw new StateMissingError("Legacy migration: DB contention timeout", {
			runId,
			orchestratorName: state.orchestratorName,
		});
	} catch (err) {
		// On any error, close the DB.  No ownership was established
		// (the transaction was rolled back), so no release needed.
		runDb.close();
		throw err;
	}
}

function stateRecordToStateFile<S extends object>(
	record: StateRecord<S>,
	runDir: string,
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
	if (record.terminalResult !== undefined) {
		(result as unknown as Record<string, unknown>).terminalResult =
			record.terminalResult;
	}

	// v3→v4 migration: if the SQLite state still uses the old manifestPath
	// format, convert to manifestArtifact on the fly.
	if (record.schemaVersion === 3) {
		const migrated = migrateStateFileV3ToV4(
			result as unknown as Record<string, unknown>,
			runDir,
		);
		return migrated as unknown as StateFile<S>;
	}

	return result;
}

/** Inline migration for SQLite-based resume — converts v3 manifestPath to v4
 *  manifestArtifact by reading the legacy manifest file from disk.
 *  This is a defensive fallback; the primary migration happens before
 *  stateRecordToStateFile is called.  Returns the migrated state or
 *  the original if migration is blocked (caller must handle). */
function migrateStateFileV3ToV4(
	parsed: Record<string, unknown>,
	runDir: string,
): Record<string, unknown> {
	try {
		const { migrateV3ToV4 } = require("../services/state-io") as {
			migrateV3ToV4: typeof import("../services/state-io").migrateV3ToV4;
		};
		const result = migrateV3ToV4(parsed, runDir);
		if (result.kind === "MIGRATED") {
			return result.state;
		}
		// Migration blocked — return as-is; the caller already has a v3 state
		// and the primary path would have thrown before reaching here.
		return parsed;
	} catch {
		// Best-effort fallback — return the original parsed state.
		return parsed;
	}
}

async function runInitialMode<S extends object>(
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

	fs.mkdirSync(runDir, { recursive: true });
	fs.mkdirSync(path.join(runDir, "delegations"), { recursive: true });
	fs.mkdirSync(path.join(runDir, "results"), { recursive: true });
	fs.mkdirSync(path.join(runDir, "external-requests"), { recursive: true });
	fs.mkdirSync(path.join(runDir, "external-results"), { recursive: true });
	fs.mkdirSync(path.join(runDir, "accepted-external-resolutions"), {
		recursive: true,
	});
	fs.mkdirSync(path.join(runDir, "artifacts", "sha256"), {
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

	// Guard: refuse to establish SQLite ownership if a legacy .lock exists.
	// A reused runId may point to an existing RUN_DIR containing artifacts
	// from a legacy process.  existsSync is a defensive best-effort check;
	// the exclusive upgrade window is an operational precondition.
	const dbPath = path.join(runDir, DB_FILENAME);
	const dbExistsBeforeOpen = fs.existsSync(dbPath);
	assertOwnershipStorageCompatibility({
		runDir,
		sqliteDatabaseExists: dbExistsBeforeOpen,
		mode: "initial",
		runId,
		orchestratorName: config.name,
	});

	// Open SQLite database and bootstrap atomically.
	// incarnation + ownership + state are established in a single
	// BEGIN IMMEDIATE ... COMMIT.  The LockHandle is only returned
	// after the COMMIT succeeds.
	const runDb = openRunDatabase({
		driver: bunSqliteDriver,
		dbPath,
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
		throw new ProtocolError(
			`Failed to bootstrap run: ${bootstrapResult.kind}`,
			{ runId, orchestratorName: config.name },
		);
	}

	const handle = bootstrapResult.handle;
	const committed = bootstrapResult.committed;

	// Build the dispatch state from the committed authoritative record, never
	// from the pre-lock config values. The private initial-dispatch marker is
	// intentionally omitted from StateFile and remains SQLite-only evidence.
	const committedState = committed.state as Record<string, unknown>;
	const initialFile: StateFile<S> = {
		schemaVersion:
			(committedState.schemaVersion as typeof STATE_SCHEMA_VERSION) ??
			STATE_SCHEMA_VERSION,
		runId: (committedState.runId as string) ?? runId,
		orchestratorName:
			(committedState.orchestratorName as string) ?? config.name,
		startedAt: (committedState.startedAt as string) ?? nowIso,
		startedAtEpochMs: (committedState.startedAtEpochMs as number) ?? nowEpoch,
		lastTransitionAt: (committedState.lastTransitionAt as string) ?? nowIso,
		lastTransitionAtEpochMs:
			(committedState.lastTransitionAtEpochMs as number) ?? nowEpoch,
		currentPhase: (committedState.currentPhase as string) ?? config.initial,
		phasesExecuted: (committedState.phasesExecuted as number) ?? 0,
		accumulatedDurationMs:
			(committedState.accumulatedDurationMs as number) ?? 0,
		data: (committedState.data as S) ?? config.initialState,
		usedLabels: (committedState.usedLabels as readonly string[]) ?? [],
	};
	const initialPhase = initialFile.currentPhase;

	const abortController = new AbortController();
	const ctx: DispatchContext<S> = {
		config,
		runId,
		runDir,
		runDb,
		handle,
		logger,
		abortController,
		currentPhase: initialPhase,
		phasesExecuted: initialFile.phasesExecuted,
		accumulatedDurationMs: initialFile.accumulatedDurationMs,
		stateRevision: committed.stateRevision,
	};

	// Every post-bootstrap boundary, including the durable claim, has one
	// cleanup owner. SIGKILL deliberately bypasses this path so the successor
	// must take over only after the lease expires.
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
				config.runDirRoot,
			);
		} catch {
			// best-effort
		}

		dependencies.hooks?.beforeInitialDispatchClaim?.();
		claimInitialDispatchWithProjection(ctx);
		dependencies.hooks?.afterInitialDispatchClaim?.();
	} catch (setupErr) {
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
							setupErr,
							releaseResult.kind === "DB_FAILURE"
								? releaseResult.cause
								: new Error(releaseResult.kind),
						],
						"initial setup and release both failed",
					),
				},
			);
		}

		throw setupErr;
	}

	await runDispatchLoop(ctx, initialFile);
}

async function runResumeMode<S extends object>(
	config: OrchestratorConfig<S>,
	argv: ParsedArgv,
	dependencies: RunOrchestratorInternalDependencies,
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

	// Centralized ownership-storage compatibility guard.
	// Applied BEFORE any DB creation, ownership acquisition, fence token
	// increment, state projection, or phase execution.
	//
	// existsSync(".lock") is a defensive best-effort check, NOT an atomic
	// inter-version lock.  A legacy process starting concurrently with
	// migration is an operational concern (see docs/sqlite-ownership-migration.md).
	assertOwnershipStorageCompatibility({
		runDir,
		sqliteDatabaseExists: dbExists,
		mode: "resume",
		runId,
		orchestratorName: config.name,
	});

	let runDb: ReturnType<typeof openRunDatabase>;
	let handle: import("../persistence/sqlite/ownership").LockHandle;

	if (!dbExists) {
		// Legacy migration path: state.json exists but no SQLite DB.
		// readStateSnapshot now throws StateMigrationBlockedError with the
		// specific reason when v3→v4 migration cannot complete.
		let snapshot: ReturnType<typeof readStateSnapshot<S>>;
		try {
			snapshot = readStateSnapshot<S>(runDir, config.stateSchema);
		} catch (err) {
			if (err instanceof StateMigrationBlockedError) {
				throw new StateMigrationBlockedError(
					`v3→v4 migration incomplete — cannot create authoritative SQLite DB: ${err.message}`,
					{
						reason: err.reason,
						runId,
						orchestratorName: config.name,
					},
				);
			}
			throw err;
		}
		if (snapshot.state === null) {
			throw new StateMissingError("state.json missing at RUN_DIR", {
				runId,
				orchestratorName: config.name,
			});
		}

		// Validate identity BEFORE creating the DB — a mismatched legacy
		// state.json must not be silently reassigned to a different run.
		if (snapshot.state.runId !== runId) {
			throw new ProtocolError(
				`RUN_DIR mismatch — state.runId=${snapshot.state.runId}, argv.runId=${runId}`,
				{ runId, orchestratorName: config.name },
			);
		}
		if (snapshot.state.orchestratorName !== config.name) {
			throw new ProtocolError(
				`orchestrator name mismatch — state.orchestratorName=${snapshot.state.orchestratorName}, config.name=${config.name}`,
				{ runId, orchestratorName: config.name },
			);
		}

		// snapshot.state.schemaVersion is guaranteed to be STATE_SCHEMA_VERSION
		// because readStateSnapshot now throws on blocked migration.
		//
		// seedLegacyStateToSqlite opens the DB, pre-creates the incarnation
		// with the legacy startedAt, acquires ownership at the current time,
		// seeds the state, and returns the open connection + active handle.
		// We continue with the same connection — no double open/acquire cycle.
		const seeded = seedLegacyStateToSqlite(runDir, runId, snapshot.state);
		runDb = seeded.runDb;
		handle = seeded.handle;
	} else {
		// DB file exists — open it first to determine whether the bootstrap
		// completed or was interrupted by a crash.  The DB file can exist
		// without an authoritative state row if the previous process crashed
		// between schema creation and the fenced initial state establishment.
		runDb = openRunDatabase({
			driver: bunSqliteDriver,
			dbPath,
			busyTimeoutMs: 2000,
		});

		const preRead = readAuthoritativeState<S>(runDb.connection);

		if (preRead.state !== null) {
			// Validate identity BEFORE acquiring ownership — a DB placed
			// in the wrong RUN_DIR must be rejected before we take the
			// lock and before we project state.json.
			if (preRead.state.runId !== runId) {
				runDb.close();
				throw new ProtocolError(
					`DB identity mismatch — incarnation runId=${preRead.state.runId}, argv.runId=${runId}`,
					{ runId, orchestratorName: config.name },
				);
			}
			if (preRead.state.orchestratorName !== config.name) {
				runDb.close();
				throw new ProtocolError(
					`DB identity mismatch — incarnation orchestratorName=${preRead.state.orchestratorName}, config.name=${config.name}`,
					{ runId, orchestratorName: config.name },
				);
			}

			// Fully bootstrapped — acquire ownership normally.
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

			handle = acquireResult.handle;
		} else {
			// Incomplete bootstrap — the DB has schema tables but no
			// authoritative state row.  Close this connection and recover
			// via the legacy seed path, which is idempotent: the incarnation
			// pre-creation uses INSERT OR IGNORE, acquireOwnership handles
			// existing ownership rows via CAS, and seedLegacyStateToSqlite
			// is idempotent (INSERT OR IGNORE).
			runDb.close();

			const legacyStatePath = path.join(runDir, "state.json");
			if (!fs.existsSync(legacyStatePath)) {
				throw new StateMissingError(
					"SQLite DB exists but has no state row, and state.json is also missing",
					{ runId, orchestratorName: config.name },
				);
			}

			let snapshot: ReturnType<typeof readStateSnapshot<S>>;
			try {
				snapshot = readStateSnapshot<S>(runDir, config.stateSchema);
			} catch (err) {
				if (err instanceof StateMigrationBlockedError) {
					throw new StateMigrationBlockedError(
						`v3→v4 migration incomplete — cannot recover incomplete SQLite bootstrap: ${err.message}`,
						{
							reason: err.reason,
							runId,
							orchestratorName: config.name,
						},
					);
				}
				throw err;
			}
			if (snapshot.state === null) {
				throw new StateMissingError(
					"state.json missing — cannot recover incomplete SQLite bootstrap",
					{ runId, orchestratorName: config.name },
				);
			}

			// Validate identity before seed.
			if (snapshot.state.runId !== runId) {
				throw new ProtocolError(
					`RUN_DIR mismatch — state.runId=${snapshot.state.runId}, argv.runId=${runId}`,
					{ runId, orchestratorName: config.name },
				);
			}
			if (snapshot.state.orchestratorName !== config.name) {
				throw new ProtocolError(
					`orchestrator name mismatch — state.orchestratorName=${snapshot.state.orchestratorName}, config.name=${config.name}`,
					{ runId, orchestratorName: config.name },
				);
			}

			// seedLegacyStateToSqlite is idempotent — it opens the DB,
			// pre-creates the incarnation (INSERT OR IGNORE), acquires
			// ownership (CAS), seeds the state (INSERT OR IGNORE), and
			// returns the open connection + active handle.
			const seeded = seedLegacyStateToSqlite(runDir, runId, snapshot.state);
			runDb = seeded.runDb;
			handle = seeded.handle;
		}
	}

	// Read authoritative state from SQLite (defense-in-depth — should
	// always succeed after the paths above).
	//
	// From here to runHandleResume, the catch block at the end of
	// this scope is the single owner of releaseOwnership + runDb.close().
	// Individual branches must NOT release or close — just throw.
	try {
		const readResult = readAuthoritativeState<S>(runDb.connection);
		if (readResult.state === null) {
			throw new StateMissingError("state missing in SQLite", {
				runId,
				orchestratorName: config.name,
			});
		}

		// Attempt v3→v4 migration via migrateV3ToV4.  The migration is
		// all-or-nothing: if any legacy manifest cannot be converted, the
		// result includes the blocking reason.  A v3 state with no legacy
		// fields at all is a successful no-op migration.
		let authoritativeRecord = readResult.state;
		let authoritativeDigest = readResult.digest;
		let pendingInitialDispatch = readResult.pendingInitialDispatch;

		if (readResult.state.schemaVersion === 3) {
			const migrationResult = migrateV3ToV4(
				readResult.state as unknown as Record<string, unknown>,
				runDir,
			);

			if (migrationResult.kind === "MIGRATED") {
				const maybeMigrated = migrationResult.state;
				// All legacy fields were converted (or none existed) — commit the v4 state.
				const migratedRecord: StateRecord<S> = {
					...readResult.state,
					schemaVersion: STATE_SCHEMA_VERSION,
					pendingDelegation: maybeMigrated.pendingDelegation,
					pendingExternalRequest: maybeMigrated.pendingExternalRequest,
					...(maybeMigrated.terminalResult !== undefined
						? {
								terminalResult:
									maybeMigrated.terminalResult as TerminalDoneRecord,
							}
						: {}),
				};

				const { commitState } =
					require("../persistence/sqlite/run-state-store") as {
						commitState: typeof import("../persistence/sqlite/run-state-store").commitState;
					};
				const commitResult = commitState({
					db: runDb.connection,
					handle,
					expectedRevision: readResult.state.stateRevision,
					nextState: migratedRecord,
					nowEpochMs: clock.nowEpochMs(),
					nowIso: clock.nowWallIso(),
				});

				if (commitResult.kind !== "COMMITTED") {
					throw new ProtocolError(
						`v3→v4 migration commit failed: ${commitResult.kind}`,
						{
							runId,
							orchestratorName: config.name,
							cause:
								commitResult.kind === "DB_FAILURE"
									? commitResult.cause
									: undefined,
						},
					);
				}

				authoritativeRecord = commitResult.committed.state as StateRecord<S>;
				authoritativeDigest = commitResult.committed.stateDigest;
				pendingInitialDispatch = false;
			} else {
				throw new StateMigrationBlockedError(
					"v3→v4 migration blocked: legacy manifest cannot be converted",
					{
						reason: migrationResult.reason,
						runId,
						orchestratorName: config.name,
					},
				);
			}
		}

		// Build the in-memory StateFile from the authoritative record (which
		// may now be v4 with the updated revision).
		const state = stateRecordToStateFile(authoritativeRecord, runDir);

		// Project state.json from the authoritative record under fence.
		// The fenced projection re-reads from SQLite — content always comes
		// from the authority.
		// Wrap in try/catch — if projection fails after the state is already
		// authoritative, we must release ownership before throwing.
		projectAuthoritativeStateFenced(
			runDb.connection,
			handle,
			runDir,
			authoritativeRecord.stateRevision,
			authoritativeDigest ?? "",
			undefined,
			dependencies.projectionDependencies,
		);

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
		fs.mkdirSync(path.join(runDir, "accepted-external-resolutions"), {
			recursive: true,
		});
		fs.mkdirSync(path.join(runDir, "artifacts", "sha256"), {
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
			stateRevision: authoritativeRecord.stateRevision,
		};

		installSignalHandlers(ctx);

		await runHandleResume(ctx, state, pendingInitialDispatch);
	} catch (primaryError) {
		// Single cleanup owner — release ownership then close the DB.
		// Internal branches MUST NOT release or close; they just throw.
		const releaseResult = releaseOwnership({ db: runDb.connection, handle });
		runDb.close();

		if (
			releaseResult.kind !== "SUCCESS" &&
			releaseResult.kind !== "STALE_HANDLE"
		) {
			// Release failed — the ownership may be leaked.  Emit a
			// warning to stderr (so it is observable) but rethrow the
			// primary error unchanged to preserve its protocol-visible
			// classification (errorKind, runId, etc.).
			//
			// Throwing AggregateError here would mask the primary error
			// inside handleTopLevelError, which does not know how to
			// unpack AggregateError.
			process.stderr.write(
				`[turnlock] ownership release failed: ${releaseResult.kind}` +
					(releaseResult.kind === "DB_FAILURE"
						? ` (${String(releaseResult.cause)})`
						: "") +
					"\n",
			);
		}

		throw primaryError;
	}
}

export async function runOrchestratorInternal<S extends object>(
	config: OrchestratorConfig<S>,
	argv: ParsedArgv,
	dependencies: RunOrchestratorInternalDependencies,
): Promise<void> {
	validateConfig(config);
	if (argv.resume) {
		await runResumeMode(config, argv, dependencies);
	} else {
		await runInitialMode(config, argv, dependencies);
	}
}

export async function runOrchestrator<S extends object>(
	config: OrchestratorConfig<S>,
): Promise<void> {
	try {
		const argv = parseArgv(process.argv.slice(2));
		await runOrchestratorInternal(
			config,
			argv,
			productionRunOrchestratorDependencies,
		);
	} catch (err) {
		if (isTestExitSignal(err)) return;
		try {
			handleTopLevelError(err, config);
		} catch (e) {
			if (isTestExitSignal(e)) return;
		}
	}
}
