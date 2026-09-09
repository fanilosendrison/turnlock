import type { TerminalDoneRecord } from "../../types/artifacts.js";
import type { LockHandle } from "./ownership-contracts.js";
import type { SqliteConnection } from "./sqlite-driver.js";
import type { WorkflowCompletionKind } from "./workflow-lifecycle.js";

export interface StateAuthorityMetadata {
	readonly runIncarnationId: string;
	readonly stateRevision: string;
	readonly committedFenceToken: string;
}

/** Internal crash boundaries for the repairable state.json projection. */
export type ProjectionFaultPoint =
	| "AFTER_TEMP_FILE_WRITE"
	| "AFTER_TEMP_FILE_FSYNC"
	| "AFTER_RENAME"
	| "BEFORE_DIRECTORY_FSYNC";

/** Internal-only dependencies used by crash-injection tests. */
export interface ProjectionInternalDependencies {
	readonly onFaultPoint?: (point: ProjectionFaultPoint) => void;
}

export interface StateRecord<S extends object> {
	readonly schemaVersion: number;
	readonly runId: string;
	readonly orchestratorName: string;
	readonly startedAt: string;
	readonly startedAtEpochMs: number;
	readonly lastTransitionAt: string;
	readonly lastTransitionAtEpochMs: number;
	readonly currentPhase: string;
	readonly phasesExecuted: number;
	readonly accumulatedDurationMs: number;
	readonly data: S;
	readonly pendingDelegation?: unknown;
	readonly pendingExternalRequest?: unknown;
	readonly terminalResult?: TerminalDoneRecord;
	readonly usedLabels: readonly string[];
	readonly runIncarnationId: string;
	readonly stateRevision: string;
	readonly committedFenceToken: string;
}

export interface CommittedState<S extends object> {
	readonly state: StateRecord<S>;
	readonly stateDigest: string;
}

export interface CommitStateParams<S extends object> {
	readonly db: SqliteConnection;
	readonly handle: LockHandle;
	readonly expectedRevision: string;
	readonly nextState: StateRecord<S>;
	readonly nowEpochMs: number;
	readonly nowIso: string;
	readonly leaseClockEpochMs?: () => number;
	/** Explicit irreversible workflow transition committed with this state. */
	readonly terminalKind?: WorkflowCompletionKind;
}

export type CommitStateResult =
	| { readonly kind: "COMMITTED"; readonly committed: CommittedState<object> }
	| { readonly kind: "STALE_HANDLE" }
	| { readonly kind: "EXPIRED_HANDLE" }
	| { readonly kind: "REVISION_CONFLICT" }
	| { readonly kind: "WORKFLOW_TERMINAL" }
	| { readonly kind: "DB_FAILURE"; readonly cause: unknown };

export interface ClaimInitialDispatchParams {
	readonly db: SqliteConnection;
	readonly handle: LockHandle;
	readonly leaseClockEpochMs?: () => number;
}

export type ClaimInitialDispatchResult =
	| { readonly kind: "CLAIMED"; readonly committed: CommittedState<object> }
	| { readonly kind: "INITIAL_DISPATCH_NOT_PENDING" }
	| { readonly kind: "STALE_HANDLE" }
	| { readonly kind: "EXPIRED_HANDLE" }
	| { readonly kind: "REVISION_CONFLICT" }
	| { readonly kind: "DB_FAILURE"; readonly cause: unknown };

export type InitializeStateResult =
	| {
			readonly kind: "INITIALIZED";
			readonly committed: CommittedState<object>;
	  }
	| {
			readonly kind: "ALREADY_INITIALIZED";
			readonly state: StateRecord<object>;
			readonly digest: string;
	  }
	| { readonly kind: "STALE_HANDLE" }
	| { readonly kind: "EXPIRED_HANDLE" }
	| { readonly kind: "DB_FAILURE"; readonly cause: unknown };

export interface InitializeStateParams {
	readonly db: SqliteConnection;
	readonly handle: LockHandle;
	readonly initialState: Record<string, unknown>;
	readonly nowEpochMs: number;
	readonly nowIso: string;
	readonly leaseClockEpochMs?: () => number;
}

export interface ReadStateResult<S extends object> {
	readonly state: StateRecord<S> | null;
	readonly digest: string | null;
	/** Durable evidence that a new-run bootstrap has not committed a phase. */
	readonly pendingInitialDispatch: boolean;
}
