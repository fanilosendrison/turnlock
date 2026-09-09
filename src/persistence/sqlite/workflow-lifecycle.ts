import { DbIntegrityError } from "./errors.js";
import type { SqliteConnection } from "./sqlite-driver.js";

export const WORKFLOW_STATUS_NONTERMINAL = "NONTERMINAL" as const;
export const WORKFLOW_STATUS_TERMINAL = "TERMINAL" as const;
export const WORKFLOW_TERMINAL_KIND_DONE = "DONE" as const;
export const WORKFLOW_TERMINAL_KIND_FAIL = "FAIL" as const;
export const WORKFLOW_TERMINAL_KIND_LEGACY_RETENTION_CLAIM =
	"LEGACY_RETENTION_CLAIM" as const;

export type WorkflowStatus =
	| typeof WORKFLOW_STATUS_NONTERMINAL
	| typeof WORKFLOW_STATUS_TERMINAL;
export type WorkflowCompletionKind =
	| typeof WORKFLOW_TERMINAL_KIND_DONE
	| typeof WORKFLOW_TERMINAL_KIND_FAIL;
export type WorkflowTerminalKind =
	| WorkflowCompletionKind
	| typeof WORKFLOW_TERMINAL_KIND_LEGACY_RETENTION_CLAIM;

export type WorkflowLifecycleRow =
	| {
			readonly incarnationId: string;
			readonly status: typeof WORKFLOW_STATUS_NONTERMINAL;
			readonly terminalKind: null;
			readonly terminalAtEpochMs: null;
	  }
	| {
			readonly incarnationId: string;
			readonly status: typeof WORKFLOW_STATUS_TERMINAL;
			readonly terminalKind: WorkflowTerminalKind;
			readonly terminalAtEpochMs: number;
	  };

interface RawWorkflowLifecycleRow {
	readonly incarnation_id: string;
	readonly lifecycle_status: string;
	readonly terminal_kind: string | null;
	readonly terminal_at_epoch_ms: number | null;
}

function readRawWorkflowLifecycleRow(
	db: SqliteConnection,
): RawWorkflowLifecycleRow | undefined {
	return db
		.prepare(`SELECT incarnation_id, lifecycle_status, terminal_kind,
		        terminal_at_epoch_ms
		 FROM run_workflow_lifecycle WHERE singleton = 1`)
		.get() as RawWorkflowLifecycleRow | undefined;
}

function isWorkflowTerminalKind(value: string): value is WorkflowTerminalKind {
	return (
		value === WORKFLOW_TERMINAL_KIND_DONE ||
		value === WORKFLOW_TERMINAL_KIND_FAIL ||
		value === WORKFLOW_TERMINAL_KIND_LEGACY_RETENTION_CLAIM
	);
}

/** Read and strictly validate the durable workflow lifecycle singleton. */
export function readWorkflowLifecycleRow(
	db: SqliteConnection,
	expectedIncarnationId?: string,
): WorkflowLifecycleRow | null {
	const row = readRawWorkflowLifecycleRow(db);
	if (row === undefined) return null;
	if (
		expectedIncarnationId !== undefined &&
		row.incarnation_id !== expectedIncarnationId
	) {
		throw new DbIntegrityError(
			`workflow lifecycle incarnation mismatch: expected ${expectedIncarnationId}, got ${row.incarnation_id}`,
		);
	}
	if (row.lifecycle_status === WORKFLOW_STATUS_NONTERMINAL) {
		if (row.terminal_kind !== null || row.terminal_at_epoch_ms !== null) {
			throw new DbIntegrityError(
				"NONTERMINAL workflow lifecycle carries terminal metadata",
			);
		}
		return {
			incarnationId: row.incarnation_id,
			status: WORKFLOW_STATUS_NONTERMINAL,
			terminalKind: null,
			terminalAtEpochMs: null,
		};
	}
	if (row.lifecycle_status !== WORKFLOW_STATUS_TERMINAL) {
		throw new DbIntegrityError(
			`unrecognized workflow lifecycle status: ${row.lifecycle_status}`,
		);
	}
	if (
		row.terminal_kind === null ||
		!isWorkflowTerminalKind(row.terminal_kind) ||
		row.terminal_at_epoch_ms === null ||
		!Number.isSafeInteger(row.terminal_at_epoch_ms) ||
		row.terminal_at_epoch_ms < 0
	) {
		throw new DbIntegrityError("TERMINAL workflow lifecycle is incoherent");
	}
	return {
		incarnationId: row.incarnation_id,
		status: WORKFLOW_STATUS_TERMINAL,
		terminalKind: row.terminal_kind,
		terminalAtEpochMs: row.terminal_at_epoch_ms,
	};
}

/** Establish the initial NONTERMINAL lifecycle inside the bootstrap transaction. */
export function ensureWorkflowLifecycleRowInTransaction(
	db: SqliteConnection,
	incarnationId: string,
): void {
	db.prepare(`INSERT OR IGNORE INTO run_workflow_lifecycle
		 (singleton, incarnation_id, lifecycle_status)
		 VALUES (1, ?, ?)`).run(incarnationId, WORKFLOW_STATUS_NONTERMINAL);
	const lifecycle = readWorkflowLifecycleRow(db, incarnationId);
	if (lifecycle === null) {
		throw new DbIntegrityError("workflow lifecycle row missing after ensure");
	}
}

/** Irreversibly terminalize a workflow inside its authoritative state commit. */
export function transitionWorkflowToTerminalInTransaction(
	db: SqliteConnection,
	incarnationId: string,
	terminalKind: WorkflowCompletionKind,
	terminalAtEpochMs: number,
): void {
	if (!Number.isSafeInteger(terminalAtEpochMs) || terminalAtEpochMs < 0) {
		throw new DbIntegrityError("workflow terminal timestamp is invalid");
	}
	const result = db
		.prepare(`UPDATE run_workflow_lifecycle
		 SET lifecycle_status = ?,
		     terminal_kind = ?,
		     terminal_at_epoch_ms = ?
		 WHERE singleton = 1
		   AND incarnation_id = ?
		   AND lifecycle_status = ?`)
		.run(
			WORKFLOW_STATUS_TERMINAL,
			terminalKind,
			terminalAtEpochMs,
			incarnationId,
			WORKFLOW_STATUS_NONTERMINAL,
		);
	if (result.changes !== 1) {
		throw new DbIntegrityError(
			`workflow terminal transition affected ${result.changes} rows — expected exactly 1`,
		);
	}
}

export type WorkflowRetentionEligibility =
	| { readonly kind: "ELIGIBLE" }
	| { readonly kind: "WORKFLOW_NOT_TERMINAL" }
	| {
			readonly kind: "RETENTION_WINDOW";
			readonly terminalAtEpochMs: number;
	  };

/** Evaluate terminality and durable retention age under BEGIN IMMEDIATE. */
export function evaluateWorkflowRetentionEligibilityInTransaction(
	db: SqliteConnection,
	incarnationId: string,
	retentionThresholdEpochMs: number,
): WorkflowRetentionEligibility {
	const lifecycle = readWorkflowLifecycleRow(db, incarnationId);
	if (lifecycle === null) {
		throw new DbIntegrityError("workflow lifecycle row missing");
	}
	if (lifecycle.status === WORKFLOW_STATUS_NONTERMINAL) {
		return { kind: "WORKFLOW_NOT_TERMINAL" };
	}
	if (lifecycle.terminalAtEpochMs > retentionThresholdEpochMs) {
		return {
			kind: "RETENTION_WINDOW",
			terminalAtEpochMs: lifecycle.terminalAtEpochMs,
		};
	}
	return { kind: "ELIGIBLE" };
}
