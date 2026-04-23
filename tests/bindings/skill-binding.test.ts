// NIB-T §12 — SkillBinding (T-SK-01..06, P-SK-a/b/c)
import { describe, expect, test } from "bun:test";
import { skillBinding } from "../../src/bindings/skill";
import type { DelegationContext } from "../../src/bindings/types";
import type { SkillDelegationRequest } from "../../src/types/delegation";

const RUN_DIR = "/tmp/.turnlock/runs/senior-review/01HX";

function makeContext(
	overrides: Partial<DelegationContext> = {},
): DelegationContext {
	return {
		runId: "01HX0000000000000000000001",
		orchestratorName: "senior-review",
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

const baseRequest: SkillDelegationRequest = {
	kind: "skill",
	skill: "dedup-codebase",
	args: { path: "src/" },
	label: "cleanup",
};

describe("SkillBinding.buildManifest (T-SK-01..04)", () => {
	test("T-SK-01 | full manifest", () => {
		const m = skillBinding.buildManifest(baseRequest, makeContext());
		expect(m.manifestVersion).toBe(1);
		expect(m.kind).toBe("skill");
		expect(m.skill).toBe("dedup-codebase");
		expect(m.skillArgs).toEqual({ path: "src/" });
		expect(m.label).toBe("cleanup");
		expect(m.resultPath).toBe(`${RUN_DIR}/results/cleanup-0.json`);
	});
	test("T-SK-02 | no args → skillArgs omitted", () => {
		const { args, ...rest } = baseRequest;
		void args;
		const m = skillBinding.buildManifest(
			rest as SkillDelegationRequest,
			makeContext(),
		);
		expect(m.skillArgs).toBeUndefined();
	});
	test("T-SK-03 | attempt=2 → per-attempt resultPath", () => {
		const m = skillBinding.buildManifest(
			baseRequest,
			makeContext({ attempt: 2 }),
		);
		expect(m.resultPath).toBe(`${RUN_DIR}/results/cleanup-2.json`);
	});
	test("T-SK-04 | binding does not validate label format", () => {
		const badLabel: SkillDelegationRequest = {
			...baseRequest,
			label: "BAD_LABEL",
		};
		expect(() =>
			skillBinding.buildManifest(badLabel, makeContext()),
		).not.toThrow();
	});
});

describe("SkillBinding.buildProtocolBlock (T-SK-05..06)", () => {
	test("T-SK-05 | bloc DELEGATE skill", () => {
		const m = skillBinding.buildManifest(baseRequest, makeContext());
		const block = skillBinding.buildProtocolBlock(
			m,
			"/tmp/delegations/cleanup-0.json",
			"cmd",
		);
		expect(block).toContain("action: DELEGATE");
		expect(block).toContain("kind: skill");
		expect(block).toContain("manifest: /tmp/delegations/cleanup-0.json");
	});
	test("T-SK-06 | manifest.kind matches block kind", () => {
		const m = skillBinding.buildManifest(baseRequest, makeContext());
		expect(m.kind).toBe("skill");
	});
});

describe("SkillBinding properties (P-SK-a..c)", () => {
	test("P-SK-a | buildManifest pure", () => {
		const ctx = makeContext();
		const a = skillBinding.buildManifest(baseRequest, ctx);
		const b = skillBinding.buildManifest(baseRequest, ctx);
		expect(a).toEqual(b);
	});
	test("P-SK-b | resultPath format", () => {
		for (const attempt of [0, 1, 5]) {
			const m = skillBinding.buildManifest(
				baseRequest,
				makeContext({ attempt }),
			);
			expect(m.resultPath).toBe(`${RUN_DIR}/results/cleanup-${attempt}.json`);
		}
	});
	test("P-SK-c | kind always skill", () => {
		for (let i = 0; i < 5; i++) {
			const m = skillBinding.buildManifest(baseRequest, makeContext());
			expect(m.kind).toBe("skill");
		}
	});
});
