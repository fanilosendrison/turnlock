import type { SqliteConnection } from "./sqlite-driver.js";

export interface LockHandle {
	readonly ownerToken: string;
	readonly incarnationId: string;
	readonly fenceToken: bigint;
	readonly leaseUntilEpochMs: number;
}

export interface OwnershipPredecessor {
	readonly incarnationId: string;
	readonly status: "FREE" | "HELD";
	readonly ownerToken: string | null;
	readonly ownerPid: number | null;
	readonly acquiredAtEpochMs: number | null;
	readonly fenceToken: bigint;
	readonly leaseUntilEpochMs: number | null;
}

export type AcquireResult =
	| { readonly kind: "ACQUIRED"; readonly handle: LockHandle }
	| {
			readonly kind: "ACTIVE_CONFLICT";
			readonly ownerPid: number;
			readonly leaseUntilEpochMs: number;
	  }
	| { readonly kind: "RUN_RETIRING" }
	| { readonly kind: "PREDECESSOR_CAS_MISS" }
	| { readonly kind: "DB_CONTENTION_TIMEOUT" }
	| { readonly kind: "DB_FAILURE"; readonly cause: unknown };

export interface AcquireParams {
	readonly db: SqliteConnection;
	readonly runId: string;
	readonly orchestratorName: string;
	readonly nowEpochMs: number;
	readonly nowIso: string;
	readonly leaseDurationMs: number;
	readonly contentionDeadlineMs: number;
	/** Optional clock for lease-critical timestamp capture after
	 * BEGIN IMMEDIATE. Defaults to `Date.now`. */
	readonly leaseClockEpochMs?: () => number;
}

export type AcquireOwnershipDirectInTransactionResult =
	| {
			readonly kind: "ACQUIRED";
			readonly fenceToken: bigint;
			readonly leaseUntilEpochMs: number;
	  }
	| { readonly kind: "ACTIVE_CONFLICT" }
	| { readonly kind: "RUN_RETIRING" };

export type LiveOwnershipVerification =
	| { readonly kind: "LIVE" }
	| { readonly kind: "STALE_HANDLE" }
	| { readonly kind: "EXPIRED_HANDLE" }
	| { readonly kind: "RETIRING" };

export type OwnershipOperationResult =
	| { readonly kind: "SUCCESS"; readonly handle: LockHandle }
	| { readonly kind: "STALE_HANDLE" }
	| { readonly kind: "EXPIRED_HANDLE" }
	| { readonly kind: "DB_FAILURE"; readonly cause: unknown };

export interface RefreshParams {
	readonly db: SqliteConnection;
	readonly handle: LockHandle;
	readonly nowEpochMs: number;
	readonly leaseDurationMs: number;
	/** Optional clock for lease-critical timestamp capture after
	 * BEGIN IMMEDIATE. Defaults to `Date.now`. */
	readonly leaseClockEpochMs?: () => number;
}

export interface ReleaseParams {
	readonly db: SqliteConnection;
	readonly handle: LockHandle;
}
