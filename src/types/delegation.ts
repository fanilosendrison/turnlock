import type { RetryPolicy, TimeoutPolicy } from "./policies.js";
/**
 * Logical destination of semantic work (see ADR-0001 and
 * docs/architecture/delegation-model.md).
 *
 * Turnlock records WHO logically owns the work; the surrounding runtime
 * resolves that target to a physical execution mechanism (model call,
 * agent session, service, process, ...). Turnlock core must never encode
 * the physical mechanism.
 *
 * - `host`    — the principal semantic actor of the harness that launched
 *               the workflow, in the current host context.
 * - `worker`  — a named logical execution capability, e.g. "reviewer".
 *               It implies no specific subprocess, session, model, or
 *               provider.
 */
export type DelegationTarget =
	| {
			readonly kind: "host";
	  }
	| {
			readonly kind: "worker";
			readonly name: string;
	  };
export type DelegationRequest =
	| PromptDelegationRequest
	| BatchDelegationRequest;
export interface PromptDelegationRequest {
	readonly kind: "prompt";
	/** Mandatory logical destination. No implicit default exists. */
	readonly target: DelegationTarget;
	readonly prompt: string;
	readonly label: string;
	readonly retry?: RetryPolicy;
	readonly timeout?: TimeoutPolicy;
}
export interface BatchDelegationRequest {
	readonly kind: "batch";
	/** Mandatory logical destination. No implicit default exists. */
	readonly target: DelegationTarget;
	readonly jobs: ReadonlyArray<{
		readonly id: string;
		readonly prompt: string;
	}>;
	readonly label: string;
	readonly retry?: RetryPolicy;
	readonly timeout?: TimeoutPolicy;
}
