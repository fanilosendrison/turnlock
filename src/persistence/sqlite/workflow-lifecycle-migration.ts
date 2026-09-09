import {
	LEGACY_PENDING_INITIAL_DISPATCH_STATE_FIELD,
	LEGACY_PENDING_INITIAL_DISPATCH_VERSION_STATE_FIELD,
	PENDING_INITIAL_DISPATCH_STATE_FIELD,
	PENDING_INITIAL_DISPATCH_VERSION_STATE_FIELD,
	STATE_SCHEMA_VERSION,
} from "../../constants.js";
import { validateCanonicalStateShape } from "../../services/state-canonical-validation.js";
import { isTerminalDoneRecord } from "../../services/state-value-validation.js";
import { DbIntegrityError } from "./errors.js";
import { computeStateDigest } from "./run-state-codec.js";
import type { SqliteConnection } from "./sqlite-driver.js";
import {
	readWorkflowLifecycleRow,
	WORKFLOW_STATUS_NONTERMINAL,
	WORKFLOW_STATUS_TERMINAL,
	WORKFLOW_TERMINAL_KIND_DONE,
	WORKFLOW_TERMINAL_KIND_LEGACY_RETENTION_CLAIM,
} from "./workflow-lifecycle.js";

interface IncarnationRow {
	readonly runId: string;
	readonly incarnationId: string;
	readonly orchestratorName: string;
}

function readIncarnation(db: SqliteConnection): IncarnationRow | null {
	const row = db
		.prepare(
			"SELECT run_id, incarnation_id, orchestrator_name FROM run_incarnation WHERE singleton = 1",
		)
		.get() as
		| {
				run_id: string;
				incarnation_id: string;
				orchestrator_name: string;
		  }
		| undefined;
	return row === undefined
		? null
		: {
				runId: row.run_id,
				incarnationId: row.incarnation_id,
				orchestratorName: row.orchestrator_name,
			};
}

function hasAnyInitialDispatchMarker(state: Record<string, unknown>): boolean {
	return [
		PENDING_INITIAL_DISPATCH_STATE_FIELD,
		PENDING_INITIAL_DISPATCH_VERSION_STATE_FIELD,
		LEGACY_PENDING_INITIAL_DISPATCH_STATE_FIELD,
		LEGACY_PENDING_INITIAL_DISPATCH_VERSION_STATE_FIELD,
	].some((field) => field in state);
}

function inferMigratedTerminalDone(
	db: SqliteConnection,
	incarnation: IncarnationRow,
): number | null {
	const row = db
		.prepare(`SELECT incarnation_id, state_schema_version, state_json,
		        state_digest, committed_at_epoch_ms
		 FROM run_state WHERE singleton = 1`)
		.get() as
		| {
				incarnation_id: string;
				state_schema_version: number;
				state_json: string;
				state_digest: string;
				committed_at_epoch_ms: number;
		  }
		| undefined;
	if (
		row === undefined ||
		row.incarnation_id !== incarnation.incarnationId ||
		row.state_schema_version !== STATE_SCHEMA_VERSION ||
		row.state_digest !== computeStateDigest(row.state_json) ||
		!Number.isSafeInteger(row.committed_at_epoch_ms) ||
		row.committed_at_epoch_ms < 0
	) {
		return null;
	}
	try {
		const parsed = JSON.parse(row.state_json) as unknown;
		if (
			typeof parsed !== "object" ||
			parsed === null ||
			Array.isArray(parsed)
		) {
			return null;
		}
		const state = parsed as Record<string, unknown>;
		validateCanonicalStateShape(state, STATE_SCHEMA_VERSION);
		if (
			state.schemaVersion !== STATE_SCHEMA_VERSION ||
			state.runId !== incarnation.runId ||
			state.orchestratorName !== incarnation.orchestratorName ||
			state.pendingDelegation !== undefined ||
			state.pendingExternalRequest !== undefined ||
			hasAnyInitialDispatchMarker(state) ||
			!isTerminalDoneRecord(state.terminalResult)
		) {
			return null;
		}
		return row.committed_at_epoch_ms;
	} catch {
		return null;
	}
}

function insertMigratedLifecycle(
	db: SqliteConnection,
	incarnationId: string,
	terminal: null | {
		readonly kind:
			| typeof WORKFLOW_TERMINAL_KIND_DONE
			| typeof WORKFLOW_TERMINAL_KIND_LEGACY_RETENTION_CLAIM;
		readonly atEpochMs: number;
	},
): void {
	const result = terminal
		? db
				.prepare(`INSERT INTO run_workflow_lifecycle
				 (singleton, incarnation_id, lifecycle_status, terminal_kind,
				  terminal_at_epoch_ms)
				 VALUES (1, ?, ?, ?, ?)`)
				.run(
					incarnationId,
					WORKFLOW_STATUS_TERMINAL,
					terminal.kind,
					terminal.atEpochMs,
				)
		: db
				.prepare(`INSERT INTO run_workflow_lifecycle
				 (singleton, incarnation_id, lifecycle_status)
				 VALUES (1, ?, ?)`)
				.run(incarnationId, WORKFLOW_STATUS_NONTERMINAL);
	if (result.changes !== 1) {
		throw new DbIntegrityError(
			`workflow lifecycle migration inserted ${result.changes} rows — expected exactly 1`,
		);
	}
}

/** Create lifecycle evidence for schema-v1/v2 authorities conservatively. */
export function migrateWorkflowLifecycleInTransaction(
	db: SqliteConnection,
	legacyRetirementClaimedAtEpochMs: number | null,
): void {
	const incarnation = readIncarnation(db);
	if (incarnation === null) return;
	if (readWorkflowLifecycleRow(db) !== null) {
		throw new DbIntegrityError(
			"legacy database unexpectedly already contains workflow lifecycle state",
		);
	}
	if (legacyRetirementClaimedAtEpochMs !== null) {
		insertMigratedLifecycle(db, incarnation.incarnationId, {
			kind: WORKFLOW_TERMINAL_KIND_LEGACY_RETENTION_CLAIM,
			atEpochMs: legacyRetirementClaimedAtEpochMs,
		});
		return;
	}
	const terminalDoneAt = inferMigratedTerminalDone(db, incarnation);
	insertMigratedLifecycle(
		db,
		incarnation.incarnationId,
		terminalDoneAt === null
			? null
			: { kind: WORKFLOW_TERMINAL_KIND_DONE, atEpochMs: terminalDoneAt },
	);
}

/** Validate lifecycle row presence and incarnation binding for schema v3. */
export function validateWorkflowLifecycleSchemaInTransaction(
	db: SqliteConnection,
): void {
	const incarnation = readIncarnation(db);
	const lifecycle = readWorkflowLifecycleRow(db, incarnation?.incarnationId);
	if (incarnation === null && lifecycle !== null) {
		throw new DbIntegrityError(
			"workflow lifecycle exists without a run incarnation",
		);
	}
	if (incarnation !== null && lifecycle === null) {
		const stateExists =
			db.prepare("SELECT 1 FROM run_state WHERE singleton = 1").get() !==
			undefined;
		if (stateExists) {
			throw new DbIntegrityError(
				"schema v3 established run lacks workflow lifecycle state",
			);
		}
		// An incarnation without state is a recoverable pre-state bootstrap
		// frontier. The bootstrap/acquisition transaction will establish the
		// NONTERMINAL lifecycle before publishing ownership and state.
	}
}
