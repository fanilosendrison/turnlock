import * as path from "node:path";
import { STATE_SCHEMA_VERSION } from "../constants.js";
import {
	ProtocolError,
	StateMigrationBlockedError,
	StateMissingError,
} from "../errors/concrete.js";
import type { LockHandle } from "../persistence/sqlite/ownership.js";
import type { RunDatabase } from "../persistence/sqlite/run-database.js";
import {
	commitState,
	projectAuthoritativeStateFenced,
	readAuthoritativeState,
	type StateRecord,
} from "../persistence/sqlite/run-state-store.js";
import { clock } from "../services/clock.js";
import { ensureDirectoryPathWithoutSymlinks } from "../services/durable-fs.js";
import type { createLogger } from "../services/logger.js";
import { migrateV3ToV4, type StateFile } from "../services/state-io.js";
import type { TerminalDoneRecord } from "../types/artifacts.js";
import type { OrchestratorConfig } from "../types/config.js";
import { installPreparedArtifactFenced } from "./artifact-commit.js";
import type { RunOrchestratorInternalDependencies } from "./run-orchestrator-contracts.js";
import { stateRecordToStateFile } from "./run-orchestrator-legacy-migration.js";

export interface PreparedResumeState<S extends object> {
	readonly state: StateFile<S>;
	readonly pendingInitialDispatch: boolean;
	readonly stateRevision: string;
}

/** Migrate, project, validate, and establish canonical resume filesystem
 *  state while the caller still holds the namespace mutex. */
export function prepareResumeState<S extends object>(params: {
	readonly config: OrchestratorConfig<S>;
	readonly runId: string;
	readonly runDir: string;
	readonly runDb: RunDatabase;
	readonly handle: LockHandle;
	readonly logger: ReturnType<typeof createLogger>;
	readonly dependencies: RunOrchestratorInternalDependencies;
}): PreparedResumeState<S> {
	const { config, runId, runDir, runDb, handle, logger, dependencies } = params;
	const readResult = readAuthoritativeState<S>(runDb.connection);
	if (readResult.state === null) {
		throw new StateMissingError("state missing in SQLite", {
			runId,
			orchestratorName: config.name,
		});
	}
	let authoritativeRecord = readResult.state;
	let authoritativeDigest = readResult.digest;
	let pendingInitialDispatch = readResult.pendingInitialDispatch;
	if (readResult.state.schemaVersion === 3) {
		const migrationResult = migrateV3ToV4(
			readResult.state as unknown as Record<string, unknown>,
			runDir,
			(artifact) =>
				installPreparedArtifactFenced(
					{
						runDb,
						handle,
						runDir,
						runId,
						config: { name: config.name },
						currentPhase: readResult.state?.currentPhase ?? null,
					},
					artifact,
				),
		);
		if (migrationResult.kind === "MIGRATED") {
			const maybeMigrated = migrationResult.state;
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
	const state = stateRecordToStateFile(authoritativeRecord, runDir);
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
	for (const relativePath of [
		"external-requests",
		"external-results",
		"accepted-external-resolutions",
		path.join("artifacts", "sha256"),
	]) {
		ensureDirectoryPathWithoutSymlinks(path.join(runDir, relativePath), runDir);
	}
	logger.enableDiskEmit(path.join(runDir, "events.ndjson"));
	return {
		state,
		pendingInitialDispatch,
		stateRevision: authoritativeRecord.stateRevision,
	};
}
