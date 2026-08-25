import type { DelegationRequest } from "../types/delegation.ts";

export { MANIFEST_VERSION } from "../constants.ts";

export interface DelegationContext {
	readonly runId: string;
	readonly orchestratorName: string;
	readonly phase: string;
	readonly resumeAt: string;
	readonly attempt: number;
	readonly maxAttempts: number;
	readonly emittedAt: string;
	readonly emittedAtEpochMs: number;
	readonly timeoutMs: number;
	readonly deadlineAtEpochMs: number;
	readonly runDir: string;
}

export interface DelegationManifestJob {
	readonly id: string;
	readonly prompt: string;
	readonly resultPath: string;
}

export interface DelegationManifest {
	readonly manifestVersion: 2;
	readonly runId: string;
	readonly orchestratorName: string;
	readonly phase: string;
	readonly resumeAt: string;
	readonly label: string;
	readonly kind: "prompt" | "batch";
	readonly emittedAt: string;
	readonly emittedAtEpochMs: number;
	readonly timeoutMs: number;
	readonly deadlineAtEpochMs: number;
	readonly attempt: number;
	readonly maxAttempts: number;
	readonly worker?: string;
	readonly prompt?: string;
	readonly jobs?: readonly DelegationManifestJob[];
	readonly resultPath?: string;
}

export interface DelegationBinding<Req extends DelegationRequest> {
	readonly kind: Req["kind"];
	buildManifest(request: Req, context: DelegationContext): DelegationManifest;
	buildProtocolBlock(
		manifest: DelegationManifest,
		manifestPath: string,
		resumeCmd: string,
	): string;
}
