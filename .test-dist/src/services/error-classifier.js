import { AbortedError, PhaseError } from "../errors/concrete.js";
function isOrchestratorError(err) {
    return ("kind" in err &&
        typeof err.kind === "string");
}
export function classify(err) {
    if (!(err instanceof Error))
        return "unknown";
    if (!isOrchestratorError(err))
        return "unknown";
    switch (err.kind) {
        case "delegation_timeout":
        case "delegation_schema":
            return "transient";
        case "aborted":
            return "abort";
        case "phase_error":
            if (err instanceof PhaseError &&
                "cause" in err &&
                err.cause instanceof AbortedError) {
                return "abort";
            }
            return "permanent";
        case "invalid_config":
        case "state_corrupted":
        case "state_missing":
        case "state_version_mismatch":
        case "delegation_missing_result":
        case "external_resolution_missing":
        case "external_resolution_schema":
        case "external_resolution_malformed":
        case "protocol":
        case "run_locked":
        case "authority_lost":
        case "state_revision_conflict":
        case "persistence_failure":
        case "artifact_integrity":
        case "state_migration_blocked":
        case "legacy_lock_migration_blocked":
        case "mixed_ownership_protocol_detected":
        case "indeterminate_phase_execution":
        case "initial_dispatch_already_claimed":
            return "permanent";
    }
}
//# sourceMappingURL=error-classifier.js.map