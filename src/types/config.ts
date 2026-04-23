import type { ZodSchema } from "zod";
import type { Phase } from "./phase";
import type { LoggingPolicy, RetryPolicy, TimeoutPolicy } from "./policies";

export interface OrchestratorConfig<State extends object = object> {
	readonly name: string;
	readonly initial: string;
	readonly phases: Readonly<Record<string, Phase<State, any, any>>>;
	readonly initialState: State;
	readonly resumeCommand: (runId: string) => string;
	readonly stateSchema?: ZodSchema<State>;
	readonly retry?: RetryPolicy;
	readonly timeout?: TimeoutPolicy;
	readonly logging?: LoggingPolicy;
	readonly retentionDays?: number;
	/**
	 * Root directory for RUN_DIRs. Path = `<root>/<name>/<runId>`.
	 * Precedence: env `TURNLOCK_RUN_DIR_ROOT` > this field > default `.turnlock/runs`.
	 * Relative → joined to cwd. Absolute → used as-is. Empty string = unset.
	 */
	readonly runDirRoot?: string;
}

export interface Clock {
	nowWall(): Date;
	nowWallIso(): string;
	nowEpochMs(): number;
	nowMono(): number;
}
