import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { describe, test } from "node:test";
import { validateConfig } from "../../src/engine/preflight.js";
import { InvalidConfigError } from "../../src/errors/concrete.js";
import type { OrchestratorConfig } from "../../src/types/config.js";
import {
	buildEntrypointSource,
	createE2EWorkspace,
	parseSingleProtocolBlock,
} from "../helpers/e2e-process.js";

const INVALID_PHASE_VALUES: ReadonlyArray<{
	readonly label: string;
	readonly value: unknown;
}> = [
	{ label: "null", value: null },
	{ label: "string", value: "str" },
	{ label: "number", value: 42 },
];

function configWithPhaseValue(value: unknown): OrchestratorConfig<object> {
	return {
		name: "invalid-phase-value",
		initial: "p1",
		initialState: {},
		resumeCommand: (runId: string) =>
			`node runner.mjs --run-id ${runId} --resume`,
		phases: { p1: value },
	} as unknown as OrchestratorConfig<object>;
}

describe("preflight phase validation", () => {
	for (const { label, value } of INVALID_PHASE_VALUES) {
		test(`rejects a ${label} phase value`, () => {
			assert.throws(
				() => validateConfig(configWithPhaseValue(value)),
				(error: unknown) =>
					error instanceof InvalidConfigError &&
					error.message === 'phase "p1" must be a function',
			);
		});
	}

	test("rejects invalid phase values before creating a run directory", async () => {
		const workspace = createE2EWorkspace("turnlock-preflight-");
		const entrypoint = workspace.writeEntrypoint(
			"invalid-phase-value.ts",
			buildEntrypointSource(`
await runOrchestrator({
	name: "invalid-phase-value",
	initial: "p1",
	initialState: {},
	resumeCommand: (runId) => "node runner.mjs --run-id " + runId + " --resume",
	phases: { p1: "str" },
});
`),
		);
		try {
			const result = await workspace.runEntrypoint(entrypoint, [
				"--run-id",
				"01HX0000000000000000000030",
			]);
			assert.strictEqual(result.exitCode, 1);
			assert.strictEqual(result.stderr, "");
			assert.deepStrictEqual(parseSingleProtocolBlock(result.stdout), {
				version: 3,
				runId: null,
				orchestrator: "invalid-phase-value",
				action: "ERROR",
				fields: {
					errorKind: "invalid_config",
					message: 'phase "p1" must be a function',
					phase: null,
					phasesExecuted: 0,
				},
			});
			assert.strictEqual(
				existsSync(workspace.runDirRoot),
				false,
				"preflight rejection must happen before run-directory I/O",
			);
		} finally {
			workspace.cleanup();
		}
	});
});
