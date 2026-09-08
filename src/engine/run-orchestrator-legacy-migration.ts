import * as path from "node:path";
import { RUN_DB_FILENAME, STATE_SCHEMA_VERSION } from "../constants.js";
import { ProtocolError, StateMissingError } from "../errors/concrete.js";
import { nodeSqliteDriver } from "../persistence/sqlite/node-sqlite-driver.js";
import type { LockHandle } from "../persistence/sqlite/ownership.js";
import {
	type CommittedState,
	migrateLegacyRunAtomic,
} from "../persistence/sqlite/run-bootstrap.js";
import { openRunDatabase } from "../persistence/sqlite/run-database.js";
import type { StateRecord } from "../persistence/sqlite/run-state-store.js";
import { clock } from "../services/clock.js";
import { migrateV3ToV4, type StateFile } from "../services/state-io.js";

/** Migrate a legacy state.json snapshot into an authoritative SQLite run in
 *  one transaction, preserving legacy timestamps. */
export function seedLegacyStateToSqlite<S extends object>(
	runDir: string,
	runId: string,
	state: StateFile<S>,
): {
	runDb: ReturnType<typeof openRunDatabase>;
	handle: LockHandle;
	committed: CommittedState;
} {
	const databasePath = path.join(runDir, RUN_DB_FILENAME);
	const runDb = openRunDatabase({
		driver: nodeSqliteDriver,
		dbPath: databasePath,
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
		if (migrateResult.kind === "RUN_RETIRING") {
			runDb.close();
			throw new ProtocolError(
				"Run is retired by retention cleanup — no new ownership may be acquired",
				{ runId, orchestratorName: state.orchestratorName },
			);
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
		runDb.close();
		throw new StateMissingError("Legacy migration: DB contention timeout", {
			runId,
			orchestratorName: state.orchestratorName,
		});
	} catch (error) {
		runDb.close();
		throw error;
	}
}

/** Convert an authoritative SQLite record into the resume StateFile shape. */
export function stateRecordToStateFile<S extends object>(
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
	if (record.schemaVersion === 3) {
		return migrateStateFileV3ToV4(
			result as unknown as Record<string, unknown>,
			runDir,
		) as unknown as StateFile<S>;
	}
	return result;
}

function migrateStateFileV3ToV4(
	parsed: Record<string, unknown>,
	runDir: string,
): Record<string, unknown> {
	try {
		const result = migrateV3ToV4(parsed, runDir);
		return result.kind === "MIGRATED" ? result.state : parsed;
	} catch {
		return parsed;
	}
}
