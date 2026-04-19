import type { OrchestratorError } from "../errors/base";
import { AbortedError, PhaseError } from "../errors/concrete";

export type ErrorCategory = "transient" | "permanent" | "abort" | "unknown";

function isOrchestratorError(err: Error): err is OrchestratorError {
	return "kind" in err && typeof (err as { kind: unknown }).kind === "string";
}

export function classify(err: unknown): ErrorCategory {
	if (!(err instanceof Error)) return "unknown";
	if (!isOrchestratorError(err)) return "unknown";

	switch (err.kind) {
		case "delegation_timeout":
		case "delegation_schema":
			return "transient";
		case "aborted":
			return "abort";
		case "phase_error":
			if (
				err instanceof PhaseError &&
				"cause" in err &&
				err.cause instanceof AbortedError
			) {
				return "abort";
			}
			return "permanent";
		case "invalid_config":
		case "state_corrupted":
		case "state_missing":
		case "state_version_mismatch":
		case "delegation_missing_result":
		case "protocol":
		case "run_locked":
			return "permanent";
	}
}
