import { generateRunId } from "../../services/run-id.js";
import { DbIntegrityError } from "./errors.js";
import type { SqliteConnection } from "./sqlite-driver.js";

interface IncarnationRow {
	run_id: string;
	incarnation_id: string;
	orchestrator_name: string;
}

function validateIncarnation(
	row: IncarnationRow,
	runId: string,
	orchestratorName: string,
	raceSuffix: string,
): string {
	if (row.run_id !== runId) {
		throw new DbIntegrityError(
			`run_incarnation run_id mismatch${raceSuffix}: expected ${runId}, got ${row.run_id}`,
		);
	}
	if (row.orchestrator_name !== orchestratorName) {
		throw new DbIntegrityError(
			`run_incarnation orchestrator_name mismatch${raceSuffix}: expected ${orchestratorName}, got ${row.orchestrator_name}`,
		);
	}
	return row.incarnation_id;
}

function readIncarnation(db: SqliteConnection): IncarnationRow | undefined {
	return db
		.prepare(
			"SELECT run_id, incarnation_id, orchestrator_name FROM run_incarnation WHERE singleton = 1",
		)
		.get() as IncarnationRow | undefined;
}

function insertIncarnation(
	db: SqliteConnection,
	runId: string,
	incarnationId: string,
	orchestratorName: string,
	nowEpochMs: number,
	nowIso: string,
): void {
	db.prepare(`INSERT OR IGNORE INTO run_incarnation
		 (singleton, run_id, incarnation_id, orchestrator_name,
		  created_at_epoch_ms, created_at_iso)
		 VALUES (1, ?, ?, ?, ?, ?)`).run(
		runId,
		incarnationId,
		orchestratorName,
		nowEpochMs,
		nowIso,
	);
}

export function ensureIncarnation(
	db: SqliteConnection,
	runId: string,
	orchestratorName: string,
	nowEpochMs: number,
	nowIso: string,
): string {
	const existing = readIncarnation(db);
	if (existing !== undefined) {
		return validateIncarnation(existing, runId, orchestratorName, "");
	}
	const incarnationId = generateRunId();
	insertIncarnation(
		db,
		runId,
		incarnationId,
		orchestratorName,
		nowEpochMs,
		nowIso,
	);
	const inserted = readIncarnation(db);
	if (inserted !== undefined) {
		return validateIncarnation(
			inserted,
			runId,
			orchestratorName,
			" after race",
		);
	}
	return incarnationId;
}

export function ensureOwnershipRow(
	db: SqliteConnection,
	incarnationId: string,
): void {
	db.prepare(`INSERT OR IGNORE INTO run_ownership
		 (singleton, incarnation_id, ownership_status,
		  fence_token)
		 VALUES (1, ?, 'FREE', 0)`).run(incarnationId);
}

/** Ensure the incarnation row exists within an active transaction. */
export function ensureIncarnationInTransaction(
	db: SqliteConnection,
	runId: string,
	incarnationCandidate: string,
	orchestratorName: string,
	nowEpochMs: number,
	nowIso: string,
): string {
	const existing = readIncarnation(db);
	if (existing !== undefined) {
		return validateIncarnation(existing, runId, orchestratorName, "");
	}
	insertIncarnation(
		db,
		runId,
		incarnationCandidate,
		orchestratorName,
		nowEpochMs,
		nowIso,
	);
	const inserted = readIncarnation(db);
	if (inserted !== undefined) {
		return validateIncarnation(
			inserted,
			runId,
			orchestratorName,
			" after race",
		);
	}
	return incarnationCandidate;
}

/** Ensure and validate the ownership singleton inside an active transaction. */
export function ensureOwnershipRowInTransaction(
	db: SqliteConnection,
	incarnationId: string,
): void {
	ensureOwnershipRow(db, incarnationId);
	const existing = db
		.prepare("SELECT incarnation_id FROM run_ownership WHERE singleton = 1")
		.get() as { incarnation_id: string } | undefined;
	if (existing !== undefined && existing.incarnation_id !== incarnationId) {
		throw new DbIntegrityError(
			`run_ownership incarnation_id mismatch: expected ${incarnationId}, got ${existing.incarnation_id}`,
		);
	}
}
