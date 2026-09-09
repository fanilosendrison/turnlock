import { generateRunId } from "../../services/run-id.js";
import type { LockHandle } from "./ownership.js";
import type { SqliteConnection } from "./sqlite-driver.js";

/** Closed set of fault points for bootstrap atomicity tests. */
export type BootstrapFaultPoint =
	| "AFTER_BEGIN"
	| "AFTER_INCARNATION_WRITE"
	| "AFTER_LIFECYCLE_WRITE"
	| "AFTER_OWNERSHIP_WRITE"
	| "AFTER_STATE_WRITE"
	| "BEFORE_COMMIT"
	| "AFTER_COMMIT_BEFORE_HANDLE";

/** Sentinel error for fault injection tests. */
export class InjectedBootstrapFailure extends Error {
	constructor(readonly point: BootstrapFaultPoint) {
		super(`Injected bootstrap failure at ${point}`);
		this.name = "InjectedBootstrapFailure";
	}
}

export interface RunBootstrapDependencies {
	readonly generateId: () => string;
}

export interface BootstrapInternalDependencies
	extends RunBootstrapDependencies {
	readonly onFaultPoint?: (point: BootstrapFaultPoint) => void;
}

export const productionDependencies: BootstrapInternalDependencies = {
	generateId: generateRunId,
};

export interface CommittedState {
	readonly state: Record<string, unknown>;
	readonly stateDigest: string;
	readonly stateRevision: string;
	readonly committedFenceToken: string;
	readonly incarnationId: string;
}

export interface BootstrapNewRunParams {
	readonly db: SqliteConnection;
	readonly runId: string;
	readonly orchestratorName: string;
	readonly nowEpochMs: number;
	readonly nowIso: string;
	readonly leaseDurationMs: number;
	/** Clock callback captured after BEGIN IMMEDIATE. */
	readonly leaseClockEpochMs?: () => number;
	readonly initialState: Record<string, unknown>;
	readonly stateSchemaVersion: number;
	readonly contentionDeadlineMs: number;
}

export type BootstrapNewRunResult =
	| {
			readonly kind: "BOOTSTRAPPED";
			readonly handle: LockHandle;
			readonly committed: CommittedState;
	  }
	| { readonly kind: "ALREADY_ESTABLISHED" }
	| {
			readonly kind: "ACTIVE_CONFLICT";
			readonly leaseUntilEpochMs: number;
	  }
	| { readonly kind: "RUN_RETIRING" }
	| {
			readonly kind: "INCOMPLETE_EXISTING_BOOTSTRAP";
			readonly details: string;
	  }
	| { readonly kind: "DB_CONTENTION_TIMEOUT" }
	| { readonly kind: "DB_FAILURE"; readonly cause: unknown };

export interface MigrateLegacyRunParams {
	readonly db: SqliteConnection;
	readonly runId: string;
	readonly orchestratorName: string;
	readonly nowEpochMs: number;
	readonly nowIso: string;
	readonly leaseDurationMs: number;
	/** Clock callback captured after BEGIN IMMEDIATE. */
	readonly leaseClockEpochMs?: () => number;
	readonly legacyState: Record<string, unknown>;
	readonly legacyStartedAtEpochMs: number;
	readonly legacyStartedAt: string;
	readonly legacyLastTransitionAtEpochMs: number;
	readonly legacyLastTransitionAt: string;
	readonly stateSchemaVersion: number;
	readonly contentionDeadlineMs: number;
}

export type MigrateLegacyRunResult =
	| {
			readonly kind: "MIGRATED";
			readonly handle: LockHandle;
			readonly committed: CommittedState;
	  }
	| { readonly kind: "ALREADY_ESTABLISHED" }
	| { readonly kind: "ACTIVE_CONFLICT" }
	| { readonly kind: "RUN_RETIRING" }
	| {
			readonly kind: "INCOMPLETE_EXISTING_BOOTSTRAP";
			readonly details: string;
	  }
	| { readonly kind: "DB_CONTENTION_TIMEOUT" }
	| { readonly kind: "DB_FAILURE"; readonly cause: unknown };
