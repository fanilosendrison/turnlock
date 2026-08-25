import type { RetryPolicy, TimeoutPolicy } from "./policies.ts";

export type DelegationRequest =
	| PromptDelegationRequest
	| BatchDelegationRequest;

export interface PromptDelegationRequest {
	readonly kind: "prompt";
	readonly worker?: string;
	readonly prompt: string;
	readonly label: string;
	readonly retry?: RetryPolicy;
	readonly timeout?: TimeoutPolicy;
}

export interface BatchDelegationRequest {
	readonly kind: "batch";
	readonly worker?: string;
	readonly jobs: ReadonlyArray<{
		readonly id: string;
		readonly prompt: string;
	}>;
	readonly label: string;
	readonly retry?: RetryPolicy;
	readonly timeout?: TimeoutPolicy;
}
