import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, test } from "node:test";
import { externalRequestBinding, } from "../../src/bindings/external-request.js";
import { EXTERNAL_REQUEST_MANIFEST_VERSION } from "../../src/constants.js";
import { parseProtocolBlock } from "../../src/services/protocol.js";
const RUN_ID = "01HX0000000000000000000001";
const RUN_DIR = "/tmp/turnlock/external-request-test";
const CONTEXT = {
    runId: RUN_ID,
    orchestratorName: "external-test",
    phase: "push",
    resumeAt: "after-push",
    emittedAt: "2026-04-19T12:00:00.000Z",
    emittedAtEpochMs: 1745062800000,
    runDir: RUN_DIR,
};
describe("external request manifest binding", () => {
    test("builds a versioned opaque manifest with stable identity and paths", () => {
        const manifest = externalRequestBinding.buildManifest({
            label: "push-repo-a",
            requestType: "git.push",
            payload: {
                repository: "/repo-a",
                remote: "origin",
                branch: "main",
                targetSha: "abc123",
            },
            metadata: { requestedBy: "pipeline" },
        }, CONTEXT);
        assert.deepStrictEqual(manifest, {
            manifestVersion: EXTERNAL_REQUEST_MANIFEST_VERSION,
            kind: "external-request",
            requestId: `${RUN_ID}/push-repo-a`,
            runId: RUN_ID,
            orchestratorName: "external-test",
            phase: "push",
            resumeAt: "after-push",
            label: "push-repo-a",
            requestType: "git.push",
            payload: {
                repository: "/repo-a",
                remote: "origin",
                branch: "main",
                targetSha: "abc123",
            },
            metadata: { requestedBy: "pipeline" },
            emittedAt: CONTEXT.emittedAt,
            emittedAtEpochMs: CONTEXT.emittedAtEpochMs,
            resultPath: join(RUN_DIR, "external-results", "push-repo-a.json"),
        });
        assert.ok(!("attempt" in Object(manifest)));
        assert.ok(!("retry" in Object(manifest)));
        assert.ok(!("workerLease" in Object(manifest)));
    });
    test("omits metadata when it was not supplied", () => {
        const manifest = externalRequestBinding.buildManifest({
            label: "notify",
            requestType: "notification.send",
            payload: null,
        }, CONTEXT);
        assert.strictEqual("metadata" in manifest, false);
    });
    test("is pure for the same request and context", () => {
        const request = {
            label: "push-repo-a",
            requestType: "git.push",
            payload: { targetSha: "abc123" },
        };
        assert.deepStrictEqual(externalRequestBinding.buildManifest(request, CONTEXT), externalRequestBinding.buildManifest(request, CONTEXT));
    });
});
describe("external request protocol binding", () => {
    test("emits REQUEST_EXTERNAL with the manifest and resolution paths", () => {
        const manifest = externalRequestBinding.buildManifest({
            label: "push-repo-a",
            requestType: "git.push",
            payload: { targetSha: "abc123" },
        }, CONTEXT);
        const manifestPath = join(RUN_DIR, "external-requests", "push-repo-a.json");
        const block = externalRequestBinding.buildProtocolBlock(manifest, manifestPath, `node main.js --run-id ${RUN_ID} --resume`);
        const parsed = parseProtocolBlock(block);
        assert.strictEqual(parsed?.action, "REQUEST_EXTERNAL");
        assert.strictEqual(parsed?.runId, RUN_ID);
        assert.strictEqual(parsed?.fields.requestId, `${RUN_ID}/push-repo-a`);
        assert.strictEqual(parsed?.fields.requestType, "git.push");
        assert.strictEqual(parsed?.fields.manifest, manifestPath);
        assert.strictEqual(parsed?.fields.result, manifest.resultPath);
    });
});
//# sourceMappingURL=external-request-binding.test.js.map