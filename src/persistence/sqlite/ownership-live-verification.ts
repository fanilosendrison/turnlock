import { DbIntegrityError } from "./errors.js";
import type {
	LiveOwnershipVerification,
	LockHandle,
} from "./ownership-contracts.js";
import {
	RETENTION_STATUS_RETIRING,
	readRetentionStatus,
} from "./retention-state.js";
import type { SqliteConnection } from "./sqlite-driver.js";

/** Verify live ownership inside an active run-local write transaction. */
export function verifyLiveOwnershipInTransaction(
	db: SqliteConnection,
	handle: LockHandle,
	nowEpochMs: number,
): LiveOwnershipVerification {
	const retentionStatus = readRetentionStatus(db);
	if (retentionStatus === RETENTION_STATUS_RETIRING) {
		return { kind: "RETIRING" };
	}
	if (retentionStatus === null) {
		throw new DbIntegrityError(
			"retention state missing or unrecognized — fenced filesystem operation refused",
		);
	}
	const row = db
		.prepare(`SELECT ownership_status, incarnation_id, owner_token,
			        fence_token, lease_until_epoch_ms
			 FROM run_ownership WHERE singleton = 1`)
		.get() as
		| {
				ownership_status: string;
				incarnation_id: string;
				owner_token: string;
				fence_token: number | bigint;
				lease_until_epoch_ms: number | null;
		  }
		| undefined;
	if (row === undefined) {
		throw new DbIntegrityError(
			"ownership row missing — fenced filesystem operation refused",
		);
	}
	if (row.ownership_status !== "HELD") return { kind: "STALE_HANDLE" };
	if (row.incarnation_id !== handle.incarnationId) {
		return { kind: "STALE_HANDLE" };
	}
	if (row.owner_token !== handle.ownerToken) return { kind: "STALE_HANDLE" };
	const rowFence =
		typeof row.fence_token === "bigint"
			? row.fence_token
			: BigInt(row.fence_token);
	if (rowFence !== handle.fenceToken) return { kind: "STALE_HANDLE" };
	if (
		row.lease_until_epoch_ms === null ||
		nowEpochMs >= row.lease_until_epoch_ms
	) {
		return { kind: "EXPIRED_HANDLE" };
	}
	return { kind: "LIVE" };
}
