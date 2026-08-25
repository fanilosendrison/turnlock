import * as path from "node:path";
import { batchBinding } from "../bindings/batch.ts";
import { promptBinding } from "../bindings/prompt.ts";
import type {
	DelegationBinding,
	DelegationManifest,
} from "../bindings/types.ts";
import type { DelegationRequest } from "../types/delegation.ts";

/**
 * Shared engine utilities extracted from dispatch-loop.ts and handle-resume.ts
 * to eliminate cross-file duplication.
 */

export function selectBinding(
	kind: "prompt" | "batch",
): DelegationBinding<DelegationRequest> {
	switch (kind) {
		case "prompt":
			return promptBinding as DelegationBinding<DelegationRequest>;
		case "batch":
			return batchBinding as DelegationBinding<DelegationRequest>;
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
	if (old.kind === "prompt") {
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
