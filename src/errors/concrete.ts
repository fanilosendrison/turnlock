import { OrchestratorError, type OrchestratorErrorOptions } from "./base.ts";

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
