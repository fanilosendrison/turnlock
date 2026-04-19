import * as path from "node:path";
import { writeProtocolBlock } from "../services/protocol";
import type { SkillDelegationRequest } from "../types/delegation";
import type {
	DelegationBinding,
	DelegationContext,
	DelegationManifest,
} from "./types";
import { MANIFEST_VERSION } from "./types";

export const skillBinding: DelegationBinding<SkillDelegationRequest> = {
	kind: "skill",

	buildManifest(
		request: SkillDelegationRequest,
		context: DelegationContext,
	): DelegationManifest {
		const resultPath = path.join(
			context.runDir,
			"results",
			`${request.label}-${context.attempt}.json`,
		);

		const manifest: DelegationManifest = {
			manifestVersion: MANIFEST_VERSION,
			runId: context.runId,
			orchestratorName: context.orchestratorName,
			phase: context.phase,
			resumeAt: context.resumeAt,
			label: request.label,
			kind: "skill",
			emittedAt: context.emittedAt,
			emittedAtEpochMs: context.emittedAtEpochMs,
			timeoutMs: context.timeoutMs,
			deadlineAtEpochMs: context.deadlineAtEpochMs,
			attempt: context.attempt,
			maxAttempts: context.maxAttempts,
			skill: request.skill,
			...(request.args !== undefined ? { skillArgs: request.args } : {}),
			resultPath,
		};

		return manifest;
	},

	buildProtocolBlock(
		manifest: DelegationManifest,
		manifestPath: string,
		resumeCmd: string,
	): string {
		return writeProtocolBlock("DELEGATE", {
			runId: manifest.runId,
			orchestrator: manifest.orchestratorName,
			manifest: manifestPath,
			kind: manifest.kind,
			resumeCmd,
		});
	},
};
