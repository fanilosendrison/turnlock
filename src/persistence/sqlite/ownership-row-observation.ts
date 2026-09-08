import { DbIntegrityError } from "./errors.js";
import type { OwnershipPredecessor } from "./ownership-contracts.js";
import type { SqliteConnection } from "./sqlite-driver.js";

export function bigintFromOwnershipRow(value: unknown): bigint {
	if (typeof value === "bigint") return value;
	if (typeof value === "number") return BigInt(value);
	throw new DbIntegrityError(`expected bigint, got ${typeof value}`);
}

/** The single definition of a live ownership lease. */
export function isLiveLease(params: {
	readonly status: string;
	readonly leaseUntilEpochMs: number | null;
	readonly nowEpochMs: number;
}): boolean {
	return (
		params.status === "HELD" &&
		params.leaseUntilEpochMs !== null &&
		params.nowEpochMs < params.leaseUntilEpochMs
	);
}

/** Live-lease decision for a full ownership predecessor snapshot. */
export function isOwnershipLive(
	predecessor: OwnershipPredecessor | null,
	nowEpochMs: number,
): predecessor is OwnershipPredecessor & {
	readonly status: "HELD";
	readonly leaseUntilEpochMs: number;
} {
	return (
		predecessor !== null &&
		isLiveLease({
			status: predecessor.status,
			leaseUntilEpochMs: predecessor.leaseUntilEpochMs,
			nowEpochMs,
		})
	);
}

/** Read the ownership singleton row without any transaction or mutation. */
export function readOwnershipPredecessor(
	db: SqliteConnection,
): OwnershipPredecessor | null {
	const row = db
		.prepare(`SELECT incarnation_id, ownership_status, owner_token,
			        owner_pid, acquired_at_epoch_ms,
			        fence_token, lease_until_epoch_ms
			 FROM run_ownership
			 WHERE singleton = 1`)
		.get() as
		| {
				incarnation_id: string;
				ownership_status: string;
				owner_token: string | null;
				owner_pid: number | null;
				acquired_at_epoch_ms: number | null;
				fence_token: number | bigint;
				lease_until_epoch_ms: number | null;
		  }
		| undefined;
	if (row === undefined) return null;
	return {
		incarnationId: row.incarnation_id,
		status: row.ownership_status as "FREE" | "HELD",
		ownerToken: row.owner_token,
		ownerPid: row.owner_pid,
		acquiredAtEpochMs: row.acquired_at_epoch_ms,
		fenceToken: bigintFromOwnershipRow(row.fence_token),
		leaseUntilEpochMs: row.lease_until_epoch_ms,
	};
}

/** Read the current incarnation_id from the ownership row. */
export function readOwnershipIncarnationId(
	db: SqliteConnection,
): string | null {
	const row = db
		.prepare("SELECT incarnation_id FROM run_ownership WHERE singleton = 1")
		.get() as { incarnation_id: string } | undefined;
	return row?.incarnation_id ?? null;
}
