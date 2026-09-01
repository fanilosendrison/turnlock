import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { buildEntrypointSource, countProtocolBlocks, createE2EWorkspace, parseSingleProtocolBlock, readEvents, readExternalRequestManifest, readJsonFile, readStateFile, writeExternalResolution, } from "../helpers/e2e-process.js";
const RUN_IDS = {
    initial: "01HX0000000000000000000030",
    resolved: "01HX0000000000000000000031",
    reemit: "01HX0000000000000000000032",
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
function lifecycleSource(orchestratorName) {
    return buildEntrypointSource(`
interface State { stage: string }

await runOrchestrator<State>({
	name: ${JSON.stringify(orchestratorName)},
	initial: "push",
	initialState: { stage: "initial" },
	resumeCommand: ${baseResumeCommandSource()},
	phases: {
		push: definePhase<State>(async (_state, io) =>
			io.requestExternal(
				{
					label: "push-repo-a",
					requestType: "git.push",
					payload: {
						repository: "/repo-a",
						remote: "origin",
						branch: "main",
						targetSha: "abc123",
					},
				},
				"after-push",
				{ stage: "waiting" },
			),
		),
		"after-push": definePhase<State>(async (state, io) => {
			const resolution = io.consumePendingExternalResolution(
				z.object({
					outcome: z.enum(["PUSHED", "REJECTED", "UNKNOWN"]),
					remoteSha: z.string().optional(),
				}),
			);
			return io.done({ state, resolution });
		}),
	},
});
`);
}
describe("external request lifecycle", () => {
    test("initial emission persists the manifest and pending state before yielding", async () => {
        const workspace = createE2EWorkspace();
        const entrypoint = workspace.writeEntrypoint("external-initial.ts", lifecycleSource("e2e-external-initial"));
        try {
            const result = await workspace.runEntrypoint(entrypoint, [
                "--run-id",
                RUN_IDS.initial,
            ]);
            assert.strictEqual(result.exitCode, 0);
            const block = expectProtocol(result.stdout, "REQUEST_EXTERNAL", RUN_IDS.initial);
            const runDir = workspace.runDir("e2e-external-initial", RUN_IDS.initial);
            const manifestPath = join(runDir, "external-requests", "push-repo-a.json");
            const resultPath = join(runDir, "external-results", "push-repo-a.json");
            assert.strictEqual(block.fields.requestId, `${RUN_IDS.initial}/push-repo-a`);
            assert.strictEqual(block.fields.requestType, "git.push");
            assert.strictEqual(block.fields.manifest, manifestPath);
            assert.strictEqual(block.fields.result, resultPath);
            const manifest = readExternalRequestManifest(manifestPath);
            assert.strictEqual(typeof manifest.emittedAt, "string");
            assert.strictEqual(typeof manifest.emittedAtEpochMs, "number");
            assert.deepStrictEqual(manifest, {
                manifestVersion: 1,
                kind: "external-request",
                requestId: `${RUN_IDS.initial}/push-repo-a`,
                runId: RUN_IDS.initial,
                orchestratorName: "e2e-external-initial",
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
                emittedAt: manifest.emittedAt,
                emittedAtEpochMs: manifest.emittedAtEpochMs,
                resultPath,
            });
            const state = readStateFile(runDir);
            assert.deepStrictEqual(state.data, { stage: "waiting" });
            assert.deepStrictEqual(state.usedLabels, ["push-repo-a"]);
            assert.partialDeepStrictEqual(state.pendingExternalRequest, {
                requestId: manifest.requestId,
                label: manifest.label,
                requestType: manifest.requestType,
                resumeAt: manifest.resumeAt,
                resultPath,
                emittedAt: manifest.emittedAt,
                emittedAtEpochMs: manifest.emittedAtEpochMs,
            });
            assert.notStrictEqual(state.pendingExternalRequest?.manifestArtifact, undefined);
            assert.strictEqual(state.pendingExternalRequest?.manifestArtifact?.kind, "external-request-manifest");
            assert.ok(!("pendingDelegation" in Object(state)));
            assert.strictEqual(state.lastTransitionAt, manifest.emittedAt);
            assert.strictEqual(state.lastTransitionAtEpochMs, manifest.emittedAtEpochMs);
            assert.strictEqual(existsSync(join(runDir, ".lock")), false);
            const events = readEvents(runDir);
            assert.deepStrictEqual(eventTypes(events), [
                "orchestrator_start",
                "phase_start",
                "phase_end",
                "external_request_emit",
            ]);
            const emitted = events.at(-1);
            assert.partialDeepStrictEqual(emitted, {
                eventType: "external_request_emit",
                runId: RUN_IDS.initial,
                phase: "push",
                label: "push-repo-a",
                requestId: `${RUN_IDS.initial}/push-repo-a`,
                requestType: "git.push",
            });
            assert.ok(!JSON.stringify(emitted).includes("repository"));
        }
        finally {
            workspace.cleanup();
        }
    });
    test("a durable opaque resolution resumes, validates, and clears the pending record", async () => {
        const workspace = createE2EWorkspace();
        const entrypoint = workspace.writeEntrypoint("external-resolved.ts", lifecycleSource("e2e-external-resolved"));
        try {
            const initial = await workspace.runEntrypoint(entrypoint, [
                "--run-id",
                RUN_IDS.resolved,
            ]);
            assert.strictEqual(initial.exitCode, 0);
            expectProtocol(initial.stdout, "REQUEST_EXTERNAL", RUN_IDS.resolved);
            const runDir = workspace.runDir("e2e-external-resolved", RUN_IDS.resolved);
            writeExternalResolution(runDir, "push-repo-a", {
                outcome: "PUSHED",
                remoteSha: "def456",
            });
            const resumed = await workspace.runEntrypoint(entrypoint, [
                "--resume",
                "--run-id",
                RUN_IDS.resolved,
            ]);
            assert.strictEqual(resumed.exitCode, 0);
            const done = expectProtocol(resumed.stdout, "DONE", RUN_IDS.resolved);
            assert.deepStrictEqual(readJsonFile(done.fields.output), {
                state: { stage: "waiting" },
                resolution: { outcome: "PUSHED", remoteSha: "def456" },
            });
            const acceptedResolutionPath = join(runDir, "accepted-external-resolutions", "push-repo-a.json");
            assert.strictEqual(readFileSync(acceptedResolutionPath, "utf-8"), '{"outcome":"PUSHED","remoteSha":"def456"}');
            const state = readStateFile(runDir);
            assert.strictEqual(state.currentPhase, "after-push");
            assert.strictEqual(state.phasesExecuted, 2);
            assert.ok(!("pendingExternalRequest" in Object(state)));
            assert.ok(!("pendingDelegation" in Object(state)));
            const types = eventTypes(readEvents(runDir));
            assert.ok(types.includes("external_resolution_read"));
            assert.ok(types.includes("external_resolution_validated"));
            assert.ok(!types.includes("retry_scheduled"));
            assert.strictEqual(existsSync(join(runDir, ".lock")), false);
        }
        finally {
            workspace.cleanup();
        }
    });
    test("missing resolution re-emits the identical request without mutating state or manifest", async () => {
        const workspace = createE2EWorkspace();
        const entrypoint = workspace.writeEntrypoint("external-reemit.ts", lifecycleSource("e2e-external-reemit"));
        try {
            const initial = await workspace.runEntrypoint(entrypoint, [
                "--run-id",
                RUN_IDS.reemit,
            ]);
            assert.strictEqual(initial.exitCode, 0);
            const firstBlock = expectProtocol(initial.stdout, "REQUEST_EXTERNAL", RUN_IDS.reemit);
            const runDir = workspace.runDir("e2e-external-reemit", RUN_IDS.reemit);
            const statePath = join(runDir, "state.json");
            const manifestPath = firstBlock.fields.manifest;
            const stateBefore = readFileSync(statePath, "utf-8");
            const manifestBefore = readFileSync(manifestPath, "utf-8");
            const resumed = await workspace.runEntrypoint(entrypoint, [
                "--resume",
                "--run-id",
                RUN_IDS.reemit,
            ]);
            assert.strictEqual(resumed.exitCode, 0);
            const secondBlock = expectProtocol(resumed.stdout, "REQUEST_EXTERNAL", RUN_IDS.reemit);
            assert.strictEqual(secondBlock.fields.requestId, firstBlock.fields.requestId);
            assert.strictEqual(secondBlock.fields.manifest, firstBlock.fields.manifest);
            assert.strictEqual(secondBlock.fields.result, firstBlock.fields.result);
            assert.strictEqual(readFileSync(statePath, "utf-8"), stateBefore);
            assert.strictEqual(readFileSync(manifestPath, "utf-8"), manifestBefore);
            assert.deepStrictEqual(readdirSync(join(runDir, "external-requests")), [
                "push-repo-a.json",
            ]);
            const resumedAgain = await workspace.runEntrypoint(entrypoint, [
                "--resume",
                "--run-id",
                RUN_IDS.reemit,
            ]);
            assert.strictEqual(resumedAgain.exitCode, 0);
            const thirdBlock = expectProtocol(resumedAgain.stdout, "REQUEST_EXTERNAL", RUN_IDS.reemit);
            assert.strictEqual(thirdBlock.fields.requestId, firstBlock.fields.requestId);
            assert.strictEqual(thirdBlock.fields.requestType, firstBlock.fields.requestType);
            assert.strictEqual(thirdBlock.fields.manifest, firstBlock.fields.manifest);
            assert.strictEqual(thirdBlock.fields.result, firstBlock.fields.result);
            assert.strictEqual(readFileSync(statePath, "utf-8"), stateBefore);
            assert.strictEqual(readFileSync(manifestPath, "utf-8"), manifestBefore);
            const manifest = readExternalRequestManifest(manifestPath);
            assert.strictEqual(manifest.emittedAt, JSON.parse(manifestBefore).emittedAt);
            assert.strictEqual(manifest.emittedAtEpochMs, JSON.parse(manifestBefore).emittedAtEpochMs);
            const events = readEvents(runDir);
            assert.strictEqual(events.filter((event) => event.eventType === "external_request_emit")
                .length, 1);
            assert.strictEqual(events.filter((event) => event.eventType === "external_request_reemit")
                .length, 2);
            assert.ok(!eventTypes(events).includes("retry_scheduled"));
            assert.strictEqual(existsSync(join(runDir, ".lock")), false);
        }
        finally {
            workspace.cleanup();
        }
    });
});
//# sourceMappingURL=external-request-lifecycle.test.js.map