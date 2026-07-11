// NIB-T §13 — PromptBinding (T-PRM-01..05, P-PRM-a/b)
import { describe, expect, test } from "bun:test";
import { promptBinding } from "../../src/bindings/prompt";
import type { DelegationContext } from "../../src/bindings/types";
import type { PromptDelegationRequest } from "../../src/types/delegation";

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
		emittedAtEpochMs: 1_745_062_800_000,
		timeoutMs: 600_000,
		deadlineAtEpochMs: 1_745_063_400_000,
		runDir: RUN_DIR,
		...overrides,
	};
}

const baseRequest: PromptDelegationRequest = {
	kind: "prompt",
	worker: "senior-reviewer-file",
	prompt: "Review src/foo.ts",
	label: "review-foo",
};

describe("PromptBinding.buildManifest (T-PRM-01..03)", () => {
	test("T-PRM-01 | full prompt manifest", () => {
		const m = promptBinding.buildManifest(baseRequest, makeContext());
		expect(m.kind).toBe("prompt");
		expect(m.worker).toBe("senior-reviewer-file");
		expect(m.prompt).toBe("Review src/foo.ts");
		expect(m.resultPath).toBe(`${RUN_DIR}/results/review-foo-0.json`);
		expect(m.jobs).toBeUndefined();
	});
	test("T-PRM-02 | long prompt preserved", () => {
		const long = "x".repeat(5000);
		const m = promptBinding.buildManifest(
			{ ...baseRequest, prompt: long },
			makeContext(),
		);
		expect(m.prompt).toBe(long);
	});
	test("T-PRM-03 | attempt=1 per-attempt path", () => {
		const m = promptBinding.buildManifest(
			baseRequest,
			makeContext({ attempt: 1 }),
		);
		expect(m.resultPath).toBe(`${RUN_DIR}/results/review-foo-1.json`);
	});
});

describe("PromptBinding.buildProtocolBlock (T-PRM-04..05)", () => {
	test("T-PRM-04 | bloc DELEGATE prompt", () => {
		const m = promptBinding.buildManifest(baseRequest, makeContext());
		const b = promptBinding.buildProtocolBlock(
			m,
			"/tmp/delegations/review-foo-0.json",
			"cmd",
		);
		expect(b).toContain("kind: prompt");
	});
	test("T-PRM-05 | manifest kind consistent", () => {
		const m = promptBinding.buildManifest(baseRequest, makeContext());
		expect(m.kind).toBe("prompt");
	});
});

describe("PromptBinding properties (P-PRM-a/b)", () => {
	test("P-PRM-a | pure", () => {
		const ctx = makeContext();
		expect(promptBinding.buildManifest(baseRequest, ctx)).toEqual(
			promptBinding.buildManifest(baseRequest, ctx),
		);
	});
	test("P-PRM-b | resultPath shape", () => {
		for (const attempt of [0, 1, 4]) {
			const m = promptBinding.buildManifest(
				baseRequest,
				makeContext({ attempt }),
			);
			expect(m.resultPath).toBe(
				`${RUN_DIR}/results/review-foo-${attempt}.json`,
			);
		}
	});
});
