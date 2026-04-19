import * as path from "node:path";
import { InvalidConfigError } from "../errors/concrete";
import { writeProtocolBlock } from "../services/protocol";
import type { AgentBatchDelegationRequest } from "../types/delegation";
import type {
	DelegationBinding,
	DelegationContext,
	DelegationManifest,
} from "./types";
import { MANIFEST_VERSION } from "./types";

export const agentBatchBinding: DelegationBinding<AgentBatchDelegationRequest> =
	{
		kind: "agent-batch",

		buildManifest(
			request: AgentBatchDelegationRequest,
			context: DelegationContext,
		): DelegationManifest {
			if (request.jobs.length === 0) {
				throw new InvalidConfigError(
					`agent-batch delegation '${request.label}' has no jobs`,
				);
			}

			const batchDir = path.join(
				context.runDir,
				"results",
				`${request.label}-${context.attempt}`,
			);
			const jobs = request.jobs.map((job) => ({
				id: job.id,
				prompt: job.prompt,
				resultPath: path.join(batchDir, `${job.id}.json`),
			}));

			return {
				manifestVersion: MANIFEST_VERSION,
				runId: context.runId,
				orchestratorName: context.orchestratorName,
				phase: context.phase,
				resumeAt: context.resumeAt,
				label: request.label,
				kind: "agent-batch",
				emittedAt: context.emittedAt,
				emittedAtEpochMs: context.emittedAtEpochMs,
				timeoutMs: context.timeoutMs,
				deadlineAtEpochMs: context.deadlineAtEpochMs,
				attempt: context.attempt,
				maxAttempts: context.maxAttempts,
				agentType: request.agentType,
				jobs,
			};
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
