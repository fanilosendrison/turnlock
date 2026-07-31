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
