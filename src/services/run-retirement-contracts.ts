import type { RunDatabaseFilesystemIdentity } from "../persistence/sqlite/retention-claim.js";
import type { SqliteDriver } from "../persistence/sqlite/sqlite-driver.js";

/** Closed set of internal retirement fault points reserved for tests. */
export type RunRetirementFaultPoint =
	| "AFTER_PRE_RENAME_VERIFICATION"
	| "AFTER_RENAME_BEFORE_POSTCHECK";

/** Test-only dependencies. Production retirement never injects faults. */
export interface RunRetirementInternalDependencies {
	readonly onFaultPoint?: (point: RunRetirementFaultPoint) => void;
}

/** Outcome of retiring and deleting one canonical RUN_DIR candidate. */
export type RunRetirementOutcome =
	| { readonly kind: "DELETED" }
	| {
			readonly kind: "DETACHED_PENDING_SWEEP";
			readonly retirementToken: string;
	  }
	| {
			readonly kind: "KEPT";
			readonly reason:
				| "LIVE_OWNER"
				| "UNKNOWN"
				| "DB_FAILURE"
				| "DB_CONTENTION_TIMEOUT"
				| "IDENTITY_MISMATCH"
				| "NAMESPACE_MUTEX_FAILURE"
				| "FILESYSTEM_FAILURE";
	  };

export type RenameRunDirectoryResult =
	| { readonly kind: "RENAMED"; readonly retiredPath: string }
	| { readonly kind: "MISMATCH" }
	| { readonly kind: "DETACHED_UNREADY"; readonly retiredPath: string };

export interface RenameRunDirectoryParams {
	readonly driver: SqliteDriver;
	readonly runDir: string;
	readonly runId: string;
	readonly retirementToken: string;
	readonly incarnationId: string;
	readonly expectedOrchestratorName?: string;
	readonly databaseIdentity: RunDatabaseFilesystemIdentity | null;
}

export interface RetireRunDirectoryParams {
	readonly driver: SqliteDriver;
	readonly runDir: string;
	readonly runId: string;
	readonly orchestratorName?: string;
}

/** Filesystem retirement delegate used by retention candidate discovery. */
export interface RunDirRetirement {
	readonly retireRunDirectory: (
		runDir: string,
		runId: string,
		orchestratorName?: string,
	) => RunRetirementOutcome;
	readonly sweepRetiredDirectories: (
		retiredRoot: string,
		orchestratorName: string,
	) => number;
}

export type KeptReason = Extract<
	RunRetirementOutcome,
	{ kind: "KEPT" }
>["reason"];

export type RetireUnderMutexResult =
	| { readonly kind: "KEPT"; readonly reason: KeptReason }
	| {
			readonly kind: "DETACHED";
			readonly retiredPath: string;
			readonly retirementToken: string;
			readonly readyPublished: boolean;
	  };
