import type { ZodSchema } from "zod";
import type { Phase } from "./phase.js";
import type { LoggingPolicy, RetryPolicy, TimeoutPolicy } from "./policies.js";
export interface OrchestratorConfig<State extends object = object> {
	readonly name: string;
	readonly initial: string;
	readonly phases: Readonly<Record<string, Phase<State, unknown>>>;
	readonly initialState: State;
	readonly resumeCommand: (runId: string) => string;
	readonly stateSchema?: ZodSchema<State>;
	readonly retry?: RetryPolicy;
	readonly timeout?: TimeoutPolicy;
	readonly logging?: LoggingPolicy;
	/**
	 * Retention window in days, used by the startup cleanup that deletes
	 * old foreign RUN_DIRs under the orchestrator's run root.
	 * Validated in preflight: must be a finite, non-negative integer.
	 * `0` means "no retention delay" (eligible directories are deleted
	 * immediately).  Defaults to 7 days.
	 */
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
