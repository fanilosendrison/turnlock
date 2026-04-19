import type { OrchestratorError } from "../errors/base";
import type { RetryPolicy } from "../types/policies";

export {
	DEFAULT_BACKOFF_BASE_MS,
	DEFAULT_MAX_ATTEMPTS,
	DEFAULT_MAX_BACKOFF_MS,
} from "../constants";

export type { RetryPolicy };

export type RetryDecisionReason =
	| "transient_timeout"
	| "transient_schema"
	| "retry_exhausted"
	| "fatal_invalid_config"
	| "fatal_state_corrupted"
	| "fatal_state_missing"
	| "fatal_state_version_mismatch"
	| "fatal_delegation_missing_result"
	| "fatal_phase_error"
	| "fatal_protocol"
	| "fatal_aborted"
	| "fatal_run_locked"
	| "fatal_unknown";

export type RetryDecision =
	| { readonly retry: false; readonly reason: RetryDecisionReason }
	| {
			readonly retry: true;
			readonly delayMs: number;
			readonly reason: RetryDecisionReason;
	  };

function isOrchestratorError(err: unknown): err is OrchestratorError {
	return (
		err instanceof Error &&
		"kind" in err &&
		typeof (err as { kind: unknown }).kind === "string"
	);
}

function computeBackoff(attempt: number, policy: RetryPolicy): number {
	const raw = policy.backoffBaseMs * 2 ** attempt;
	return Math.min(raw, policy.maxBackoffMs);
}

export function resolveRetryDecision(
	error: OrchestratorError | Error,
	attempt: number,
	policy: RetryPolicy,
): RetryDecision {
	const kind = isOrchestratorError(error) ? error.kind : "unknown";

	switch (kind) {
		case "invalid_config":
			return { retry: false, reason: "fatal_invalid_config" };
		case "state_corrupted":
			return { retry: false, reason: "fatal_state_corrupted" };
		case "state_missing":
			return { retry: false, reason: "fatal_state_missing" };
		case "state_version_mismatch":
			return { retry: false, reason: "fatal_state_version_mismatch" };
		case "delegation_missing_result":
			return { retry: false, reason: "fatal_delegation_missing_result" };
		case "phase_error":
			return { retry: false, reason: "fatal_phase_error" };
		case "protocol":
			return { retry: false, reason: "fatal_protocol" };
		case "aborted":
			return { retry: false, reason: "fatal_aborted" };
		case "run_locked":
			return { retry: false, reason: "fatal_run_locked" };
		case "unknown":
			return { retry: false, reason: "fatal_unknown" };
		case "delegation_timeout":
		case "delegation_schema": {
			if (attempt + 1 >= policy.maxAttempts) {
				return { retry: false, reason: "retry_exhausted" };
			}
			const delayMs = computeBackoff(attempt, policy);
			const reason: RetryDecisionReason =
				kind === "delegation_timeout"
					? "transient_timeout"
					: "transient_schema";
			return { retry: true, delayMs, reason };
		}
	}
}
