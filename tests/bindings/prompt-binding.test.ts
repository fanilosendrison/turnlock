import assert from "node:assert/strict";
// Authority: public types + serialization contracts + tests + ADR-0001 +
// docs/architecture/delegation-model.md
import { describe, test } from "node:test";
import { promptBinding } from "../../src/bindings/prompt.js";
import type { DelegationContext } from "../../src/bindings/types.js";
import type { PromptDelegationRequest } from "../../src/types/delegation.js";

const RUN_DIR = "/tmp/.turnlock/runs/orch/01HX";
function makeContext(
	overrides: Partial<DelegationContext> = {},
): DelegationContext {
	return {
		runId: "01HX0000000000000000000001",
		orchestratorName: "orch",
		phase: "dispatch",
		resumeAt: "consolidate",
		attempt: 0,
		maxAttempts: 3,
		emittedAt: "2026-04-19T12:00:00.000Z",
		emittedAtEpochMs: 1745062800000,
		timeoutMs: 600000,
		deadlineAtEpochMs: 1745063400000,
		runDir: RUN_DIR,
		...overrides,
	};
}
const baseRequest: PromptDelegationRequest = {
	kind: "prompt",
	target: { kind: "worker", name: "senior-reviewer-file" },
	prompt: "Review src/component.ts",
	label: "review-component",
};
describe("PromptBinding.buildManifest (T-PRM-01..03)", () => {
	test("T-PRM-01 | full prompt manifest", () => {
		const m = promptBinding.buildManifest(baseRequest, makeContext());
		assert.strictEqual(m.kind, "prompt");
		assert.deepStrictEqual(m.target, {
			kind: "worker",
			name: "senior-reviewer-file",
		});
		assert.strictEqual(m.prompt, "Review src/component.ts");
		assert.strictEqual(
			m.resultPath,
			`${RUN_DIR}/results/review-component-0.json`,
		);
		assert.strictEqual(m.jobs, undefined);
	});
	test("T-PRM-01h | host target preserved exactly", () => {
		const m = promptBinding.buildManifest(
			{ ...baseRequest, target: { kind: "host" } },
			makeContext(),
		);
		assert.deepStrictEqual(m.target, { kind: "host" });
	});
	test("T-PRM-01w | worker name preserved exactly", () => {
		const m = promptBinding.buildManifest(
			{
				...baseRequest,
				target: { kind: "worker", name: "git-commit-generator" },
			},
			makeContext(),
		);
		assert.deepStrictEqual(m.target, {
			kind: "worker",
			name: "git-commit-generator",
		});
	});
	test("T-PRM-01v | manifest is version 3", () => {
		const m = promptBinding.buildManifest(baseRequest, makeContext());
		assert.strictEqual(m.manifestVersion, 3);
	});
	test("T-PRM-01l | no legacy worker field emitted", () => {
		const m = promptBinding.buildManifest(baseRequest, makeContext());
		assert.strictEqual("worker" in Object(m), false);
		assert.deepStrictEqual(Object.keys(m).sort(), [
			"attempt",
			"deadlineAtEpochMs",
			"emittedAt",
			"emittedAtEpochMs",
			"kind",
			"label",
			"manifestVersion",
			"maxAttempts",
			"orchestratorName",
			"phase",
			"prompt",
			"resultPath",
			"resumeAt",
			"runId",
			"target",
			"timeoutMs",
		]);
	});
	test("T-PRM-02 | long prompt preserved", () => {
		const long = "x".repeat(5000);
		const m = promptBinding.buildManifest(
			{ ...baseRequest, prompt: long },
			makeContext(),
		);
		assert.strictEqual(m.prompt, long);
	});
	test("T-PRM-03 | attempt=1 per-attempt path", () => {
		const m = promptBinding.buildManifest(
			baseRequest,
			makeContext({ attempt: 1 }),
		);
		assert.strictEqual(
			m.resultPath,
			`${RUN_DIR}/results/review-component-1.json`,
		);
	});
});
describe("PromptBinding.buildProtocolBlock (T-PRM-04..05)", () => {
	test("T-PRM-04 | bloc DELEGATE prompt", () => {
		const m = promptBinding.buildManifest(baseRequest, makeContext());
		const b = promptBinding.buildProtocolBlock(
			m,
			"/tmp/delegations/review-component-0.json",
			"cmd",
		);
		assert.ok(b.includes("kind: prompt"));
	});
	test("T-PRM-05 | manifest kind consistent", () => {
		const m = promptBinding.buildManifest(baseRequest, makeContext());
		assert.strictEqual(m.kind, "prompt");
	});
});
describe("PromptBinding properties (P-PRM-a/b)", () => {
	test("P-PRM-a | pure", () => {
		const ctx = makeContext();
		assert.deepStrictEqual(
			promptBinding.buildManifest(baseRequest, ctx),
			promptBinding.buildManifest(baseRequest, ctx),
		);
	});
	test("P-PRM-b | resultPath shape", () => {
		for (const attempt of [0, 1, 4]) {
			const m = promptBinding.buildManifest(
				baseRequest,
				makeContext({ attempt }),
			);
			assert.strictEqual(
				m.resultPath,
				`${RUN_DIR}/results/review-component-${attempt}.json`,
			);
		}
	});
});
