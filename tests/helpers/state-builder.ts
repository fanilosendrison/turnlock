import { STATE_SCHEMA_VERSION } from "../../src/constants";
import type {
	PendingDelegationRecord,
	StateFile,
} from "../../src/services/state-io";
import type { ArtifactRef } from "../../src/types/artifacts";

const DEFAULT_START = "2026-04-19T12:00:00.000Z";
const DEFAULT_START_EPOCH = 1_745_062_800_000;

const defaultPolicy = {
	maxAttempts: 3,
	backoffBaseMs: 1000,
	maxBackoffMs: 30_000,
} as const;

/** Build a minimal ArtifactRef for test state construction. */
export function testArtifactRef(
	kind: ArtifactRef["kind"],
	digest?: string,
): ArtifactRef {
	const d = digest ?? "sha256:0000000000000000000000000000000000000000000000000000000000000001";
	const hex = d.slice(7);
	return {
		kind,
		digestAlgorithm: "sha256",
		digest: d,
		relativePath: `artifacts/sha256/${hex.slice(0, 2)}/${hex.slice(2)}.json`,
		mediaType: "application/json",
		sizeBytes: 2,
	};
}

export function buildInitialState<S extends object>(
	overrides: Partial<StateFile<S>> & { data?: S } = {},
): StateFile<S> {
	return {
		schemaVersion: STATE_SCHEMA_VERSION,
		runId: "01HX0000000000000000000000",
		orchestratorName: "test-orch",
		startedAt: DEFAULT_START,
		startedAtEpochMs: DEFAULT_START_EPOCH,
		lastTransitionAt: DEFAULT_START,
		lastTransitionAtEpochMs: DEFAULT_START_EPOCH,
		currentPhase: "start",
		phasesExecuted: 0,
		accumulatedDurationMs: 0,
		data: {} as unknown as S,
		usedLabels: [],
		...overrides,
	};
}

export function buildMidRunState<S extends object>(
	overrides: Partial<StateFile<S>> & { data?: S } = {},
): StateFile<S> {
	return buildInitialState<S>({
		currentPhase: "b",
		phasesExecuted: 2,
		accumulatedDurationMs: 1234,
		usedLabels: ["foo"],
		...overrides,
	});
}

export function buildPendingPrompt<S extends object>(
	label: string,
	attempt: number,
	overrides: Partial<StateFile<S>> & { data?: S } = {},
): StateFile<S> {
	const pd: PendingDelegationRecord = {
		label,
		kind: "prompt",
		resumeAt: "b",
		manifestArtifact: testArtifactRef("delegation-manifest"),
		emittedAtEpochMs: DEFAULT_START_EPOCH,
		deadlineAtEpochMs: DEFAULT_START_EPOCH + 600_000,
		attempt,
		effectiveRetryPolicy: defaultPolicy,
	};
	return buildMidRunState<S>({
		pendingDelegation: pd,
		usedLabels: [label],
		...overrides,
	});
}

export function buildPendingBatch<S extends object>(
	label: string,
	jobIds: string[],
	attempt: number,
	overrides: Partial<StateFile<S>> & { data?: S } = {},
): StateFile<S> {
	const pd: PendingDelegationRecord = {
		label,
		kind: "batch",
		resumeAt: "b",
		manifestArtifact: testArtifactRef("delegation-manifest"),
		emittedAtEpochMs: DEFAULT_START_EPOCH,
		deadlineAtEpochMs: DEFAULT_START_EPOCH + 600_000,
		attempt,
		effectiveRetryPolicy: defaultPolicy,
		jobIds,
	};
	return buildMidRunState<S>({
		pendingDelegation: pd,
		usedLabels: [label],
		...overrides,
	});
}
