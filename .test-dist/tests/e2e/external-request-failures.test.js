import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync, } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { nodeSqliteDriver } from "../../src/persistence/sqlite/node-sqlite-driver.js";
import { assertArrayContainsPartialDeepEqual } from "../helpers/assertions.js";
import { buildEntrypointSource, countProtocolBlocks, createE2EWorkspace, parseSingleProtocolBlock, readEvents, readStateFile, writeExternalResolution, writeMalformedExternalResolution, } from "../helpers/e2e-process.js";
const RUN_IDS = {
    malformed: "01HX0000000000000000000033",
    unreadable: "01HX0000000000000000000034",
    schema: "01HX0000000000000000000035",
    orphan: "01HX0000000000000000000036",
    pathEscape: "01HX0000000000000000000042",
    symlink: "01HX0000000000000000000043",
    manifestMismatch: "01HX0000000000000000000045",
    manifestPayloadTamper: "01HX0000000000000000000046",
    manifestMetadataTamper: "01HX0000000000000000000047",
    manifestRequestTypeTamper: "01HX0000000000000000000048",
    acceptedResolutionTamper: "01HX0000000000000000000050",
    acceptedResolutionRecovery: "01HX0000000000000000000051",
};
function baseResumeCommandSource() {
    return '(runId) => "node " + import.meta.filename + " --run-id " + runId + " --resume"';
}
function expectProtocol(stdout, action, runId) {
    assert.strictEqual(countProtocolBlocks(stdout), 1);
    const block = parseSingleProtocolBlock(stdout);
    assert.strictEqual(block.action, action);
    assert.strictEqual(block.runId, runId);
    return block;
}
function eventTypes(events) {
    return events.map((event) => event.eventType);
}
function failureSource(orchestratorName) {
    return buildEntrypointSource(`
interface State { stage: string }

await runOrchestrator<State>({
	name: ${JSON.stringify(orchestratorName)},
	initial: "request",
	initialState: { stage: "initial" },
	resumeCommand: ${baseResumeCommandSource()},
	phases: {
		request: definePhase<State>(async (_state, io) =>
			io.requestExternal(
				{ label: "external-work", requestType: "example.work", payload: { secret: "not-for-logs" } },
				"consume",
				{ stage: "waiting" },
			),
		),
		consume: definePhase<State>(async (_state, io) => {
			const resolution = io.consumePendingExternalResolution(
				z.object({ outcome: z.enum(["OK", "FAILED"]) }),
			);
			return io.done(resolution);
		}),
	},
});
`);
}
describe("external resolution failures are terminal and non-retrying", () => {
    test("malformed JSON fails closed without changing the manifest or creating another request", async () => {
        const workspace = createE2EWorkspace();
        const entrypoint = workspace.writeEntrypoint("external-malformed.ts", failureSource("e2e-external-malformed"));
        try {
            const initial = await workspace.runEntrypoint(entrypoint, [
                "--run-id",
                RUN_IDS.malformed,
            ]);
            const request = expectProtocol(initial.stdout, "REQUEST_EXTERNAL", RUN_IDS.malformed);
            const runDir = workspace.runDir("e2e-external-malformed", RUN_IDS.malformed);
            const manifestPath = request.fields.manifest;
            const manifestBefore = readFileSync(manifestPath, "utf-8");
            writeMalformedExternalResolution(runDir, "external-work", '{"outcome":');
            const resumed = await workspace.runEntrypoint(entrypoint, [
                "--resume",
                "--run-id",
                RUN_IDS.malformed,
            ]);
            assert.strictEqual(resumed.exitCode, 1);
            const error = expectProtocol(resumed.stdout, "ERROR", RUN_IDS.malformed);
            assert.strictEqual(error.fields.errorKind, "external_resolution_malformed");
            assert.strictEqual(readFileSync(manifestPath, "utf-8"), manifestBefore);
            assert.deepStrictEqual(readdirSync(join(runDir, "external-requests")), [
                "external-work.json",
            ]);
            assert.deepStrictEqual(readdirSync(join(runDir, "accepted-external-resolutions")), []);
            const state = readStateFile(runDir);
            assert.strictEqual(state.pendingExternalRequest?.requestId, `${RUN_IDS.malformed}/external-work`);
            const events = readEvents(runDir);
            assertArrayContainsPartialDeepEqual(events, {
                eventType: "external_resolution_validation_failed",
                reason: "malformed_json",
            });
            assert.ok(!eventTypes(events).includes("retry_scheduled"));
            assert.ok(!eventTypes(events).includes("external_request_reemit"));
            assert.strictEqual(resultHasSensitiveData(events, resumed.stderr), false);
        }
        finally {
            workspace.cleanup();
        }
    });
    test("an unreadable resolution path fails closed without retry", async () => {
        const workspace = createE2EWorkspace();
        const entrypoint = workspace.writeEntrypoint("external-unreadable.ts", failureSource("e2e-external-unreadable"));
        try {
            const initial = await workspace.runEntrypoint(entrypoint, [
                "--run-id",
                RUN_IDS.unreadable,
            ]);
            assert.strictEqual(initial.exitCode, 0);
            const runDir = workspace.runDir("e2e-external-unreadable", RUN_IDS.unreadable);
            mkdirSync(join(runDir, "external-results", "external-work.json"));
            const resumed = await workspace.runEntrypoint(entrypoint, [
                "--resume",
                "--run-id",
                RUN_IDS.unreadable,
            ]);
            assert.strictEqual(resumed.exitCode, 1);
            const error = expectProtocol(resumed.stdout, "ERROR", RUN_IDS.unreadable);
            assert.strictEqual(error.fields.errorKind, "external_resolution_malformed");
            const events = readEvents(runDir);
            assertArrayContainsPartialDeepEqual(events, {
                eventType: "external_resolution_validation_failed",
                reason: "unreadable",
            });
            assert.ok(!eventTypes(events).includes("retry_scheduled"));
        }
        finally {
            workspace.cleanup();
        }
    });
    test("schema-invalid JSON fails with its dedicated error and no delegation retry", async () => {
        const workspace = createE2EWorkspace();
        const entrypoint = workspace.writeEntrypoint("external-schema.ts", failureSource("e2e-external-schema"));
        try {
            const initial = await workspace.runEntrypoint(entrypoint, [
                "--run-id",
                RUN_IDS.schema,
            ]);
            assert.strictEqual(initial.exitCode, 0);
            const runDir = workspace.runDir("e2e-external-schema", RUN_IDS.schema);
            writeExternalResolution(runDir, "external-work", { outcome: 42 });
            const resumed = await workspace.runEntrypoint(entrypoint, [
                "--resume",
                "--run-id",
                RUN_IDS.schema,
            ]);
            assert.strictEqual(resumed.exitCode, 1);
            const error = expectProtocol(resumed.stdout, "ERROR", RUN_IDS.schema);
            assert.strictEqual(error.fields.errorKind, "external_resolution_schema");
            const events = readEvents(runDir);
            assertArrayContainsPartialDeepEqual(events, {
                eventType: "external_resolution_validation_failed",
                reason: "schema_invalid",
            });
            assert.ok(!eventTypes(events).includes("retry_scheduled"));
            assert.deepStrictEqual(readdirSync(join(runDir, "external-requests")), [
                "external-work.json",
            ]);
        }
        finally {
            workspace.cleanup();
        }
    });
    test("an accepted schema-invalid resolution cannot be replaced or tampered with", async () => {
        const workspace = createE2EWorkspace();
        const entrypoint = workspace.writeEntrypoint("external-accepted-tamper.ts", failureSource("e2e-external-accepted-tamper"));
        try {
            const initial = await workspace.runEntrypoint(entrypoint, [
                "--run-id",
                RUN_IDS.acceptedResolutionTamper,
            ]);
            assert.strictEqual(initial.exitCode, 0);
            const runDir = workspace.runDir("e2e-external-accepted-tamper", RUN_IDS.acceptedResolutionTamper);
            writeExternalResolution(runDir, "external-work", { outcome: 42 });
            const firstResume = await workspace.runEntrypoint(entrypoint, [
                "--resume",
                "--run-id",
                RUN_IDS.acceptedResolutionTamper,
            ]);
            assert.strictEqual(firstResume.exitCode, 1);
            assert.strictEqual(expectProtocol(firstResume.stdout, "ERROR", RUN_IDS.acceptedResolutionTamper).fields.errorKind, "external_resolution_schema");
            const acceptedState = readStateFile(runDir);
            const acceptedPath = acceptedState.pendingExternalRequest?.acceptedResolutionPath;
            assert.strictEqual(acceptedPath, join(runDir, "accepted-external-resolutions", "external-work.json"));
            const acceptedBefore = readFileSync(acceptedPath, "utf-8");
            assert.strictEqual(acceptedBefore, '{"outcome":42}');
            writeExternalResolution(runDir, "external-work", { outcome: "OK" });
            const secondResume = await workspace.runEntrypoint(entrypoint, [
                "--resume",
                "--run-id",
                RUN_IDS.acceptedResolutionTamper,
            ]);
            assert.strictEqual(secondResume.exitCode, 1);
            assert.strictEqual(expectProtocol(secondResume.stdout, "ERROR", RUN_IDS.acceptedResolutionTamper).fields.errorKind, "external_resolution_schema");
            assert.strictEqual(readFileSync(acceptedPath, "utf-8"), acceptedBefore);
            writeFileSync(acceptedPath, '{"outcome":"OK"}');
            const tamperedResume = await workspace.runEntrypoint(entrypoint, [
                "--resume",
                "--run-id",
                RUN_IDS.acceptedResolutionTamper,
            ]);
            assert.strictEqual(tamperedResume.exitCode, 1);
            assert.strictEqual(expectProtocol(tamperedResume.stdout, "ERROR", RUN_IDS.acceptedResolutionTamper).fields.errorKind, "state_corrupted");
            assert.ok(!eventTypes(readEvents(runDir)).includes("retry_scheduled"));
        }
        finally {
            workspace.cleanup();
        }
    });
    test("an accepted artifact is recovered when its state descriptor was not committed", async () => {
        const workspace = createE2EWorkspace();
        const entrypoint = workspace.writeEntrypoint("external-accepted-recovery.ts", failureSource("e2e-external-accepted-recovery"));
        try {
            const initial = await workspace.runEntrypoint(entrypoint, [
                "--run-id",
                RUN_IDS.acceptedResolutionRecovery,
            ]);
            assert.strictEqual(initial.exitCode, 0);
            const runDir = workspace.runDir("e2e-external-accepted-recovery", RUN_IDS.acceptedResolutionRecovery);
            writeExternalResolution(runDir, "external-work", { outcome: 42 });
            const accepted = await workspace.runEntrypoint(entrypoint, [
                "--resume",
                "--run-id",
                RUN_IDS.acceptedResolutionRecovery,
            ]);
            assert.strictEqual(accepted.exitCode, 1);
            const statePath = join(runDir, "state.json");
            const state = JSON.parse(readFileSync(statePath, "utf-8"));
            const acceptedPath = state.pendingExternalRequest
                .acceptedResolutionPath;
            const acceptedBefore = readFileSync(acceptedPath, "utf-8");
            Reflect.deleteProperty(state.pendingExternalRequest, "acceptedResolutionPath");
            Reflect.deleteProperty(state.pendingExternalRequest, "acceptedResolutionDigest");
            Reflect.deleteProperty(state.pendingExternalRequest, "acceptedAt");
            writeFileSync(statePath, JSON.stringify(state));
            writeExternalResolution(runDir, "external-work", { outcome: "OK" });
            const recovered = await workspace.runEntrypoint(entrypoint, [
                "--resume",
                "--run-id",
                RUN_IDS.acceptedResolutionRecovery,
            ]);
            assert.strictEqual(recovered.exitCode, 1);
            assert.strictEqual(expectProtocol(recovered.stdout, "ERROR", RUN_IDS.acceptedResolutionRecovery).fields.errorKind, "external_resolution_schema");
            const recoveredState = readStateFile(runDir);
            assert.strictEqual(recoveredState.pendingExternalRequest?.acceptedResolutionPath, acceptedPath);
            const recoveredDigest = recoveredState.pendingExternalRequest?.acceptedResolutionDigest;
            if (typeof recoveredDigest !== "string") {
                assert.fail("expected the recovered accepted resolution digest");
            }
            assert.match(recoveredDigest, /^sha256:[0-9a-f]{64}$/);
            assert.strictEqual(readFileSync(acceptedPath, "utf-8"), acceptedBefore);
        }
        finally {
            workspace.cleanup();
        }
    });
});
function resultHasSensitiveData(events, stderr) {
    return (JSON.stringify(events).includes("not-for-logs") ||
        stderr.includes("not-for-logs"));
}
describe("external request manifest identity", () => {
    async function expectManifestTamperRejected(runId, orchestratorName, mutate) {
        const workspace = createE2EWorkspace();
        const entrypoint = workspace.writeEntrypoint(`${orchestratorName}.ts`, failureSource(orchestratorName));
        try {
            const initial = await workspace.runEntrypoint(entrypoint, [
                "--run-id",
                runId,
            ]);
            expectProtocol(initial.stdout, "REQUEST_EXTERNAL", runId);
            const runDir = workspace.runDir(orchestratorName, runId);
            // Read state to find the immutable blob path.
            const state = readStateFile(runDir);
            const artifactRef = state.pendingExternalRequest?.manifestArtifact;
            if (!artifactRef) {
                throw new Error("manifestArtifact missing from state");
            }
            const blobPath = join(runDir, artifactRef.relativePath);
            // Tamper with the immutable blob, not the canonical projection.
            const blob = JSON.parse(readFileSync(blobPath, "utf-8"));
            writeFileSync(blobPath, JSON.stringify(mutate(blob)));
            const resumed = await workspace.runEntrypoint(entrypoint, [
                "--resume",
                "--run-id",
                runId,
            ]);
            assert.strictEqual(resumed.exitCode, 1);
            const error = expectProtocol(resumed.stdout, "ERROR", runId);
            // Tampering with the immutable blob causes an artifact integrity error.
            assert.strictEqual(error.fields.errorKind, "artifact_integrity");
            const types = eventTypes(readEvents(runDir));
            assert.ok(!types.includes("external_request_reemit"));
            assert.ok(!types.includes("external_resolution_read"));
        }
        finally {
            workspace.cleanup();
        }
    }
    test("changing manifest payload under the same requestId fails closed", async () => {
        await expectManifestTamperRejected(RUN_IDS.manifestPayloadTamper, "e2e-external-manifest-payload-tamper", (manifest) => ({ ...manifest, payload: { changed: true } }));
    });
    test("changing manifest metadata under the same requestId fails closed", async () => {
        await expectManifestTamperRejected(RUN_IDS.manifestMetadataTamper, "e2e-external-manifest-metadata-tamper", (manifest) => ({ ...manifest, metadata: { changed: true } }));
    });
    test("changing manifest requestType under the same requestId fails closed", async () => {
        await expectManifestTamperRejected(RUN_IDS.manifestRequestTypeTamper, "e2e-external-manifest-request-type-tamper", (manifest) => ({ ...manifest, requestType: "example.changed" }));
    });
    test("a manifest identity mismatch fails closed even when a resolution exists", async () => {
        const workspace = createE2EWorkspace();
        const entrypoint = workspace.writeEntrypoint("external-manifest-mismatch.ts", failureSource("e2e-external-manifest-mismatch"));
        try {
            const initial = await workspace.runEntrypoint(entrypoint, [
                "--run-id",
                RUN_IDS.manifestMismatch,
            ]);
            expectProtocol(initial.stdout, "REQUEST_EXTERNAL", RUN_IDS.manifestMismatch);
            const runDir = workspace.runDir("e2e-external-manifest-mismatch", RUN_IDS.manifestMismatch);
            // Read state to find the immutable blob path.
            const state = readStateFile(runDir);
            const artifactRef = state.pendingExternalRequest?.manifestArtifact;
            if (!artifactRef) {
                throw new Error("manifestArtifact missing from state");
            }
            const blobPath = join(runDir, artifactRef.relativePath);
            const manifest = JSON.parse(readFileSync(blobPath, "utf-8"));
            writeFileSync(blobPath, JSON.stringify({ ...manifest, orchestratorName: "other-orchestrator" }));
            writeExternalResolution(runDir, "external-work", { outcome: "OK" });
            const resumed = await workspace.runEntrypoint(entrypoint, [
                "--resume",
                "--run-id",
                RUN_IDS.manifestMismatch,
            ]);
            assert.strictEqual(resumed.exitCode, 1);
            const error = expectProtocol(resumed.stdout, "ERROR", RUN_IDS.manifestMismatch);
            assert.strictEqual(error.fields.errorKind, "artifact_integrity");
            const types = eventTypes(readEvents(runDir));
            assert.ok(!types.includes("external_resolution_read"));
            assert.ok(!types.includes("retry_scheduled"));
        }
        finally {
            workspace.cleanup();
        }
    });
});
describe("external request path confinement", () => {
    test("a persisted result path outside RUN_DIR is rejected as corrupted state", async () => {
        const workspace = createE2EWorkspace();
        const entrypoint = workspace.writeEntrypoint("external-path-escape.ts", failureSource("e2e-external-path-escape"));
        try {
            const initial = await workspace.runEntrypoint(entrypoint, [
                "--run-id",
                RUN_IDS.pathEscape,
            ]);
            assert.strictEqual(initial.exitCode, 0);
            const runDir = workspace.runDir("e2e-external-path-escape", RUN_IDS.pathEscape);
            const outsidePath = join(workspace.root, "outside-resolution.json");
            writeFileSync(outsidePath, '{"outcome":"OK","secret":"outside"}');
            // Tamper with the SQLite authoritative state, not state.json.
            const dbPath = join(runDir, "turnlock.sqlite3");
            const db = nodeSqliteDriver.open(dbPath);
            try {
                const row = db
                    .prepare("SELECT state_json FROM run_state WHERE singleton = 1")
                    .get();
                if (row) {
                    const parsed = JSON.parse(row.state_json);
                    const pending = parsed.pendingExternalRequest;
                    pending.resultPath = outsidePath;
                    const newJson = JSON.stringify(parsed);
                    const newDigest = `sha256:${createHash("sha256").update(newJson).digest("hex")}`;
                    db.prepare("UPDATE run_state SET state_json = ?, state_digest = ? WHERE singleton = 1").run(newJson, newDigest);
                }
            }
            finally {
                db.close();
            }
            const resumed = await workspace.runEntrypoint(entrypoint, [
                "--resume",
                "--run-id",
                RUN_IDS.pathEscape,
            ]);
            assert.strictEqual(resumed.exitCode, 1);
            const error = expectProtocol(resumed.stdout, "ERROR", RUN_IDS.pathEscape);
            assert.strictEqual(error.fields.errorKind, "state_corrupted");
            assert.ok(!resumed.stderr.includes("outside"));
        }
        finally {
            workspace.cleanup();
        }
    });
    test("a symlink resolution is rejected without reading its target", async () => {
        const workspace = createE2EWorkspace();
        const entrypoint = workspace.writeEntrypoint("external-symlink.ts", failureSource("e2e-external-symlink"));
        try {
            const initial = await workspace.runEntrypoint(entrypoint, [
                "--run-id",
                RUN_IDS.symlink,
            ]);
            assert.strictEqual(initial.exitCode, 0);
            const runDir = workspace.runDir("e2e-external-symlink", RUN_IDS.symlink);
            const outsidePath = join(workspace.root, "symlink-target.json");
            writeFileSync(outsidePath, '{"outcome":"OK","secret":"target"}');
            symlinkSync(outsidePath, join(runDir, "external-results", "external-work.json"));
            const resumed = await workspace.runEntrypoint(entrypoint, [
                "--resume",
                "--run-id",
                RUN_IDS.symlink,
            ]);
            assert.strictEqual(resumed.exitCode, 1);
            const error = expectProtocol(resumed.stdout, "ERROR", RUN_IDS.symlink);
            assert.strictEqual(error.fields.errorKind, "external_resolution_malformed");
            assert.ok(!resumed.stderr.includes("target"));
        }
        finally {
            workspace.cleanup();
        }
    });
});
describe("external request local crash windows", () => {
    test("an orphan manifest is non-authoritative when state.json is absent", async () => {
        const workspace = createE2EWorkspace();
        const entrypoint = workspace.writeEntrypoint("external-orphan.ts", failureSource("e2e-external-orphan"));
        const runDir = workspace.runDir("e2e-external-orphan", RUN_IDS.orphan);
        const manifestPath = join(runDir, "external-requests", "external-work.json");
        try {
            mkdirSync(join(runDir, "external-requests"), { recursive: true });
            writeFileSync(manifestPath, '{"kind":"external-request"}');
            const resumed = await workspace.runEntrypoint(entrypoint, [
                "--resume",
                "--run-id",
                RUN_IDS.orphan,
            ]);
            assert.strictEqual(resumed.exitCode, 1);
            const error = expectProtocol(resumed.stdout, "ERROR", RUN_IDS.orphan);
            assert.strictEqual(error.fields.errorKind, "state_missing");
            assert.strictEqual(existsSync(join(runDir, "state.json")), false);
            assert.strictEqual(readFileSync(manifestPath, "utf-8"), '{"kind":"external-request"}');
        }
        finally {
            workspace.cleanup();
        }
    });
});
//# sourceMappingURL=external-request-failures.test.js.map