import assert from "node:assert/strict";
// NIB-T §14 — BatchBinding (T-BT-01..08, P-BT-a/b/c)
import { describe, test } from "node:test";
import { batchBinding } from "../../src/bindings/batch.js";
import type {
	DelegationContext,
	DelegationManifest,
	DelegationManifestJob,
} from "../../src/bindings/types.js";
import { InvalidConfigError } from "../../src/errors/concrete.js";
import type { BatchDelegationRequest } from "../../src/types/delegation.js";

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
		timeoutMs: 600000,
		deadlineAtEpochMs: 600000,
		runDir: RUN_DIR,
		...overrides,
	};
}
function makeRequest(
	jobCount: number,
	label = "batch",
): BatchDelegationRequest {
	return {
		kind: "batch",
		worker: "reviewer",
		jobs: Array.from({ length: jobCount }, (_, i) => ({
			id: `j${i + 1}`,
			prompt: `p${i + 1}`,
		})),
		label,
	};
}
function expectJobs(
	manifest: DelegationManifest,
): readonly DelegationManifestJob[] {
	assert.notStrictEqual(manifest.jobs, undefined);
	return manifest.jobs ?? [];
}
describe("BatchBinding.buildManifest (T-BT-01..05)", () => {
	test("T-BT-01 | 1 job manifest", () => {
		const m = batchBinding.buildManifest(makeRequest(1), makeContext());
		assert.strictEqual(m.kind, "batch");
		assert.strictEqual(expectJobs(m).length, 1);
		assert.strictEqual(m.resultPath, undefined);
		assert.strictEqual(
			m.jobs?.[0]?.resultPath,
			`${RUN_DIR}/results/batch-0/j1.json`,
		);
	});
	test("T-BT-02 | 3 jobs", () => {
		const m = batchBinding.buildManifest(makeRequest(3), makeContext());
		const jobs = expectJobs(m);
		assert.strictEqual(jobs.length, 3);
		for (const job of jobs) {
			assert.ok(job.resultPath.includes(`${RUN_DIR}/results/batch-0/`));
		}
	});
	test("T-BT-03 | binding does not enforce unique job IDs", () => {
		const req: BatchDelegationRequest = {
			...makeRequest(2),
			jobs: [
				{ id: "j1", prompt: "a" },
				{ id: "j1", prompt: "b" },
			],
		};
		assert.doesNotThrow(() => batchBinding.buildManifest(req, makeContext()));
	});
	test("T-BT-04 | 0 jobs → InvalidConfigError", () => {
		const req: BatchDelegationRequest = {
			kind: "batch",
			worker: "reviewer",
			jobs: [],
			label: "batch",
		};
		assert.throws(
			() => batchBinding.buildManifest(req, makeContext()),
			InvalidConfigError,
		);
	});
	test("T-BT-05 | attempt=2 per-attempt dir", () => {
		const m = batchBinding.buildManifest(
			makeRequest(3),
			makeContext({ attempt: 2 }),
		);
		const firstJob = expectJobs(m)[0];
		if (firstJob === undefined) assert.fail("expected the first batch job");
		assert.ok(firstJob.resultPath.includes("batch-2/"));
	});
});
describe("BatchBinding.buildProtocolBlock (T-BT-06..08)", () => {
	test("T-BT-06 | bloc DELEGATE batch", () => {
		const m = batchBinding.buildManifest(makeRequest(3), makeContext());
		const b = batchBinding.buildProtocolBlock(
			m,
			"/tmp/delegations/batch-0.json",
			"cmd",
		);
		assert.ok(b.includes("kind: batch"));
	});
	test("T-BT-07 | 5 jobs end-to-end disjoint paths", () => {
		const m = batchBinding.buildManifest(makeRequest(5), makeContext());
		const paths = new Set(expectJobs(m).map((j) => j.resultPath));
		assert.strictEqual(paths.size, 5);
	});
	test("T-BT-08 | 20 jobs build fast & disjoint", () => {
		const start = Date.now();
		const m = batchBinding.buildManifest(makeRequest(20), makeContext());
		assert.ok(Date.now() - start < 200);
		const paths = new Set(expectJobs(m).map((j) => j.resultPath));
		assert.strictEqual(paths.size, 20);
	});
});
describe("BatchBinding properties (P-BT-a..c)", () => {
	test("P-BT-a | pure", () => {
		const ctx = makeContext();
		const req = makeRequest(3);
		assert.deepStrictEqual(
			batchBinding.buildManifest(req, ctx),
			batchBinding.buildManifest(req, ctx),
		);
	});
	test("P-BT-b | each job resultPath shape", () => {
		const m = batchBinding.buildManifest(
			makeRequest(3),
			makeContext({ attempt: 1 }),
		);
		for (const job of expectJobs(m)) {
			assert.match(job.resultPath, /\/results\/batch-1\/j\d+\.json$/);
		}
	});
	test("P-BT-c | two distinct jobs have disjoint paths", () => {
		const m = batchBinding.buildManifest(makeRequest(5), makeContext());
		const paths = expectJobs(m).map((j) => j.resultPath);
		assert.strictEqual(new Set(paths).size, paths.length);
	});
});
