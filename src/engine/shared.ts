import * as path from "node:path";
import { agentBinding } from "../bindings/agent";
import { agentBatchBinding } from "../bindings/agent-batch";
import { skillBinding } from "../bindings/skill";
import type { DelegationBinding, DelegationManifest } from "../bindings/types";
import type { DelegationRequest } from "../types/delegation";

/**
 * Shared engine utilities extracted from dispatch-loop.ts and handle-resume.ts
 * to eliminate cross-file duplication.
 */

export function selectBinding(
	kind: "skill" | "agent" | "agent-batch",
): DelegationBinding<DelegationRequest> {
	switch (kind) {
		case "skill":
			return skillBinding as DelegationBinding<DelegationRequest>;
		case "agent":
			return agentBinding as DelegationBinding<DelegationRequest>;
		case "agent-batch":
			return agentBatchBinding as DelegationBinding<DelegationRequest>;
	}
}

export function reconstructManifest(
	old: DelegationManifest,
	updates: {
		attempt: number;
		emittedAt: string;
		emittedAtEpochMs: number;
		deadlineAtEpochMs: number;
		label: string;
		runDir: string;
	},
): DelegationManifest {
	const base: DelegationManifest = {
		...old,
		attempt: updates.attempt,
		emittedAt: updates.emittedAt,
		emittedAtEpochMs: updates.emittedAtEpochMs,
		deadlineAtEpochMs: updates.deadlineAtEpochMs,
	};
	if (old.kind === "skill" || old.kind === "agent") {
		return {
			...base,
			resultPath: path.join(
				updates.runDir,
				"results",
				`${updates.label}-${updates.attempt}.json`,
			),
		};
	}
	return {
		...base,
		jobs: (old.jobs ?? []).map((j) => ({
			...j,
			resultPath: path.join(
				updates.runDir,
				"results",
				`${updates.label}-${updates.attempt}`,
				`${j.id}.json`,
			),
		})),
	};
}
