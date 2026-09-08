import type { LEGACY_V2_TARGET_COMPATIBILITY } from "../constants.js";
import type {
	DelegationRequest,
	DelegationTarget,
} from "../types/delegation.js";

export { MANIFEST_VERSION } from "../constants.js";
export type DelegationTargetCompatibility =
	typeof LEGACY_V2_TARGET_COMPATIBILITY;
export interface ResolvedManifestTarget {
	readonly target: DelegationTarget;
	readonly targetCompatibility?: DelegationTargetCompatibility;
}
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
	readonly manifestVersion: 3;
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
	/** Mandatory logical destination (ADR-0001). Never derived from absence. */
	readonly target: DelegationTarget;
	/** Present only when v2 compatibility rules established the target. */
	readonly targetCompatibility?: DelegationTargetCompatibility;
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
