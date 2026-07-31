import * as fs from "node:fs";
import * as path from "node:path";
import { STATE_SCHEMA_VERSION } from "../constants";
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
import {
	type ParsedArgv,
	parseArgv,
	validateConfig,
	validateExternalRunId,
} from "./preflight";
import { installSignalHandlers } from "./signal-handlers";

const DB_FILENAME = "turnlock.sqlite3";

/** Seed a freshly created SQLite DB from a legacy state.json snapshot.
 *
 *  Opens the DB, pre-creates `run_incarnation` with the **legacy
 *  historical** `startedAt` (so the run's identity is preserved), then
 *  acquires ownership at the **current wall-clock time** (so the lease
 *  is valid), seeds the state row (timestamped at the legacy
 *  `lastTransitionAt`), and returns the open connection + active handle.
 *
 *  Does NOT call `projectStateJson` — the caller projects from the
 *  authoritative record re-read after this function returns.
 *
 *  On any failure after the DB is opened, the ownership is released
 *  (if acquired) and the DB is closed before rethrowing. */
function seedLegacyStateToSqlite<S extends object>(
	runDir: string,
	runId: string,
	state: StateFile<S>,
): {
	runDb: ReturnType<typeof openRunDatabase>;
	handle: import("../persistence/sqlite/ownership").LockHandle;
} {
	const dbPath = path.join(runDir, DB_FILENAME);
	const runDb = openRunDatabase({
		driver: bunSqliteDriver,
		dbPath,
		busyTimeoutMs: 2000,
	});

	let handle: import("../persistence/sqlite/ownership").LockHandle | null =
		null;

	try {
		// Pre-create run_incarnation with legacy historical startedAt
		// *before* acquireOwnership.  acquireOwnership → ensureIncarnation
		// will find the existing row and preserve these timestamps instead
		// of overwriting them with clock.now().
		//
		// Uses INSERT OR IGNORE — idempotent if incarnation already exists.
		runDb.connection
			.prepare(
				`INSERT OR IGNORE INTO run_incarnation
				 (singleton, run_id, incarnation_id, orchestrator_name,
				  created_at_epoch_ms, created_at_iso)
				 VALUES (1, ?, ?, ?, ?, ?)`,
			)
			.run(
				runId,
				state.runId, // incarnation_id derived from legacy runId
				state.orchestratorName,
				state.startedAtEpochMs,
				state.startedAt,
			);

		// Ownership must be acquired at the *current* wall-clock time for a
		// valid lease.  The incarnation timestamps are already set above.
		const ownershipNowEpochMs = clock.nowEpochMs();
		const ownershipNowIso = clock.nowWallIso();

		const acquireResult = acquireOwnership({
			db: runDb.connection,
			runId,
			orchestratorName: state.orchestratorName,
			nowEpochMs: ownershipNowEpochMs,
			nowIso: ownershipNowIso,
			leaseDurationMs: 30 * 60 * 1000,
			contentionDeadlineMs: 5000,
		});

		if (acquireResult.kind !== "ACQUIRED") {
			// DB opened but acquisition failed — close is handled in catch.
			throw new StateMissingError(
				`Failed to acquire ownership during legacy migration: ${acquireResult.kind}`,
				{ runId, orchestratorName: state.orchestratorName },
			);
		}

		handle = acquireResult.handle;

		ensureInitialStateRow(
			runDb.connection,
			handle.incarnationId,
			state.schemaVersion,
			JSON.stringify(state),
			state.lastTransitionAtEpochMs,
			state.lastTransitionAt,
		);

		// Do NOT project state.json here.  The caller re-reads the
		// authoritative record from SQLite and projects it with the
		// correct stateDigest, runIncarnationId, stateRevision, etc.

		return { runDb, handle };
	} catch (err) {
		// Release ownership if acquired, so the next attempt can acquire
		// immediately.  A DB_FAILURE result is attached to the error to
		// prevent silent ownership leaks.
		if (handle !== null) {
			const releaseResult = releaseOwnership({
				db: runDb.connection,
				handle,
			});
			if (
				releaseResult.kind !== "SUCCESS" &&
				releaseResult.kind !== "STALE_HANDLE"
			) {
				// Wrap the original error so the caller can see both
				// the seed failure and the release failure.
				const wrapped = new StateMissingError(
					`Legacy seed failed and ownership release also failed: ${releaseResult.kind}`,
					{
						runId,
						orchestratorName: state.orchestratorName,
						cause:
							releaseResult.kind === "DB_FAILURE"
								? new AggregateError(
										[err, releaseResult.cause],
										"legacy seed and ownership release both failed",
									)
								: err,
					},
				);
				runDb.close();
				throw wrapped;
			}
		}
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
		// between schema creation and ensureInitialStateRow.
		runDb = openRunDatabase({
			driver: bunSqliteDriver,
			dbPath,
			busyTimeoutMs: 2000,
		});

		const preRead = readAuthoritativeState<S>(runDb.connection);

		if (preRead.state !== null) {
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
			// existing ownership rows via CAS, and ensureInitialStateRow
			// uses INSERT OR IGNORE.
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
	const readResult = readAuthoritativeState<S>(runDb.connection);
	if (readResult.state === null) {
		// Release ownership so the next attempt can acquire immediately.
		// STALE_HANDLE is acceptable — this handle should still be valid.
		const releaseResult = releaseOwnership({
			db: runDb.connection,
			handle,
		});
		runDb.close();

		if (
			releaseResult.kind !== "SUCCESS" &&
			releaseResult.kind !== "STALE_HANDLE"
		) {
			throw new StateMissingError("state missing in SQLite (release failed)", {
				runId,
				orchestratorName: config.name,
				cause:
					releaseResult.kind === "DB_FAILURE" ? releaseResult.cause : undefined,
			});
		}

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
				runDb.close();
				throw new ProtocolError(
					`v3→v4 migration commit failed: ${commitResult.kind}`,
					{ runId, orchestratorName: config.name },
				);
			}

			authoritativeRecord = commitResult.committed.state as StateRecord<S>;
			authoritativeDigest = commitResult.committed.stateDigest;
		} else {
			// Migration blocked — state stays v3.  This is fatal:
			// we cannot resume with a v3 state that cannot be migrated.
			// Release ownership before closing so the next attempt
			// can acquire immediately.
			const releaseResult = releaseOwnership({
				db: runDb.connection,
				handle,
			});
			runDb.close();

			// STALE_HANDLE is acceptable: this handle no longer owns
			// the row (a successor may hold it).  No further release
			// should be attempted.
			// DB_FAILURE means we could not release — report it.
			if (
				releaseResult.kind !== "SUCCESS" &&
				releaseResult.kind !== "STALE_HANDLE"
			) {
				throw new StateMigrationBlockedError(
					`v3→v4 migration blocked: legacy manifest cannot be converted (release failed: ${releaseResult.kind})`,
					{
						reason: migrationResult.reason,
						cause:
							releaseResult.kind === "DB_FAILURE"
								? releaseResult.cause
								: undefined,
						runId,
						orchestratorName: config.name,
					},
				);
			}

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

	// Project state.json from the authoritative record.
	projectStateJson(runDir, authoritativeRecord, authoritativeDigest ?? "");

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
