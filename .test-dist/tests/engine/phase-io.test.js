import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, test } from "node:test";
import { z } from "zod";
import { buildPhaseIO } from "../../src/engine/phase-io.js";
import { ExternalResolutionMissingError, ExternalResolutionSchemaError, ProtocolError, } from "../../src/errors/concrete.js";
import { createMockLogger } from "../helpers/mock-logger.js";
import { testArtifactRef } from "../helpers/state-builder.js";
import { cleanupTempDir, makeTempDir } from "../helpers/temp-run-dir.js";
const RUN_ID = "01HX0000000000000000000001";
function makeGuards() {
    return {
        committed: { value: false },
        committedResult: { value: null },
        consumedCount: { value: 0 },
    };
}
function makePendingExternal(runDir) {
    return {
        requestId: `${RUN_ID}/push-repo`,
        label: "push-repo",
        requestType: "git.push",
        resumeAt: "resume",
        manifestArtifact: testArtifactRef("external-request-manifest"),
        resultPath: join(runDir, "external-results", "push-repo.json"),
        emittedAt: "2026-04-19T12:00:00.000Z",
        emittedAtEpochMs: 1745062800000,
    };
}
function makePendingDelegation() {
    return {
        label: "review",
        kind: "prompt",
        resumeAt: "resume",
        manifestArtifact: testArtifactRef("delegation-manifest"),
        emittedAtEpochMs: 1745062800000,
        deadlineAtEpochMs: 1745063400000,
        attempt: 0,
        effectiveRetryPolicy: {
            maxAttempts: 3,
            backoffBaseMs: 1000,
            maxBackoffMs: 30000,
        },
    };
}
function buildIO(options) {
    const logger = createMockLogger();
    const ctx = {
        config: {
            name: "phase-io-test",
            initial: "start",
            initialState: { count: 0 },
            resumeCommand: (runId) => `node main.js --run-id ${runId} --resume`,
            phases: {
                start: async (_state, io) => io.done({ ok: true }),
                resume: async (_state, io) => io.done({ ok: true }),
            },
        },
        runId: RUN_ID,
        runDir: options.runDir,
        runDb: null,
        handle: {
            ownerToken: "owner",
            incarnationId: "01HXINCARNATION0000000000000",
            fenceToken: 1n,
            leaseUntilEpochMs: 9999999999999,
        },
        logger,
        abortController: new AbortController(),
        currentPhase: "resume",
        phasesExecuted: 0,
        accumulatedDurationMs: 0,
        stateRevision: "0",
    };
    const guards = options.guards ?? makeGuards();
    const io = buildPhaseIO({
        ctx,
        currentPhase: "resume",
        loadedResults: options.loadedResults,
        pendingAtEntry: options.pendingDelegation,
        pendingExternalAtEntry: options.pendingExternalRequest,
        usedLabelsAtEntry: options.usedLabels ?? [],
        guards,
    });
    return { io, guards, logger };
}
describe("PhaseIO external request creation", () => {
    test("requestExternal commits the expected PhaseResult", () => {
        const runDir = makeTempDir();
        try {
            const { io, guards } = buildIO({ runDir });
            const result = io.requestExternal({
                label: "push-repo",
                requestType: "git.push",
                payload: { repository: "/repo", force: false },
                metadata: { source: "test" },
            }, "resume", { count: 1 });
            assert.deepStrictEqual(result, {
                kind: "external-request",
                request: {
                    label: "push-repo",
                    requestType: "git.push",
                    payload: { repository: "/repo", force: false },
                    metadata: { source: "test" },
                },
                resumeAt: "resume",
                nextState: { count: 1 },
            });
            assert.strictEqual(guards.committed.value, true);
        }
        finally {
            cleanupTempDir(runDir);
        }
    });
    test("requestExternal rejects labels already used by any yield kind", () => {
        const runDir = makeTempDir();
        try {
            const { io } = buildIO({ runDir, usedLabels: ["push-repo"] });
            assert.throws(() => io.requestExternal({ label: "push-repo", requestType: "git.push", payload: null }, "resume", { count: 1 }), ProtocolError);
        }
        finally {
            cleanupTempDir(runDir);
        }
    });
    test("requestExternal obeys the existing single-commit guard", () => {
        const runDir = makeTempDir();
        try {
            const { io } = buildIO({ runDir });
            io.done({ ok: true });
            assert.throws(() => io.requestExternal({ label: "push-repo", requestType: "git.push", payload: null }, "resume", { count: 1 }), ProtocolError);
        }
        finally {
            cleanupTempDir(runDir);
        }
    });
    test("requestExternal rejects invalid labels, request types, payloads, and metadata", () => {
        const runDir = makeTempDir();
        try {
            const invalidRequests = [
                { label: "Invalid_Label", requestType: "git.push", payload: null },
                { label: "push-repo", requestType: "", payload: null },
                { label: "push-repo", requestType: "   ", payload: null },
                { label: "push-repo", requestType: "git.push\nnext", payload: null },
                {
                    label: "push-repo",
                    requestType: "git.push",
                    payload: (() => "value"),
                },
                {
                    label: "push-repo",
                    requestType: "git.push",
                    payload: 1n,
                },
                {
                    label: "push-repo",
                    requestType: "git.push",
                    payload: { missing: undefined },
                },
                {
                    label: "push-repo",
                    requestType: "git.push",
                    payload: null,
                    metadata: { missing: undefined },
                },
            ];
            for (const request of invalidRequests) {
                const { io } = buildIO({ runDir });
                assert.throws(() => io.requestExternal(request, "resume", { count: 1 }), ProtocolError);
            }
        }
        finally {
            cleanupTempDir(runDir);
        }
    });
});
describe("PhaseIO external resolution consumption", () => {
    test("consume without an external pending record fails", () => {
        const runDir = makeTempDir();
        try {
            const { io } = buildIO({ runDir });
            assert.throws(() => io.consumePendingExternalResolution(z.unknown()), ExternalResolutionMissingError);
        }
        finally {
            cleanupTempDir(runDir);
        }
    });
    test("consume refuses a pending delegation in place of an external request", () => {
        const runDir = makeTempDir();
        try {
            const { io } = buildIO({
                runDir,
                pendingDelegation: makePendingDelegation(),
            });
            assert.throws(() => io.consumePendingExternalResolution(z.unknown()), ProtocolError);
        }
        finally {
            cleanupTempDir(runDir);
        }
    });
    test("consume refuses a missing loaded resolution", () => {
        const runDir = makeTempDir();
        try {
            const { io } = buildIO({
                runDir,
                pendingExternalRequest: makePendingExternal(runDir),
            });
            assert.throws(() => io.consumePendingExternalResolution(z.unknown()), ExternalResolutionMissingError);
        }
        finally {
            cleanupTempDir(runDir);
        }
    });
    test("consume validates one opaque resolution exactly once", () => {
        const runDir = makeTempDir();
        try {
            const pending = makePendingExternal(runDir);
            const { io, guards, logger } = buildIO({
                runDir,
                pendingExternalRequest: pending,
                loadedResults: {
                    label: pending.label,
                    kind: "external-request",
                    data: { outcome: "PUSHED", remoteSha: "abc123" },
                },
            });
            const schema = z.object({
                outcome: z.enum(["PUSHED", "REJECTED", "UNKNOWN"]),
                remoteSha: z.string().optional(),
            });
            assert.deepStrictEqual(io.consumePendingExternalResolution(schema), {
                outcome: "PUSHED",
                remoteSha: "abc123",
            });
            assert.strictEqual(guards.consumedCount.value, 1);
            assert.ok(logger.eventTypes().includes("external_resolution_validated"));
            assert.throws(() => io.consumePendingExternalResolution(schema), ProtocolError);
        }
        finally {
            cleanupTempDir(runDir);
        }
    });
    test("consume distinguishes a valid null JSON resolution from a missing file", () => {
        const runDir = makeTempDir();
        try {
            const pending = makePendingExternal(runDir);
            const { io } = buildIO({
                runDir,
                pendingExternalRequest: pending,
                loadedResults: {
                    label: pending.label,
                    kind: "external-request",
                    data: null,
                },
            });
            assert.strictEqual(io.consumePendingExternalResolution(z.null()), null);
        }
        finally {
            cleanupTempDir(runDir);
        }
    });
    test("consume rejects a schema-incompatible resolution without delegation retry semantics", () => {
        const runDir = makeTempDir();
        try {
            const pending = makePendingExternal(runDir);
            const { io, logger } = buildIO({
                runDir,
                pendingExternalRequest: pending,
                loadedResults: {
                    label: pending.label,
                    kind: "external-request",
                    data: { outcome: 42 },
                },
            });
            assert.throws(() => io.consumePendingExternalResolution(z.object({ outcome: z.string() })), ExternalResolutionSchemaError);
            assert.ok(logger.eventTypes().includes("external_resolution_validation_failed"));
            assert.ok(!logger.eventTypes().includes("retry_scheduled"));
        }
        finally {
            cleanupTempDir(runDir);
        }
    });
    test("delegation consume methods refuse an external pending record", () => {
        const runDir = makeTempDir();
        try {
            const pending = makePendingExternal(runDir);
            const { io } = buildIO({
                runDir,
                pendingExternalRequest: pending,
                loadedResults: {
                    label: pending.label,
                    kind: "external-request",
                    data: null,
                },
            });
            assert.throws(() => io.consumePendingResult(z.unknown()), ProtocolError);
        }
        finally {
            cleanupTempDir(runDir);
        }
    });
});
//# sourceMappingURL=phase-io.test.js.map