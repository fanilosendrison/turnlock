import { OrchestratorError, type OrchestratorErrorOptions } from "./base";

// ---------------------------------------------------------------------------
// Authority / persistence errors (TL-F-001)
// ---------------------------------------------------------------------------

export type AuthorityOperation = "state_commit" | "refresh" | "release";

export type AuthorityLossReason = "STALE_HANDLE" | "EXPIRED_HANDLE";

export interface AuthorityLostErrorOptions extends OrchestratorErrorOptions {
	readonly operation: AuthorityOperation;
	readonly reason: AuthorityLossReason;
}

export class AuthorityLostError extends OrchestratorError {
	readonly kind = "authority_lost" as const;

	readonly operation: AuthorityOperation;
	readonly reason: AuthorityLossReason;

	constructor(message: string, options: AuthorityLostErrorOptions) {
		super(message, options);
		this.operation = options.operation;
		this.reason = options.reason;
	}
}

export class StateRevisionConflictError extends OrchestratorError {
	readonly kind = "state_revision_conflict" as const;
}

export class ArtifactIntegrityError extends OrchestratorError {
	readonly kind = "artifact_integrity" as const;
}

/** Reason why a v3→v4 migration could not complete. */
export type MigrationBlockReason =
	| "MANIFEST_MISSING"
	| "MANIFEST_OUTSIDE_RUN_DIR"
	| "MANIFEST_SYMLINK"
	| "MANIFEST_NOT_REGULAR"
	| "MANIFEST_DIGEST_MISMATCH";

export class StateMigrationBlockedError extends OrchestratorError {
	readonly kind = "state_migration_blocked" as const;
	readonly reason: MigrationBlockReason;

	constructor(
		message: string,
		options: OrchestratorErrorOptions & {
			readonly reason: MigrationBlockReason;
		},
	) {
		super(message, options);
		this.reason = options.reason;
	}
}

export class LegacyLockMigrationBlockedError extends OrchestratorError {
	readonly kind = "legacy_lock_migration_blocked" as const;
}

/**
 * Raised when both SQLite ownership storage (`turnlock.sqlite3`) and a
 * legacy file-lock (`.lock`) coexist in the same RUN_DIR.
 *
 * This is NOT a migration scenario — a DB already established alongside a
 * `.lock` means the deployment or downgrade contract has been violated.
 * Turnlock refuses fail-closed and grants no new authority.
 */
export class MixedOwnershipProtocolError extends OrchestratorError {
	readonly kind = "mixed_ownership_protocol_detected" as const;
}

// ---------------------------------------------------------------------------
// Indeterminate phase execution errors
// ---------------------------------------------------------------------------

/**
 * Raised when a resume finds the state structurally valid but lacking a
 * pending delegation, and the phase may have already started executing.
 * Replay is deliberately forbidden because the direct effects of a
 * partially-executed phase are indeterminate.
 */
export class IndeterminatePhaseExecutionError extends OrchestratorError {
	readonly kind = "indeterminate_phase_execution" as const;
}

/**
 * Raised specifically when the one-time initial dispatch authorization was
 * already consumed but the phase crashed before producing a delegation or
 * terminal result.
 *
 * This is a sub-case of indeterminate phase execution: the runtime knows
 * the phase was eligible to execute but cannot determine what, if anything,
 * it did.  Replay is intentionally fail-closed.
 */
export class InitialDispatchAlreadyClaimedError extends OrchestratorError {
	readonly kind = "initial_dispatch_already_claimed" as const;
}

export interface PersistenceFailureErrorOptions
	extends OrchestratorErrorOptions {
	readonly operation: AuthorityOperation;
}

export class PersistenceFailureError extends OrchestratorError {
	readonly kind = "persistence_failure" as const;

	readonly operation: AuthorityOperation;

	constructor(message: string, options: PersistenceFailureErrorOptions) {
		super(message, options);
		this.operation = options.operation;
	}
}

// ---------------------------------------------------------------------------
// Existing errors
// ---------------------------------------------------------------------------

export class InvalidConfigError extends OrchestratorError {
	readonly kind = "invalid_config" as const;
}

export class StateCorruptedError extends OrchestratorError {
	readonly kind = "state_corrupted" as const;
}

export class StateMissingError extends OrchestratorError {
	readonly kind = "state_missing" as const;
}

export class StateVersionMismatchError extends OrchestratorError {
	readonly kind = "state_version_mismatch" as const;
}

export class DelegationTimeoutError extends OrchestratorError {
	readonly kind = "delegation_timeout" as const;
}

export class DelegationSchemaError extends OrchestratorError {
	readonly kind = "delegation_schema" as const;
}

export class DelegationMissingResultError extends OrchestratorError {
	readonly kind = "delegation_missing_result" as const;
}

export class ExternalResolutionMissingError extends OrchestratorError {
	readonly kind = "external_resolution_missing" as const;
}

export class ExternalResolutionSchemaError extends OrchestratorError {
	readonly kind = "external_resolution_schema" as const;
}

export class ExternalResolutionMalformedError extends OrchestratorError {
	readonly kind = "external_resolution_malformed" as const;
}

export class PhaseError extends OrchestratorError {
	readonly kind = "phase_error" as const;
}

export class ProtocolError extends OrchestratorError {
	readonly kind = "protocol" as const;
}

export class AbortedError extends OrchestratorError {
	readonly kind = "aborted" as const;
}

export interface RunLockedErrorOptions extends OrchestratorErrorOptions {
	readonly ownerPid: number;
	readonly acquiredAtEpochMs: number;
	readonly leaseUntilEpochMs: number;
}

export class RunLockedError extends OrchestratorError {
	readonly kind = "run_locked" as const;
	readonly ownerPid: number;
	readonly acquiredAtEpochMs: number;
	readonly leaseUntilEpochMs: number;

	constructor(message: string, options: RunLockedErrorOptions) {
		super(message, options);
		this.ownerPid = options.ownerPid;
		this.acquiredAtEpochMs = options.acquiredAtEpochMs;
		this.leaseUntilEpochMs = options.leaseUntilEpochMs;
	}
}
