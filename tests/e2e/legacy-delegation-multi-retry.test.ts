import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { DelegationManifest } from "../../src/bindings/types.js";
import {
	buildEntrypointSource,
	countProtocolBlocks,
	createE2EWorkspace,
	parseSingleProtocolBlock,
	readEvents,
	readManifestFile,
	writeMalformedPromptResult,
} from "../helpers/e2e-process.js";
import { rewriteStoredManifestAsV2 } from "../helpers/legacy-delegation-manifest.js";

const RUN_ID = "01HX0000000000000000000104";
const LEGACY_WORKER_NAME = "Commit Msg [old]!";

function entrypointSource(): string {
	return buildEntrypointSource(`
interface State { count: number }

await runOrchestrator<State>({
	name: "e2e-legacy-v2-multi-retry",
	initial: "ask",
	initialState: { count: 0 },
	resumeCommand: (runId) => "node " + import.meta.filename + " --run-id " + runId + " --resume",
	phases: {
		ask: definePhase<State>(async (_state, io) =>
			io.delegate(
				{
					kind: "prompt",
					target: { kind: "worker", name: "reviewer" },
					prompt: "verdict",
					label: "retryable",
					retry: { maxAttempts: 3, backoffBaseMs: 1, maxBackoffMs: 1 },
				},
				"finish",
				{ count: 1 },
			),
		),
		finish: definePhase<State>(async (_state, io) => {
			const result = io.consumePendingResult(z.object({ verdict: z.string() }));
			return io.done({ verdict: result.verdict });
		}),
	},
});
`);
}

function expectDelegateManifest(
	stdout: string,
): DelegationManifest & { readonly targetCompatibility?: string } {
	assert.strictEqual(countProtocolBlocks(stdout), 1);
	const block = parseSingleProtocolBlock(stdout);
	assert.strictEqual(block.action, "DELEGATE");
	return readManifestFile(
		String(block.fields.manifest),
	) as DelegationManifest & {
		readonly targetCompatibility?: string;
	};
}

describe("legacy v2 logical target durability across multiple retries", () => {
	test("a migrated historical worker stays valid through attempt 2", async () => {
		const workspace = createE2EWorkspace();
		const entrypoint = workspace.writeEntrypoint(
			"legacy-v2-multi-retry.ts",
			entrypointSource(),
		);
		try {
			const initial = await workspace.runEntrypoint(entrypoint, [
				"--run-id",
				RUN_ID,
			]);
			assert.strictEqual(initial.exitCode, 0);
			expectDelegateManifest(initial.stdout);
			const runDir = workspace.runDir("e2e-legacy-v2-multi-retry", RUN_ID);
			rewriteStoredManifestAsV2(runDir, "retryable", {
				worker: LEGACY_WORKER_NAME,
			});

			writeMalformedPromptResult(runDir, "retryable", 0, "{not-json");
			const firstRetry = await workspace.runEntrypoint(entrypoint, [
				"--resume",
				"--run-id",
				RUN_ID,
			]);
			assert.strictEqual(firstRetry.exitCode, 0);
			const attempt1 = expectDelegateManifest(firstRetry.stdout);
			assert.strictEqual(attempt1.attempt, 1);
			assert.deepStrictEqual(attempt1.target, {
				kind: "worker",
				name: LEGACY_WORKER_NAME,
			});
			assert.strictEqual(attempt1.targetCompatibility, "legacy-v2");

			writeMalformedPromptResult(runDir, "retryable", 1, "{still-not-json");
			const secondRetry = await workspace.runEntrypoint(entrypoint, [
				"--resume",
				"--run-id",
				RUN_ID,
			]);
			assert.strictEqual(secondRetry.exitCode, 0, secondRetry.stderr);
			const attempt2 = expectDelegateManifest(secondRetry.stdout);
			assert.strictEqual(attempt2.attempt, 2);
			assert.deepStrictEqual(attempt2.target, attempt1.target);
			assert.strictEqual(attempt2.targetCompatibility, "legacy-v2");

			const emits = readEvents(runDir).filter(
				(event) => event.eventType === "delegation_emit",
			);
			assert.strictEqual(emits.length, 3);
			// The initial event predates the test's authoritative v2 replacement;
			// both descendant retry events must carry the migrated logical target.
			for (const event of emits.slice(1)) {
				if (event.eventType !== "delegation_emit") assert.fail("unreachable");
				assert.deepStrictEqual(event.target, {
					kind: "worker",
					name: LEGACY_WORKER_NAME,
				});
				assert.strictEqual("targetCompatibility" in event, false);
			}
		} finally {
			workspace.cleanup();
		}
	});
});
