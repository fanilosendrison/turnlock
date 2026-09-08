import type { STATE_SCHEMA_VERSION } from "../constants.js";
import type { MigrationBlockReason } from "../errors/concrete.js";
import type { ArtifactRef, TerminalDoneRecord } from "../types/artifacts.js";

export const LEGACY_STATE_SCHEMA_VERSION = 2 as const;
export const PREVIOUS_STATE_SCHEMA_VERSION = 3 as const;

export interface PendingDelegationRecord {
	readonly label: string;
	readonly kind: "prompt" | "batch";
	readonly resumeAt: string;
	/** v4+: immutable blob reference. Required for new writes. */
	readonly manifestArtifact?: ArtifactRef;
	/** @deprecated v3 field — still accepted at runtime for migration. */
	readonly manifestPath?: string;
	readonly emittedAtEpochMs: number;
	readonly deadlineAtEpochMs: number;
	readonly attempt: number;
	readonly effectiveRetryPolicy: {
		readonly maxAttempts: number;
		readonly backoffBaseMs: number;
		readonly maxBackoffMs: number;
	};
	readonly jobIds?: readonly string[];
}

export interface PendingExternalRequestRecord {
	readonly requestId: string;
	readonly label: string;
	readonly requestType: string;
	readonly resumeAt: string;
	/** v4+: immutable blob reference. Required for new writes. */
	readonly manifestArtifact?: ArtifactRef;
	/** @deprecated v3 fields — still accepted at runtime for migration. */
	readonly manifestPath?: string;
	/** @deprecated v3 field — still accepted at runtime for migration. */
	readonly manifestDigest?: string;
	readonly resultPath: string;
	readonly emittedAt: string;
	readonly emittedAtEpochMs: number;
	readonly acceptedResolutionPath?: string;
	readonly acceptedResolutionDigest?: string;
	readonly acceptedAt?: string;
}

export interface StateFile<State> {
	readonly schemaVersion: typeof STATE_SCHEMA_VERSION;
	readonly runId: string;
	readonly orchestratorName: string;
	readonly startedAt: string;
	readonly startedAtEpochMs: number;
	readonly lastTransitionAt: string;
	readonly lastTransitionAtEpochMs: number;
	readonly currentPhase: string;
	readonly phasesExecuted: number;
	readonly accumulatedDurationMs: number;
	readonly data: State;
	readonly pendingDelegation?: PendingDelegationRecord;
	readonly pendingExternalRequest?: PendingExternalRequestRecord;
	readonly terminalResult?: TerminalDoneRecord;
	readonly usedLabels: readonly string[];
}

export interface StateSnapshot<State> {
	readonly state: StateFile<State> | null;
	readonly migratedFromVersion:
		| typeof LEGACY_STATE_SCHEMA_VERSION
		| typeof PREVIOUS_STATE_SCHEMA_VERSION
		| null;
}

export type MigrationResult =
	| { readonly kind: "MIGRATED"; readonly state: Record<string, unknown> }
	| {
			readonly kind: "BLOCKED";
			readonly reason: MigrationBlockReason;
			readonly path?: string;
			readonly cause?: unknown;
	  };
