import type { SqliteDriver } from "./sqlite-driver.js";

/** Filesystem identity of the directory and database a claim referred to. */
export interface RunDatabaseFilesystemIdentity {
	/** Decimal strings preserve device and inode values exactly. */
	readonly dirDev: string;
	readonly dirIno: string;
	readonly dbDev: string;
	readonly dbIno: string;
}

export type RunRetentionClaimResult =
	| {
			readonly kind: "CLAIMED";
			readonly fenceToken: bigint;
			readonly runId: string;
			readonly incarnationId: string;
			readonly orchestratorName: string;
			readonly retirementToken: string;
			readonly retirementClaimedAtEpochMs: number;
			readonly databaseIdentity: RunDatabaseFilesystemIdentity | null;
	  }
	| {
			readonly kind: "ALREADY_RETIRING";
			readonly runId: string;
			readonly incarnationId: string;
			readonly orchestratorName: string;
			readonly retirementToken: string;
			readonly retirementClaimedAtEpochMs: number;
			readonly databaseIdentity: RunDatabaseFilesystemIdentity | null;
	  }
	| {
			readonly kind: "LIVE_OWNER";
			readonly leaseUntilEpochMs: number;
	  }
	| {
			readonly kind: "NOT_ELIGIBLE";
			readonly reason: "WORKFLOW_NOT_TERMINAL" | "RETENTION_WINDOW";
	  }
	| { readonly kind: "UNKNOWN"; readonly reason: string }
	| { readonly kind: "DB_CONTENTION_TIMEOUT" }
	| { readonly kind: "DB_FAILURE"; readonly cause: unknown };

export interface ClaimRunForRetentionDeletionParams {
	readonly driver: SqliteDriver;
	readonly dbPath: string;
	readonly runId: string;
	readonly expectedOrchestratorName?: string;
	readonly busyTimeoutMs: number;
	readonly contentionDeadlineMs: number;
	/** Durable terminal time must be at or before this cleanup-pass cutoff. */
	readonly retentionThresholdEpochMs: number;
	readonly leaseClockEpochMs?: () => number;
}
