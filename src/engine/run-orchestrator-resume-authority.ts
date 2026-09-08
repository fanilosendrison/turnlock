import * as fs from "node:fs";
import * as path from "node:path";
import { RUN_DB_FILENAME } from "../constants.js";
import {
	InvalidConfigError,
	ProtocolError,
	RunLockedError,
	StateMigrationBlockedError,
	StateMissingError,
} from "../errors/concrete.js";
import { nodeSqliteDriver } from "../persistence/sqlite/node-sqlite-driver.js";
import {
	acquireOwnership,
	type LockHandle,
	releaseOwnership,
} from "../persistence/sqlite/ownership.js";
import {
	openRunDatabase,
	type RunDatabase,
} from "../persistence/sqlite/run-database.js";
import { readAuthoritativeState } from "../persistence/sqlite/run-state-store.js";
import { clock } from "../services/clock.js";
import { createLogger } from "../services/logger.js";
import { resolveRunDir } from "../services/run-dir.js";
import {
	acquireRunNamespaceMutex,
	NAMESPACE_MUTEX_BUSY_TIMEOUT_MS,
	type RunNamespaceMutexHandle,
	resolveNamespaceMutexPath,
} from "../services/run-namespace-mutex.js";
import { readStateSnapshot, type StateFile } from "../services/state-io.js";
import type { OrchestratorConfig } from "../types/config.js";
import { doExit } from "./context.js";
import { emitRunLockedError } from "./error-emitter.js";
import { assertOwnershipStorageCompatibility } from "./ownership-storage-compatibility.js";
import type { ParsedArgv } from "./preflight.js";
import { validateExternalRunId } from "./preflight.js";
import { seedLegacyStateToSqlite } from "./run-orchestrator-legacy-migration.js";

export interface ResumeAuthoritySetup {
	readonly runId: string;
	readonly runDir: string;
	readonly logger: ReturnType<typeof createLogger>;
	readonly namespaceMutex: RunNamespaceMutexHandle;
	readonly runDb: RunDatabase | null;
	readonly handle: LockHandle | null;
}

/** Acquire the namespace mutex and establish the authoritative run database
 *  and ownership handle. On setup failure, this function owns cleanup. */
export function setupResumeAuthority<S extends object>(
	config: OrchestratorConfig<S>,
	argv: ParsedArgv,
): ResumeAuthoritySetup {
	if (!argv.runId) {
		throw new InvalidConfigError("--resume requires --run-id");
	}
	const runId = argv.runId;
	validateExternalRunId(runId, config.name);
	const cwd = process.cwd();
	const runDir = resolveRunDir(cwd, config.name, runId, config.runDirRoot);
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
	const logger = createLogger(config.logging);
	let runDb: RunDatabase | null = null;
	let handle: LockHandle | null = null;
	try {
		assertRealRunDirectory(runDir, runId, config.name);
		const databasePath = path.join(runDir, RUN_DB_FILENAME);
		const databaseExists = fs.existsSync(databasePath);
		assertOwnershipStorageCompatibility({
			runDir,
			sqliteDatabaseExists: databaseExists,
			mode: "resume",
			runId,
			orchestratorName: config.name,
		});
		if (!databaseExists) {
			const state = readLegacyStateForAuthority(
				runDir,
				config,
				runId,
				"CREATE",
			);
			const seeded = seedLegacyStateToSqlite(runDir, runId, state);
			runDb = seeded.runDb;
			handle = seeded.handle;
		} else {
			runDb = openRunDatabase({
				driver: nodeSqliteDriver,
				dbPath: databasePath,
				busyTimeoutMs: 2000,
			});
			const preRead = readAuthoritativeState<S>(runDb.connection);
			if (preRead.state !== null) {
				validateDatabaseIdentity(preRead.state, runId, config.name, runDb);
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
				if (acquireResult.kind === "RUN_RETIRING") {
					runDb.close();
					throw new ProtocolError(
						"Run is retired by retention cleanup — no new ownership may be acquired",
						{ runId, orchestratorName: config.name },
					);
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
				runDb.close();
				const legacyStatePath = path.join(runDir, "state.json");
				if (!fs.existsSync(legacyStatePath)) {
					throw new StateMissingError(
						"SQLite DB exists but has no state row, and state.json is also missing",
						{ runId, orchestratorName: config.name },
					);
				}
				const state = readLegacyStateForAuthority(
					runDir,
					config,
					runId,
					"RECOVER",
				);
				const seeded = seedLegacyStateToSqlite(runDir, runId, state);
				runDb = seeded.runDb;
				handle = seeded.handle;
			}
		}
	} catch (setupError) {
		if (runDb !== null && handle !== null) {
			releaseOwnership({ db: runDb.connection, handle });
			runDb.close();
		} else {
			runDb?.close();
		}
		namespaceMutex.rollbackAndRelease();
		throw setupError;
	}
	return { runId, runDir, logger, namespaceMutex, runDb, handle };
}

function assertRealRunDirectory(
	runDir: string,
	runId: string,
	orchestratorName: string,
): void {
	let runDirectoryStat: fs.Stats;
	try {
		runDirectoryStat = fs.lstatSync(runDir);
	} catch (error) {
		throw new StateMissingError(`RUN_DIR does not exist: ${runDir}`, {
			runId,
			orchestratorName,
			cause: error,
		});
	}
	if (runDirectoryStat.isSymbolicLink() || !runDirectoryStat.isDirectory()) {
		throw new StateMissingError(`RUN_DIR is not a real directory: ${runDir}`, {
			runId,
			orchestratorName,
		});
	}
}

function readLegacyStateForAuthority<S extends object>(
	runDir: string,
	config: OrchestratorConfig<S>,
	runId: string,
	mode: "CREATE" | "RECOVER",
): StateFile<S> {
	let snapshot: ReturnType<typeof readStateSnapshot<S>>;
	try {
		snapshot = readStateSnapshot<S>(runDir, config.stateSchema);
	} catch (error) {
		if (error instanceof StateMigrationBlockedError) {
			throw new StateMigrationBlockedError(
				mode === "CREATE"
					? `v3→v4 migration incomplete — cannot create authoritative SQLite DB: ${error.message}`
					: `v3→v4 migration incomplete — cannot recover incomplete SQLite bootstrap: ${error.message}`,
				{
					reason: error.reason,
					runId,
					orchestratorName: config.name,
				},
			);
		}
		throw error;
	}
	if (snapshot.state === null) {
		throw new StateMissingError(
			mode === "CREATE"
				? "state.json missing at RUN_DIR"
				: "state.json missing — cannot recover incomplete SQLite bootstrap",
			{ runId, orchestratorName: config.name },
		);
	}
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
	return snapshot.state;
}

function validateDatabaseIdentity(
	state: { readonly runId: string; readonly orchestratorName: string },
	runId: string,
	orchestratorName: string,
	runDb: RunDatabase,
): void {
	if (state.runId !== runId) {
		runDb.close();
		throw new ProtocolError(
			`DB identity mismatch — incarnation runId=${state.runId}, argv.runId=${runId}`,
			{ runId, orchestratorName },
		);
	}
	if (state.orchestratorName !== orchestratorName) {
		runDb.close();
		throw new ProtocolError(
			`DB identity mismatch — incarnation orchestratorName=${state.orchestratorName}, config.name=${orchestratorName}`,
			{ runId, orchestratorName },
		);
	}
}
