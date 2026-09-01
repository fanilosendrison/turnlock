import { STATE_SCHEMA_VERSION } from "../../src/constants.js";
const DEFAULT_START = "2026-04-19T12:00:00.000Z";
const DEFAULT_START_EPOCH = 1745062800000;
const defaultPolicy = {
    maxAttempts: 3,
    backoffBaseMs: 1000,
    maxBackoffMs: 30000,
};
/** Build a minimal ArtifactRef for test state construction. */
export function testArtifactRef(kind, digest) {
    const d = digest ??
        "sha256:0000000000000000000000000000000000000000000000000000000000000001";
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
export function buildInitialState(overrides = {}) {
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
        data: {},
        usedLabels: [],
        ...overrides,
    };
}
export function buildMidRunState(overrides = {}) {
    return buildInitialState({
        currentPhase: "b",
        phasesExecuted: 2,
        accumulatedDurationMs: 1234,
        usedLabels: ["foo"],
        ...overrides,
    });
}
export function buildPendingPrompt(label, attempt, overrides = {}) {
    const pd = {
        label,
        kind: "prompt",
        resumeAt: "b",
        manifestArtifact: testArtifactRef("delegation-manifest"),
        emittedAtEpochMs: DEFAULT_START_EPOCH,
        deadlineAtEpochMs: DEFAULT_START_EPOCH + 600000,
        attempt,
        effectiveRetryPolicy: defaultPolicy,
    };
    return buildMidRunState({
        pendingDelegation: pd,
        usedLabels: [label],
        ...overrides,
    });
}
export function buildPendingBatch(label, jobIds, attempt, overrides = {}) {
    const pd = {
        label,
        kind: "batch",
        resumeAt: "b",
        manifestArtifact: testArtifactRef("delegation-manifest"),
        emittedAtEpochMs: DEFAULT_START_EPOCH,
        deadlineAtEpochMs: DEFAULT_START_EPOCH + 600000,
        attempt,
        effectiveRetryPolicy: defaultPolicy,
        jobIds,
    };
    return buildMidRunState({
        pendingDelegation: pd,
        usedLabels: [label],
        ...overrides,
    });
}
//# sourceMappingURL=state-builder.js.map