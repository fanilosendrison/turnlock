import { generateRunId } from "../../services/run-id.js";
import { DbIntegrityError } from "./errors.js";
import {
	ensureIncarnation,
	ensureOwnershipRow,
} from "./ownership-bootstrap.js";
import type {
	AcquireOwnershipDirectInTransactionResult,
	AcquireParams,
	AcquireResult,
	OwnershipPredecessor,
} from "./ownership-contracts.js";
import {
	bigintFromOwnershipRow,
	isLiveLease,
	isOwnershipLive,
	readOwnershipPredecessor,
} from "./ownership-row-observation.js";
import {
	beginImmediate,
	commit,
	isSqliteBusyError,
	rollback,
} from "./ownership-transactions.js";
import {
	ensureRetentionRowInTransaction,
	RETENTION_STATUS_RETIRING,
	readRetentionStatus,
} from "./retention-state.js";
import type { SqliteConnection } from "./sqlite-driver.js";

const CAS_SQL = `
UPDATE run_ownership
SET
    ownership_status    = 'HELD',
    owner_token         = :new_owner_token,
    owner_pid           = :new_owner_pid,
    fence_token         = fence_token + 1,
    acquired_at_epoch_ms = :now_epoch,
    lease_until_epoch_ms = :lease_until
WHERE singleton = 1
  AND incarnation_id     = :incarnation_id
  AND ownership_status   = :prev_status
  AND fence_token        = :prev_fence
  AND owner_token        IS :prev_owner_token
  AND lease_until_epoch_ms IS :prev_lease
RETURNING incarnation_id, owner_token, fence_token, lease_until_epoch_ms
`;

interface CasRow {
	incarnation_id: string;
	owner_token: string;
	fence_token: number | bigint;
	lease_until_epoch_ms: number;
}

function attemptCas(
	db: SqliteConnection,
	incarnationId: string,
	predecessor: OwnershipPredecessor,
	ownerToken: string,
	ownerPid: number,
	nowEpochMs: number,
	leaseDurationMs: number,
): CasRow | null {
	const row = db.prepare(CAS_SQL).get({
		":new_owner_token": ownerToken,
		":new_owner_pid": ownerPid,
		":now_epoch": nowEpochMs,
		":lease_until": nowEpochMs + leaseDurationMs,
		":incarnation_id": incarnationId,
		":prev_status": predecessor.status,
		":prev_fence": predecessor.fenceToken,
		":prev_owner_token": predecessor.ownerToken,
		":prev_lease": predecessor.leaseUntilEpochMs,
	}) as CasRow | undefined;
	return row ?? null;
}

/** Directly set ownership to HELD within an active transaction. */
export function acquireOwnershipDirectInTransaction(
	db: SqliteConnection,
	incarnationId: string,
	ownerToken: string,
	ownerPid: number,
	nowEpochMs: number,
	leaseDurationMs: number,
): AcquireOwnershipDirectInTransactionResult {
	ensureRetentionRowInTransaction(db);
	const retentionStatus = readRetentionStatus(db);
	if (retentionStatus === RETENTION_STATUS_RETIRING) {
		return { kind: "RUN_RETIRING" };
	}
	if (retentionStatus === null) {
		throw new DbIntegrityError(
			"retention state missing or unrecognized — acquisition refused",
		);
	}
	const row = db
		.prepare(
			"SELECT ownership_status, fence_token, lease_until_epoch_ms FROM run_ownership WHERE singleton = 1 AND incarnation_id = ?",
		)
		.get(incarnationId) as
		| {
				ownership_status: string;
				fence_token: number | bigint;
				lease_until_epoch_ms: number | null;
		  }
		| undefined;
	if (row === undefined) {
		throw new DbIntegrityError("ownership row missing in transaction");
	}
	if (
		isLiveLease({
			status: row.ownership_status,
			leaseUntilEpochMs: row.lease_until_epoch_ms,
			nowEpochMs,
		})
	) {
		return { kind: "ACTIVE_CONFLICT" };
	}
	const newFence = bigintFromOwnershipRow(row.fence_token) + 1n;
	const leaseUntil = nowEpochMs + leaseDurationMs;
	db.prepare(`UPDATE run_ownership
		 SET ownership_status = 'HELD',
		     owner_token = ?,
		     owner_pid = ?,
		     fence_token = ?,
		     acquired_at_epoch_ms = ?,
		     lease_until_epoch_ms = ?
		 WHERE singleton = 1
		   AND incarnation_id = ?`).run(
		ownerToken,
		ownerPid,
		newFence,
		nowEpochMs,
		leaseUntil,
		incarnationId,
	);
	return {
		kind: "ACQUIRED",
		fenceToken: newFence,
		leaseUntilEpochMs: leaseUntil,
	};
}

/** Acquire ownership with CAS semantics. */
export function acquireOwnership(params: AcquireParams): AcquireResult {
	const {
		db,
		runId,
		orchestratorName,
		nowEpochMs,
		nowIso,
		leaseDurationMs,
		contentionDeadlineMs,
	} = params;
	const deadlineMs = performance.now() + contentionDeadlineMs;
	const incarnationId = ensureIncarnation(
		db,
		runId,
		orchestratorName,
		nowEpochMs,
		nowIso,
	);
	ensureOwnershipRow(db, incarnationId);
	const predecessor = readOwnershipPredecessor(db);
	if (predecessor === null) {
		return {
			kind: "DB_FAILURE",
			cause: new DbIntegrityError("ownership row missing"),
		};
	}
	if (isOwnershipLive(predecessor, Date.now())) {
		const ownerRow = db
			.prepare("SELECT owner_pid FROM run_ownership WHERE singleton = 1")
			.get() as { owner_pid: number } | undefined;
		return {
			kind: "ACTIVE_CONFLICT",
			ownerPid: ownerRow?.owner_pid ?? 0,
			leaseUntilEpochMs: predecessor.leaseUntilEpochMs,
		};
	}
	const ownerToken = generateRunId();
	const ownerPid = process.pid;
	const maxAttempts = 10;
	for (let attempt = 0; attempt < maxAttempts; attempt++) {
		if (performance.now() > deadlineMs) break;
		const currentPredecessor = readOwnershipPredecessor(db);
		if (currentPredecessor === null) {
			return {
				kind: "DB_FAILURE",
				cause: new DbIntegrityError("ownership row missing during retry"),
			};
		}
		try {
			beginImmediate(db);
		} catch (error) {
			if (isSqliteBusyError(error)) continue;
			rollback(db);
			return { kind: "DB_FAILURE", cause: error };
		}
		const lockEpochMs = (params.leaseClockEpochMs ?? Date.now)();
		ensureRetentionRowInTransaction(db);
		const retentionStatus = readRetentionStatus(db);
		if (retentionStatus === RETENTION_STATUS_RETIRING) {
			rollback(db);
			return { kind: "RUN_RETIRING" };
		}
		if (retentionStatus === null) {
			rollback(db);
			return {
				kind: "DB_FAILURE",
				cause: new DbIntegrityError(
					"retention state missing or unrecognized — acquisition refused",
				),
			};
		}
		if (isOwnershipLive(currentPredecessor, lockEpochMs)) {
			rollback(db);
			const ownerRow = db
				.prepare("SELECT owner_pid FROM run_ownership WHERE singleton = 1")
				.get() as { owner_pid: number } | undefined;
			return {
				kind: "ACTIVE_CONFLICT",
				ownerPid: ownerRow?.owner_pid ?? 0,
				leaseUntilEpochMs: currentPredecessor.leaseUntilEpochMs,
			};
		}
		let casRow: CasRow | null;
		try {
			casRow = attemptCas(
				db,
				incarnationId,
				currentPredecessor,
				ownerToken,
				ownerPid,
				lockEpochMs,
				leaseDurationMs,
			);
		} catch (error) {
			rollback(db);
			if (isSqliteBusyError(error)) continue;
			return { kind: "DB_FAILURE", cause: error };
		}
		if (casRow === null) {
			rollback(db);
			continue;
		}
		try {
			commit(db);
		} catch (error) {
			rollback(db);
			if (isSqliteBusyError(error)) continue;
			return { kind: "DB_FAILURE", cause: error };
		}
		return {
			kind: "ACQUIRED",
			handle: {
				ownerToken: casRow.owner_token,
				incarnationId: casRow.incarnation_id,
				fenceToken: bigintFromOwnershipRow(casRow.fence_token),
				leaseUntilEpochMs: casRow.lease_until_epoch_ms,
			},
		};
	}
	const finalPredecessor = readOwnershipPredecessor(db);
	if (
		finalPredecessor !== null &&
		finalPredecessor.fenceToken !== predecessor.fenceToken
	) {
		return { kind: "PREDECESSOR_CAS_MISS" };
	}
	return { kind: "DB_CONTENTION_TIMEOUT" };
}
