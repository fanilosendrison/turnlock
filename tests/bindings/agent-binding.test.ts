// NIB-T §13 — AgentBinding (T-AG-01..05, P-AG-a/b)
import { describe, expect, test } from "bun:test";
import { agentBinding } from "../../src/bindings/agent";
import type { DelegationContext } from "../../src/bindings/types";
import type { AgentDelegationRequest } from "../../src/types/delegation";

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

const baseRequest: AgentDelegationRequest = {
	kind: "agent",
	agentType: "senior-reviewer-file",
	prompt: "Review src/foo.ts",
	label: "review-foo",
};

describe("AgentBinding.buildManifest (T-AG-01..03)", () => {
	test("T-AG-01 | full agent manifest", () => {
		const m = agentBinding.buildManifest(baseRequest, makeContext());
		expect(m.kind).toBe("agent");
		expect(m.agentType).toBe("senior-reviewer-file");
		expect(m.prompt).toBe("Review src/foo.ts");
		expect(m.resultPath).toBe(`${RUN_DIR}/results/review-foo-0.json`);
		expect(m.skill).toBeUndefined();
		expect(m.skillArgs).toBeUndefined();
		expect(m.jobs).toBeUndefined();
	});
	test("T-AG-02 | long prompt preserved", () => {
		const long = "x".repeat(5000);
		const m = agentBinding.buildManifest(
			{ ...baseRequest, prompt: long },
			makeContext(),
		);
		expect(m.prompt).toBe(long);
	});
	test("T-AG-03 | attempt=1 per-attempt path", () => {
		const m = agentBinding.buildManifest(
			baseRequest,
			makeContext({ attempt: 1 }),
		);
		expect(m.resultPath).toBe(`${RUN_DIR}/results/review-foo-1.json`);
	});
});

describe("AgentBinding.buildProtocolBlock (T-AG-04..05)", () => {
	test("T-AG-04 | bloc DELEGATE agent", () => {
		const m = agentBinding.buildManifest(baseRequest, makeContext());
		const b = agentBinding.buildProtocolBlock(
			m,
			"/tmp/delegations/review-foo-0.json",
			"cmd",
		);
		expect(b).toContain("kind: agent");
	});
	test("T-AG-05 | manifest kind consistent", () => {
		const m = agentBinding.buildManifest(baseRequest, makeContext());
		expect(m.kind).toBe("agent");
	});
});

describe("AgentBinding properties (P-AG-a/b)", () => {
	test("P-AG-a | pure", () => {
		const ctx = makeContext();
		expect(agentBinding.buildManifest(baseRequest, ctx)).toEqual(
			agentBinding.buildManifest(baseRequest, ctx),
		);
	});
	test("P-AG-b | resultPath shape", () => {
		for (const attempt of [0, 1, 4]) {
			const m = agentBinding.buildManifest(
				baseRequest,
				makeContext({ attempt }),
			);
			expect(m.resultPath).toBe(
				`${RUN_DIR}/results/review-foo-${attempt}.json`,
			);
		}
	});
});
