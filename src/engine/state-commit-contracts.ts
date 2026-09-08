import type { LockHandle } from "../persistence/sqlite/ownership.js";
import type { RunDatabase } from "../persistence/sqlite/run-database.js";
import type { ArtifactRef } from "../types/artifacts.js";

export interface StateTransitionContext {
	readonly runDb: RunDatabase;
	readonly handle: LockHandle;
	readonly runDir: string;
	readonly config?: {
		readonly name?: string;
	};
	readonly runId: string;
	readonly currentPhase?: string | null;
	stateRevision: string;
}

export interface OwnershipMutationContext {
	readonly runDb: RunDatabase;
	handle: LockHandle;
	readonly runId: string;
	readonly config?: {
		readonly name?: string;
	};
	readonly currentPhase?: string | null;
}

export interface OwnershipReleaseContext {
	readonly runDb: RunDatabase;
	readonly handle: LockHandle;
	readonly runId: string;
	readonly config?: {
		readonly name?: string;
	};
	readonly currentPhase?: string | null;
}

export interface OwnershipContextWithLogger {
	readonly runDb: RunDatabase;
	readonly handle: LockHandle;
	readonly runId: string;
	readonly logger: {
		emit(event: {
			eventType: string;
			runId: string;
			reason?: string;
			timestamp: string;
		}): void;
	};
}

export interface CanonicalArtifactProjectionContext {
	readonly runDb: RunDatabase;
	readonly handle: LockHandle;
	readonly runDir: string;
	readonly runId: string;
	readonly config?: {
		readonly name?: string;
	};
	readonly currentPhase?: string | null;
}

/** Describes where in the authoritative state the ArtifactRef is expected. */
export interface ExpectedArtifactPlacement {
	/** JSON pointer path, e.g. "/terminalResult/outputArtifact" or
	 *  "/pendingDelegation/manifestArtifact". */
	readonly pointer: string;
	readonly artifact: ArtifactRef;
}
