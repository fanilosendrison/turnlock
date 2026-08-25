import type { OrchestratorLogger } from "./events.ts";

export interface RetryPolicy {
	readonly maxAttempts: number;
	readonly backoffBaseMs: number;
	readonly maxBackoffMs: number;
}

export interface TimeoutPolicy {
	readonly perDelegationMs: number;
}

export interface LoggingPolicy {
	readonly logger?: OrchestratorLogger;
	readonly enabled: boolean;
	readonly persistEventLog?: boolean;
}
