import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { nodeSqliteDriver } from "../../src/persistence/sqlite/node-sqlite-driver.js";
import {
	buildEntrypointSource,
	countProtocolBlocks,
	createE2EWorkspace,
	parseSingleProtocolBlock,
	readEvents,
	readStateFile,
} from "../helpers/e2e-process.js";

const INVALID_CASES = [
	{
		name: "empty worker name",
		target: { kind: "worker", name: "" },
		runId: "01HX0000000000000000000111",
	},
	{
		name: "host with an extra field",
		target: { kind: "host", name: "illegal-extra-field" },
		runId: "01HX0000000000000000000112",
	},
	{
		name: "unknown target kind",
		target: { kind: "unknown" },
		runId: "01HX0000000000000000000113",
	},
] as const;

function entrypointSource(): string {
	return buildEntrypointSource(`
interface State { step: number }
const target = JSON.parse(process.env.INVALID_TARGET ?? "null") as unknown;

await runOrchestrator<State>({
	name: "e2e-invalid-delegation-target",
	initial: "delegate",
	initialState: { step: 0 },
	resumeCommand: (runId) => "node invalid-target.ts --run-id " + runId + " --resume",
	phases: {
		delegate: definePhase<State>(async (state, io) =>
			io.delegate(
				{
					kind: "prompt",
					target,
					prompt: "must never be exposed",
					label: "invalid-target",
				} as never,
				"finish",
				{ ...state, step: 1 },
			),
		),
		finish: definePhase<State>(async (state, io) => io.done(state)),
	},
});
`);
}

function countManifestArtifacts(runDir: string): number {
	const root = join(runDir, "artifacts", "sha256");
	if (!existsSync(root)) return 0;
	let count = 0;
	function visit(directory: string): void {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) visit(path);
			else if (entry.isFile() && entry.name.endsWith(".json")) count += 1;
		}
	}
	visit(root);
	return count;
}

describe("invalid runtime delegation targets fail before semantic persistence", () => {
	for (const invalidCase of INVALID_CASES) {
		test(invalidCase.name, async () => {
			const workspace = createE2EWorkspace();
			const entrypoint = workspace.writeEntrypoint(
				"invalid-target.ts",
				entrypointSource(),
			);
			try {
				const result = await workspace.runEntrypoint(
					entrypoint,
					["--run-id", invalidCase.runId],
					{ env: { INVALID_TARGET: JSON.stringify(invalidCase.target) } },
				);
				assert.strictEqual(result.exitCode, 1);
				assert.strictEqual(countProtocolBlocks(result.stdout), 1);
				const block = parseSingleProtocolBlock(result.stdout);
				assert.strictEqual(block.action, "ERROR");
				assert.strictEqual(block.fields.errorKind, "invalid_config");
				assert.strictEqual(result.stdout.includes("action: DELEGATE"), false);

				const runDir = workspace.runDir(
					"e2e-invalid-delegation-target",
					invalidCase.runId,
				);
				assert.strictEqual(
					existsSync(join(runDir, "delegations", "invalid-target-0.json")),
					false,
				);
				assert.strictEqual(countManifestArtifacts(runDir), 0);
				const projectedState = readStateFile<{ step: number }>(runDir);
				assert.strictEqual("pendingDelegation" in projectedState, false);
				assert.deepStrictEqual(projectedState.usedLabels, []);
				assert.strictEqual(projectedState.data.step, 0);

				const database = nodeSqliteDriver.open(
					join(runDir, "turnlock.sqlite3"),
				);
				try {
					const row = database
						.prepare("SELECT state_json FROM run_state WHERE singleton = 1")
						.get<{ readonly state_json: string }>();
					assert.ok(row !== undefined);
					const authoritativeState = JSON.parse(row.state_json) as Record<
						string,
						unknown
					>;
					assert.strictEqual("pendingDelegation" in authoritativeState, false);
					assert.deepStrictEqual(authoritativeState.usedLabels, []);
				} finally {
					database.close();
				}

				const events = readEvents(runDir);
				assert.strictEqual(
					events.some((event) => event.eventType === "delegation_emit"),
					false,
				);
				assert.strictEqual(
					events.some((event) => event.eventType === "retry_scheduled"),
					false,
				);
			} finally {
				workspace.cleanup();
			}
		});
	}
});
