import * as path from "node:path";
import { batchBinding } from "../bindings/batch.js";
import { promptBinding } from "../bindings/prompt.js";
import type {
	DelegationBinding,
	DelegationManifest,
} from "../bindings/types.js";
import { MANIFEST_VERSION } from "../constants.js";
import type {
	DelegationRequest,
	DelegationTarget,
} from "../types/delegation.js";
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
/**
 * Reconstruct a manifest for a retry attempt.
 *
 * The logical target is IMMUTABLE across attempts (ADR-0001): the caller
 * resolves it once (including deterministic legacy v2 migration) and passes
 * it through `updates.target`.  Only attempt-specific fields change:
 * attempt, emittedAt, emittedAtEpochMs, deadlineAtEpochMs, resultPath,
 * jobs[].resultPath.
 *
 * Any legacy `worker` field carried by a v2 source manifest is stripped so
 * the new manifest is canonical v3 and never derives its destination from
 * field presence or absence.
 */
export function reconstructManifest(
	old: DelegationManifest,
	updates: {
		attempt: number;
		emittedAt: string;
		emittedAtEpochMs: number;
		deadlineAtEpochMs: number;
		label: string;
		runDir: string;
		target: DelegationTarget;
	},
): DelegationManifest {
	const { worker: _legacyWorker, ...stableFields } =
		old as DelegationManifest & {
			readonly worker?: string;
		};
	const base: DelegationManifest = {
		...stableFields,
		manifestVersion: MANIFEST_VERSION,
		target: updates.target,
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
