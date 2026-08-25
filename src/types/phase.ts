import type { ZodSchema } from "zod";
import type { Clock } from "./config.ts";
import type {
	BatchDelegationRequest,
	DelegationRequest,
	PromptDelegationRequest,
} from "./delegation.ts";
import type { OrchestratorLogger } from "./events.ts";

export type Phase<State extends object = object, Output = unknown> = (
	state: State,
	io: PhaseIO<State>,
) => Promise<PhaseResult<State, Output>>;

export interface PhaseIO<State extends object> {
	delegate(
		req: PromptDelegationRequest,
		resumeAt: string,
		nextState: State,
	): PhaseResult<State>;
	delegateBatch(
		req: BatchDelegationRequest,
		resumeAt: string,
		nextState: State,
	): PhaseResult<State>;

	done<FinalOutput>(output: FinalOutput): PhaseResult<State, FinalOutput>;
	fail(error: Error): PhaseResult<State>;

	readonly logger: OrchestratorLogger;
	readonly clock: Clock;
	readonly runId: string;
	readonly args: readonly string[];
	readonly runDir: string;
	readonly signal: AbortSignal;

	consumePendingResult<T>(schema: ZodSchema<T>): T;
	consumePendingBatchResults<T>(schema: ZodSchema<T>): readonly T[];

	refreshLock(): void;
}

export type PhaseResult<State extends object = object, Output = unknown> =
	| {
			readonly kind: "delegate";
			readonly request: DelegationRequest;
			readonly resumeAt: string;
			readonly nextState: State;
	  }
	| { readonly kind: "done"; readonly output: Output }
	| { readonly kind: "fail"; readonly error: Error };
