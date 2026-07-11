// NIB-T §1.1 + §17.8 — integration end-to-end
import { describe, test } from "bun:test";
import { definePhase } from "../../src/define-phase";
import { runOrchestrator } from "../../src/engine/run-orchestrator";
import type { OrchestratorConfig } from "../../src/types/config";

interface S {
	count: number;
}

describe("ping-pong integration", () => {
	test("3 successive delegations + DONE", async () => {
		const cfg: OrchestratorConfig<S> = {
			name: "ping-pong",
				initial: "a",
				phases: {
					a: definePhase<S>(async (_s, io) =>
						io.delegate({ kind: "prompt", prompt: "f", label: "l1" }, "b", {
							count: 0,
						}),
					),
					b: definePhase<S>(async (_s, io) =>
						io.delegate({ kind: "prompt", prompt: "f", label: "l2" }, "c", {
							count: 0,
						}),
					),
					c: definePhase<S>(async (_s, io) =>
						io.delegate({ kind: "prompt", prompt: "f", label: "l3" }, "d", {
							count: 0,
						}),
					),
				d: definePhase<S>(async (_s, io) => io.done({ ok: true })),
			},
			initialState: { count: 0 },
			resumeCommand: (runId) => `c --run-id ${runId} --resume`,
		};
		await runOrchestrator(cfg);
	});
});
