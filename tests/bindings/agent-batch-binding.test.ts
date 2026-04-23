// NIB-T §14 — AgentBatchBinding (T-AB-01..08, P-AB-a/b/c)
import { describe, expect, test } from "bun:test";
import { agentBatchBinding } from "../../src/bindings/agent-batch";
import type { DelegationContext } from "../../src/bindings/types";
import { InvalidConfigError } from "../../src/errors/concrete";
import type { AgentBatchDelegationRequest } from "../../src/types/delegation";

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
		emittedAtEpochMs: 0,
		timeoutMs: 600_000,
		deadlineAtEpochMs: 600_000,
		runDir: RUN_DIR,
		...overrides,
	};
}

function makeRequest(
	jobCount: number,
	label = "batch",
): AgentBatchDelegationRequest {
	return {
		kind: "agent-batch",
		agentType: "reviewer",
		jobs: Array.from({ length: jobCount }, (_, i) => ({
			id: `j${i + 1}`,
			prompt: `p${i + 1}`,
		})),
		label,
	};
}

describe("AgentBatchBinding.buildManifest (T-AB-01..05)", () => {
	test("T-AB-01 | 1 job manifest", () => {
		const m = agentBatchBinding.buildManifest(makeRequest(1), makeContext());
		expect(m.kind).toBe("agent-batch");
		expect(m.jobs).toHaveLength(1);
		expect(m.resultPath).toBeUndefined();
		expect(m.jobs?.[0]?.resultPath).toBe(`${RUN_DIR}/results/batch-0/j1.json`);
	});
	test("T-AB-02 | 3 jobs", () => {
		const m = agentBatchBinding.buildManifest(makeRequest(3), makeContext());
		expect(m.jobs).toHaveLength(3);
		for (const job of m.jobs!) {
			expect(job.resultPath).toContain(`${RUN_DIR}/results/batch-0/`);
		}
	});
	test("T-AB-03 | binding does not enforce unique job IDs", () => {
		const req: AgentBatchDelegationRequest = {
			...makeRequest(2),
			jobs: [
				{ id: "j1", prompt: "a" },
				{ id: "j1", prompt: "b" },
			],
		};
		expect(() =>
			agentBatchBinding.buildManifest(req, makeContext()),
		).not.toThrow();
	});
	test("T-AB-04 | 0 jobs → InvalidConfigError", () => {
		const req: AgentBatchDelegationRequest = {
			kind: "agent-batch",
			agentType: "reviewer",
			jobs: [],
			label: "batch",
		};
		expect(() => agentBatchBinding.buildManifest(req, makeContext())).toThrow(
			InvalidConfigError,
		);
	});
	test("T-AB-05 | attempt=2 per-attempt dir", () => {
		const m = agentBatchBinding.buildManifest(
			makeRequest(3),
			makeContext({ attempt: 2 }),
		);
		expect(m.jobs![0]!.resultPath).toContain("batch-2/");
	});
});

describe("AgentBatchBinding.buildProtocolBlock (T-AB-06..08)", () => {
	test("T-AB-06 | bloc DELEGATE agent-batch", () => {
		const m = agentBatchBinding.buildManifest(makeRequest(3), makeContext());
		const b = agentBatchBinding.buildProtocolBlock(
			m,
			"/tmp/delegations/batch-0.json",
			"cmd",
		);
		expect(b).toContain("kind: agent-batch");
	});
	test("T-AB-07 | 5 jobs end-to-end disjoint paths", () => {
		const m = agentBatchBinding.buildManifest(makeRequest(5), makeContext());
		const paths = new Set(m.jobs!.map((j) => j.resultPath));
		expect(paths.size).toBe(5);
	});
	test("T-AB-08 | 20 jobs build fast & disjoint", () => {
		const start = Date.now();
		const m = agentBatchBinding.buildManifest(makeRequest(20), makeContext());
		expect(Date.now() - start).toBeLessThan(200);
		const paths = new Set(m.jobs!.map((j) => j.resultPath));
		expect(paths.size).toBe(20);
	});
});

describe("AgentBatchBinding properties (P-AB-a..c)", () => {
	test("P-AB-a | pure", () => {
		const ctx = makeContext();
		const req = makeRequest(3);
		expect(agentBatchBinding.buildManifest(req, ctx)).toEqual(
			agentBatchBinding.buildManifest(req, ctx),
		);
	});
	test("P-AB-b | each job resultPath shape", () => {
		const m = agentBatchBinding.buildManifest(
			makeRequest(3),
			makeContext({ attempt: 1 }),
		);
		for (const job of m.jobs!) {
			expect(job.resultPath).toMatch(/\/results\/batch-1\/j\d+\.json$/);
		}
	});
	test("P-AB-c | two distinct jobs have disjoint paths", () => {
		const m = agentBatchBinding.buildManifest(makeRequest(5), makeContext());
		const paths = m.jobs!.map((j) => j.resultPath);
		expect(new Set(paths).size).toBe(paths.length);
	});
});
