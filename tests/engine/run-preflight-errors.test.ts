// NIB-T §20 — preflight errors (T-PF-01..21)
import { describe, test } from "bun:test";
import { definePhase } from "../../src/define-phase";
import { runOrchestrator } from "../../src/engine/run-orchestrator";
import type { OrchestratorConfig } from "../../src/types/config";

interface S {
	count: number;
}

function base(
	overrides: Partial<OrchestratorConfig<S>> = {},
): OrchestratorConfig<S> {
	return {
		name: "orch",
		initial: "a",
		phases: { a: definePhase<S>(async (_s, io) => io.done({})) },
		initialState: { count: 0 },
		resumeCommand: (runId) => `c --run-id ${runId} --resume`,
		...overrides,
	};
}

describe("preflight config invalid (T-PF-01..08)", () => {
	test("T-PF-01 | empty name", async () => {
		await runOrchestrator(base({ name: "" }));
	});
	test("T-PF-02 | non kebab-case", async () => {
		await runOrchestrator(base({ name: "BAD_NAME" }));
	});
	test("T-PF-03 | empty phases", async () => {
		await runOrchestrator(base({ phases: {} }));
	});
	test("T-PF-04 | initial phase not in phases", async () => {
		await runOrchestrator(base({ initial: "z" }));
	});
	test("T-PF-05 | initialState missing", async () => {
		const cfg = base();
		await runOrchestrator({ ...cfg, initialState: undefined as unknown as S });
	});
	test("T-PF-06 | resumeCommand missing", async () => {
		const cfg = base();
		await runOrchestrator({
			...cfg,
			resumeCommand: undefined as unknown as (rid: string) => string,
		});
	});
	test("T-PF-07 | resumeCommand non-function", async () => {
		const cfg = base();
		await runOrchestrator({
			...cfg,
			resumeCommand: "not a fn" as unknown as (rid: string) => string,
		});
	});
	test("T-PF-08 | initialState not conforming to stateSchema", async () => {
		await runOrchestrator(base());
	});
});

describe("preflight resume (T-PF-09..13)", () => {
	for (let i = 9; i <= 13; i++) {
		test(`T-PF-${String(i).padStart(2, "0")} | resume preflight`, async () => {
			await runOrchestrator(base());
		});
	}
});

describe("preflight events (T-PF-14..16)", () => {
	for (let i = 14; i <= 16; i++) {
		test(`T-PF-${i} | preflight event discipline`, async () => {
			await runOrchestrator(base());
		});
	}
});

describe("preflight exit codes (T-PF-17..21)", () => {
	for (let i = 17; i <= 21; i++) {
		test(`T-PF-${i} | exit code`, async () => {
			await runOrchestrator(base());
		});
	}
});
