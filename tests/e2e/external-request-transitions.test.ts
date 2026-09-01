import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import type { ProtocolAction } from "../../src/services/protocol.js";
import {
	buildEntrypointSource,
	countProtocolBlocks,
	createE2EWorkspace,
	parseSingleProtocolBlock,
	readEvents,
	readStateFile,
	writeExternalResolution,
	writePromptResult,
} from "../helpers/e2e-process.js";

const RUN_IDS = {
	externalToDelegate: "01HX0000000000000000000037",
	delegationToExternal: "01HX0000000000000000000038",
	externalToFail: "01HX0000000000000000000039",
} as const;
function baseResumeCommandSource(): string {
	return '(runId) => "node " + import.meta.filename + " --run-id " + runId + " --resume"';
}
function expectProtocol(stdout: string, action: ProtocolAction, runId: string) {
	assert.strictEqual(countProtocolBlocks(stdout), 1);
	const block = parseSingleProtocolBlock(stdout);
	assert.strictEqual(block.action, action);
	assert.strictEqual(block.runId, runId);
	return block;
}
describe("pending yield cleanup across result kinds", () => {
	test("a delegation emitted after external resolution replaces the external pending record", async () => {
		const workspace = createE2EWorkspace();
		const entrypoint = workspace.writeEntrypoint(
			"external-to-delegate.ts",
			buildEntrypointSource(`
interface State { stage: string }

await runOrchestrator<State>({
	name: "e2e-external-to-delegate",
	initial: "external",
	initialState: { stage: "initial" },
	resumeCommand: ${baseResumeCommandSource()},
	phases: {
		external: definePhase<State>(async (_state, io) =>
			io.requestExternal(
				{ label: "external-work", requestType: "example.work", payload: null },
				"delegate-next",
				{ stage: "external-done" },
			),
		),
		"delegate-next": definePhase<State>(async (state, io) => {
			io.consumePendingExternalResolution(z.object({ ok: z.boolean() }));
			return io.delegate(
				{ kind: "prompt", label: "review", prompt: "review" },
				"finish",
				{ ...state, stage: "delegated" },
			);
		}),
		finish: definePhase<State>(async (_state, io) => {
			io.consumePendingResult(z.object({ ok: z.boolean() }));
			return io.done({ ok: true });
		}),
	},
});
`),
		);
		try {
			const initial = await workspace.runEntrypoint(entrypoint, [
				"--run-id",
				RUN_IDS.externalToDelegate,
			]);
			expectProtocol(
				initial.stdout,
				"REQUEST_EXTERNAL",
				RUN_IDS.externalToDelegate,
			);
			const runDir = workspace.runDir(
				"e2e-external-to-delegate",
				RUN_IDS.externalToDelegate,
			);
			writeExternalResolution(runDir, "external-work", { ok: true });
			const resumed = await workspace.runEntrypoint(entrypoint, [
				"--resume",
				"--run-id",
				RUN_IDS.externalToDelegate,
			]);
			assert.strictEqual(resumed.exitCode, 0);
			expectProtocol(resumed.stdout, "DELEGATE", RUN_IDS.externalToDelegate);
			const state = readStateFile<{
				stage: string;
			}>(runDir);
			assert.partialDeepStrictEqual(state.pendingDelegation, {
				label: "review",
			});
			assert.ok(!("pendingExternalRequest" in Object(state)));
			assert.deepStrictEqual(state.usedLabels, ["external-work", "review"]);
			assert.strictEqual(existsSync(join(runDir, ".lock")), false);
		} finally {
			workspace.cleanup();
		}
	});
	test("an external request emitted after delegation resolution replaces the delegation pending record", async () => {
		const workspace = createE2EWorkspace();
		const entrypoint = workspace.writeEntrypoint(
			"delegate-to-external.ts",
			buildEntrypointSource(`
interface State { stage: string }

await runOrchestrator<State>({
	name: "e2e-delegate-to-external",
	initial: "delegate-first",
	initialState: { stage: "initial" },
	resumeCommand: ${baseResumeCommandSource()},
	phases: {
		"delegate-first": definePhase<State>(async (_state, io) =>
			io.delegate(
				{ kind: "prompt", label: "review", prompt: "review" },
				"external-next",
				{ stage: "reviewed" },
			),
		),
		"external-next": definePhase<State>(async (state, io) => {
			io.consumePendingResult(z.object({ ok: z.boolean() }));
			return io.requestExternal(
				{ label: "external-work", requestType: "example.work", payload: null },
				"finish",
				{ ...state, stage: "waiting-external" },
			);
		}),
		finish: definePhase<State>(async (_state, io) => {
			io.consumePendingExternalResolution(z.object({ ok: z.boolean() }));
			return io.done({ ok: true });
		}),
	},
});
`),
		);
		try {
			const initial = await workspace.runEntrypoint(entrypoint, [
				"--run-id",
				RUN_IDS.delegationToExternal,
			]);
			expectProtocol(initial.stdout, "DELEGATE", RUN_IDS.delegationToExternal);
			const runDir = workspace.runDir(
				"e2e-delegate-to-external",
				RUN_IDS.delegationToExternal,
			);
			writePromptResult(runDir, "review", 0, { ok: true });
			const resumed = await workspace.runEntrypoint(entrypoint, [
				"--resume",
				"--run-id",
				RUN_IDS.delegationToExternal,
			]);
			assert.strictEqual(resumed.exitCode, 0);
			expectProtocol(
				resumed.stdout,
				"REQUEST_EXTERNAL",
				RUN_IDS.delegationToExternal,
			);
			const state = readStateFile<{
				stage: string;
			}>(runDir);
			assert.partialDeepStrictEqual(state.pendingExternalRequest, {
				label: "external-work",
			});
			assert.ok(!("pendingDelegation" in Object(state)));
			assert.deepStrictEqual(state.usedLabels, ["review", "external-work"]);
		} finally {
			workspace.cleanup();
		}
	});
	test("fail after consuming an external resolution clears both pending record kinds", async () => {
		const workspace = createE2EWorkspace();
		const entrypoint = workspace.writeEntrypoint(
			"external-to-fail.ts",
			buildEntrypointSource(`
interface State { stage: string }

await runOrchestrator<State>({
	name: "e2e-external-to-fail",
	initial: "request",
	initialState: { stage: "initial" },
	resumeCommand: ${baseResumeCommandSource()},
	phases: {
		request: definePhase<State>(async (_state, io) =>
			io.requestExternal(
				{ label: "external-work", requestType: "example.work", payload: null },
				"fail-next",
				{ stage: "waiting" },
			),
		),
		"fail-next": definePhase<State>(async (_state, io) => {
			io.consumePendingExternalResolution(z.object({ ok: z.boolean() }));
			return io.fail(new Error("external result rejected by phase"));
		}),
	},
});
`),
		);
		try {
			const initial = await workspace.runEntrypoint(entrypoint, [
				"--run-id",
				RUN_IDS.externalToFail,
			]);
			assert.strictEqual(initial.exitCode, 0);
			const runDir = workspace.runDir(
				"e2e-external-to-fail",
				RUN_IDS.externalToFail,
			);
			writeExternalResolution(runDir, "external-work", { ok: false });
			const resumed = await workspace.runEntrypoint(entrypoint, [
				"--resume",
				"--run-id",
				RUN_IDS.externalToFail,
			]);
			assert.strictEqual(resumed.exitCode, 1);
			const error = expectProtocol(
				resumed.stdout,
				"ERROR",
				RUN_IDS.externalToFail,
			);
			assert.strictEqual(
				error.fields.message,
				"external result rejected by phase",
			);
			const state = readStateFile<{
				stage: string;
			}>(runDir);
			assert.ok(!("pendingExternalRequest" in Object(state)));
			assert.ok(!("pendingDelegation" in Object(state)));
			assert.strictEqual(
				readEvents(runDir).some(
					(event) => event.eventType === "retry_scheduled",
				),
				false,
			);
		} finally {
			workspace.cleanup();
		}
	});
});
