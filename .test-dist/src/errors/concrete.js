import { OrchestratorError } from "./base.js";
export class AuthorityLostError extends OrchestratorError {
    kind = "authority_lost";
    operation;
    reason;
    constructor(message, options) {
        super(message, options);
        this.operation = options.operation;
        this.reason = options.reason;
    }
}
export class StateRevisionConflictError extends OrchestratorError {
    kind = "state_revision_conflict";
}
export class ArtifactIntegrityError extends OrchestratorError {
    kind = "artifact_integrity";
}
export class StateMigrationBlockedError extends OrchestratorError {
    kind = "state_migration_blocked";
    reason;
    constructor(message, options) {
        super(message, options);
        this.reason = options.reason;
    }
}
export class LegacyLockMigrationBlockedError extends OrchestratorError {
    kind = "legacy_lock_migration_blocked";
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
    kind = "mixed_ownership_protocol_detected";
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
    kind = "indeterminate_phase_execution";
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
    kind = "initial_dispatch_already_claimed";
}
export class PersistenceFailureError extends OrchestratorError {
    kind = "persistence_failure";
    operation;
    constructor(message, options) {
        super(message, options);
        this.operation = options.operation;
    }
}
// ---------------------------------------------------------------------------
// Existing errors
// ---------------------------------------------------------------------------
export class InvalidConfigError extends OrchestratorError {
    kind = "invalid_config";
}
export class StateCorruptedError extends OrchestratorError {
    kind = "state_corrupted";
}
export class StateMissingError extends OrchestratorError {
    kind = "state_missing";
}
export class StateVersionMismatchError extends OrchestratorError {
    kind = "state_version_mismatch";
}
export class DelegationTimeoutError extends OrchestratorError {
    kind = "delegation_timeout";
}
export class DelegationSchemaError extends OrchestratorError {
    kind = "delegation_schema";
}
export class DelegationMissingResultError extends OrchestratorError {
    kind = "delegation_missing_result";
}
export class ExternalResolutionMissingError extends OrchestratorError {
    kind = "external_resolution_missing";
}
export class ExternalResolutionSchemaError extends OrchestratorError {
    kind = "external_resolution_schema";
}
export class ExternalResolutionMalformedError extends OrchestratorError {
    kind = "external_resolution_malformed";
}
export class PhaseError extends OrchestratorError {
    kind = "phase_error";
}
export class ProtocolError extends OrchestratorError {
    kind = "protocol";
}
export class AbortedError extends OrchestratorError {
    kind = "aborted";
}
export class RunLockedError extends OrchestratorError {
    kind = "run_locked";
    ownerPid;
    acquiredAtEpochMs;
    leaseUntilEpochMs;
    constructor(message, options) {
        super(message, options);
        this.ownerPid = options.ownerPid;
        this.acquiredAtEpochMs = options.acquiredAtEpochMs;
        this.leaseUntilEpochMs = options.leaseUntilEpochMs;
    }
}
//# sourceMappingURL=concrete.js.map