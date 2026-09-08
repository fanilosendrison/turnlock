import { DbIntegrityError } from "./errors.js";
import type {
	OwnershipOperationResult,
	RefreshParams,
	ReleaseParams,
} from "./ownership-contracts.js";
import {
	bigintFromOwnershipRow,
	readOwnershipPredecessor,
} from "./ownership-row-observation.js";
import { beginImmediate, commit, rollback } from "./ownership-transactions.js";

interface OwnershipMutationRow {
	incarnation_id: string;
	owner_token: string;
	fence_token: number | bigint;
	lease_until_epoch_ms: number;
}

const REFRESH_SQL = `
UPDATE run_ownership
SET lease_until_epoch_ms = :new_lease
WHERE singleton = 1
  AND ownership_status = 'HELD'
  AND incarnation_id = :incarnation_id
  AND owner_token = :owner_token
  AND fence_token = :fence_token
  AND lease_until_epoch_ms > :now_epoch
RETURNING incarnation_id, owner_token, fence_token, lease_until_epoch_ms
`;

export function refreshOwnership(
	params: RefreshParams,
): OwnershipOperationResult {
	const { db, handle, nowEpochMs: _nowEpochMs, leaseDurationMs } = params;
	try {
		beginImmediate(db);
	} catch (error) {
		return { kind: "DB_FAILURE", cause: error };
	}
	const lockEpochMs = (params.leaseClockEpochMs ?? Date.now)();
	try {
		const row = db.prepare(REFRESH_SQL).get({
			":new_lease": lockEpochMs + leaseDurationMs,
			":incarnation_id": handle.incarnationId,
			":owner_token": handle.ownerToken,
			":fence_token": handle.fenceToken,
			":now_epoch": lockEpochMs,
		}) as OwnershipMutationRow | undefined;
		if (row === undefined) {
			rollback(db);
			const current = readOwnershipPredecessor(db);
			if (current === null) {
				return {
					kind: "DB_FAILURE",
					cause: new DbIntegrityError("ownership row missing"),
				};
			}
			if (
				current.status === "HELD" &&
				current.incarnationId === handle.incarnationId &&
				current.ownerToken === handle.ownerToken &&
				current.fenceToken === handle.fenceToken &&
				current.leaseUntilEpochMs !== null &&
				lockEpochMs >= current.leaseUntilEpochMs
			) {
				return { kind: "EXPIRED_HANDLE" };
			}
			return { kind: "STALE_HANDLE" };
		}
		try {
			commit(db);
		} catch (error) {
			rollback(db);
			return { kind: "DB_FAILURE", cause: error };
		}
		return {
			kind: "SUCCESS",
			handle: {
				ownerToken: row.owner_token,
				incarnationId: row.incarnation_id,
				fenceToken: bigintFromOwnershipRow(row.fence_token),
				leaseUntilEpochMs: row.lease_until_epoch_ms,
			},
		};
	} catch (error) {
		rollback(db);
		return { kind: "DB_FAILURE", cause: error };
	}
}

const RELEASE_SQL = `
UPDATE run_ownership
SET
    ownership_status = 'FREE',
    owner_token = NULL,
    owner_pid = NULL,
    acquired_at_epoch_ms = NULL,
    lease_until_epoch_ms = NULL
WHERE singleton = 1
  AND ownership_status = 'HELD'
  AND incarnation_id = :incarnation_id
  AND owner_token = :owner_token
  AND fence_token = :fence_token
RETURNING fence_token
`;

export function releaseOwnership(
	params: ReleaseParams,
): OwnershipOperationResult {
	const { db, handle } = params;
	try {
		beginImmediate(db);
	} catch (error) {
		return { kind: "DB_FAILURE", cause: error };
	}
	try {
		const row = db.prepare(RELEASE_SQL).get({
			":incarnation_id": handle.incarnationId,
			":owner_token": handle.ownerToken,
			":fence_token": handle.fenceToken,
		}) as { fence_token: number | bigint } | undefined;
		if (row === undefined) {
			rollback(db);
			return { kind: "STALE_HANDLE" };
		}
		try {
			commit(db);
		} catch (error) {
			rollback(db);
			return { kind: "DB_FAILURE", cause: error };
		}
		return {
			kind: "SUCCESS",
			handle: {
				...handle,
				fenceToken: bigintFromOwnershipRow(row.fence_token),
			},
		};
	} catch (error) {
		rollback(db);
		return { kind: "DB_FAILURE", cause: error };
	}
}
