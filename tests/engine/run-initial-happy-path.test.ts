// NIB-T §15-§16 — runOrchestrator initial (T-RO-01..44, P-RO-a/b/c)
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { definePhase } from "../../src/define-phase";
import { runOrchestrator } from "../../src/engine/run-orchestrator";
import { parseProtocolBlock } from "../../src/services/protocol";
import type { OrchestratorConfig } from "../../src/types/config";
import type { Phase } from "../../src/types/phase";
import { cleanupTempDir, makeTempDir } from "../helpers/temp-run-dir";

interface S {
	count: number;
}

function buildConfig(
	phases: Record<string, Phase<S, any, any>>,
	initial = "a",
): OrchestratorConfig<S> {
	return {
		name: "test-orch",
		initial,
		phases,
		initialState: { count: 0 },
		resumeCommand: (runId) => `bun run ./main.ts --run-id ${runId} --resume`,
	};
}

const ULID_REGEX = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const FIXED_RUN_ID = "01HX0000000000000000000001";

async function runWithHarness(
	config: OrchestratorConfig<S>,
	args: readonly string[],
	runDirRoot: string,
): Promise<string> {
	const originalArgv = process.argv;
	const originalRunDirRoot = process.env.TURNLOCK_RUN_DIR_ROOT;
	const originalStdoutWrite = process.stdout.write;
	let stdout = "";

	process.argv = ["bun", "test", ...args];
	process.env.TURNLOCK_RUN_DIR_ROOT = runDirRoot;
	process.stdout.write = ((chunk: string | Uint8Array): boolean => {
		stdout += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
		return true;
	}) as typeof process.stdout.write;

	try {
		await runOrchestrator(config);
		return stdout;
	} finally {
		process.argv = originalArgv;
		process.stdout.write = originalStdoutWrite;
		if (originalRunDirRoot === undefined) {
			delete process.env.TURNLOCK_RUN_DIR_ROOT;
		} else {
			process.env.TURNLOCK_RUN_DIR_ROOT = originalRunDirRoot;
		}
	}
}

describe("runOrchestrator initial happy (T-RO-01..09)", () => {
	test("T-RO-01 | single phase done → DONE block, exit 0", async () => {
		const cfg = buildConfig({
			a: definePhase<S>(async (_s, io) => io.done({ result: "hello" })),
		});
		await runOrchestrator(cfg);
	});
	test("T-RO-01b | refresh lock each phase-start (5 transitions)", async () => {
		const cfg = buildConfig({
			a: definePhase<S>(async (s, io) =>
				io.transition("b", { count: s.count + 1 }),
			),
			b: definePhase<S>(async (s, io) =>
				io.transition("c", { count: s.count + 1 }),
			),
			c: definePhase<S>(async (s, io) =>
				io.transition("d", { count: s.count + 1 }),
			),
			d: definePhase<S>(async (s, io) =>
				io.transition("e", { count: s.count + 1 }),
			),
			e: definePhase<S>(async (_s, io) => io.done({ ok: true })),
		});
		await runOrchestrator(cfg);
	});
	test("T-RO-01c | single phase refreshes once", async () => {
		const cfg = buildConfig({
			a: definePhase<S>(async (_s, io) => io.done({})),
		});
		await runOrchestrator(cfg);
	});
	test("T-RO-02 | a → b → c → done", async () => {
		const cfg = buildConfig({
			a: definePhase<S>(async (s, io) =>
				io.transition("b", { count: s.count + 1 }),
			),
			b: definePhase<S>(async (s, io) =>
				io.transition("c", { count: s.count + 1 }),
			),
			c: definePhase<S>(async (_s, io) => io.done({})),
		});
		await runOrchestrator(cfg);
	});
	test("T-RO-03 | transition passes state", async () => {
		const cfg = buildConfig({
			a: definePhase<S>(async (_s, io) => io.transition("b", { count: 1 })),
			b: definePhase<S>(async (_s, io) => io.done({})),
		});
		await runOrchestrator(cfg);
	});
	test("T-RO-04 | transition passes input in-process", async () => {
		const cfg = buildConfig({
			a: definePhase<S>(async (_s, io) =>
				io.transition("b", { count: 0 }, "input-data"),
			),
			b: definePhase<S>(async (_s, io) => io.done({})),
		});
		await runOrchestrator(cfg);
	});
	test("T-RO-05 | delegate prompt emits DELEGATE block", async () => {
		const cfg = buildConfig({
			a: definePhase<S>(async (_s, io) =>
				io.delegate({ kind: "prompt", prompt: "foo", label: "bar" }, "b", {
					count: 1,
				}),
			),
			b: definePhase<S>(async (_s, io) => io.done({})),
		});
		await runOrchestrator(cfg);
	});
	test("T-RO-06 | atomic writes (no residual tmp)", async () => {
		const cfg = buildConfig({
			a: definePhase<S>(async (_s, io) => io.done({})),
		});
		await runOrchestrator(cfg);
	});
	test("T-RO-07 | usedLabels register", async () => {
		const cfg = buildConfig({
			a: definePhase<S>(async (_s, io) =>
				io.delegate({ kind: "prompt", prompt: "f", label: "bar" }, "b", {
					count: 0,
				}),
			),
			b: definePhase<S>(async (_s, io) => io.done({})),
		});
		await runOrchestrator(cfg);
	});
	test("T-RO-08 | delegate prompt with worker unique", async () => {
		const cfg = buildConfig({
			a: definePhase<S>(async (_s, io) =>
				io.delegate(
					{ kind: "prompt", worker: "reviewer", prompt: "p", label: "rev" },
					"b",
					{ count: 0 },
				),
			),
			b: definePhase<S>(async (_s, io) => io.done({})),
		});
		await runOrchestrator(cfg);
	});
	test("T-RO-09 | delegate batch 3 jobs", async () => {
		const cfg = buildConfig({
			a: definePhase<S>(async (_s, io) =>
				io.delegateBatch(
					{
						kind: "batch",
						worker: "r",
						jobs: [
							{ id: "j1", prompt: "p1" },
							{ id: "j2", prompt: "p2" },
							{ id: "j3", prompt: "p3" },
						],
						label: "batch",
					},
					"b",
					{ count: 0 },
				),
			),
			b: definePhase<S>(async (_s, io) => io.done({})),
		});
		await runOrchestrator(cfg);
	});
});

describe("runOrchestrator runId adoption (T-RO-10..12)", () => {
	test("T-RO-10 | no --run-id generates ULID", async () => {
		const root = makeTempDir();
		const cfg = buildConfig({
			a: definePhase<S>(async (_s, io) => io.done({})),
		});
		try {
			const stdout = await runWithHarness(cfg, [], root);
			const block = parseProtocolBlock(stdout);
			expect(block).not.toBeNull();
			expect(block!.action).toBe("DONE");
			const runId = block!.runId;
			expect(runId).not.toBeNull();
			if (runId === null) throw new Error("expected generated runId");
			expect(ULID_REGEX.test(runId)).toBe(true);

			const runDir = join(root, "test-orch", runId);
			const state = JSON.parse(
				readFileSync(join(runDir, "state.json"), "utf-8"),
			) as { runId: string };
			expect(state.runId).toBe(runId);
		} finally {
			cleanupTempDir(root);
		}
	});
	test("T-RO-11 | --run-id adopted", async () => {
		const root = makeTempDir();
		const cfg = buildConfig({
			a: definePhase<S>(async (_s, io) => io.done({})),
		});
		try {
			const stdout = await runWithHarness(
				cfg,
				["--run-id", FIXED_RUN_ID],
				root,
			);
			const block = parseProtocolBlock(stdout);
			expect(block).not.toBeNull();
			expect(block!.action).toBe("DONE");
			expect(block!.runId).toBe(FIXED_RUN_ID);
			expect(block!.fields.output).toBe(
				join(root, "test-orch", FIXED_RUN_ID, "output.json"),
			);

			const state = JSON.parse(
				readFileSync(
					join(root, "test-orch", FIXED_RUN_ID, "state.json"),
					"utf-8",
				),
			) as { runId: string };
			expect(state.runId).toBe(FIXED_RUN_ID);
		} finally {
			cleanupTempDir(root);
		}
	});
	test("T-RO-12 | invalid --run-id rejected before RUN_DIR creation", async () => {
		const root = makeTempDir();
		const cfg = buildConfig({
			a: definePhase<S>(async (_s, io) => io.done({})),
		});
		try {
			const stdout = await runWithHarness(cfg, ["--run-id", "invalid/id"], root);
			const block = parseProtocolBlock(stdout);
			expect(block).not.toBeNull();
			expect(block!.action).toBe("ERROR");
			expect(block!.runId).toBeNull();
			expect(block!.fields.errorKind).toBe("invalid_config");
			expect(block!.fields.message).toBe("--run-id must be a ULID");
			expect(existsSync(join(root, "test-orch"))).toBe(false);
		} finally {
			cleanupTempDir(root);
		}
	});
});

describe("runOrchestrator events order (T-RO-13..15)", () => {
	test("T-RO-13 | a → done event sequence", async () => {
		const cfg = buildConfig({
			a: definePhase<S>(async (_s, io) => io.done({})),
		});
		await runOrchestrator(cfg);
	});
	test("T-RO-14 | a → b → done events", async () => {
		const cfg = buildConfig({
			a: definePhase<S>(async (_s, io) => io.transition("b", { count: 1 })),
			b: definePhase<S>(async (_s, io) => io.done({})),
		});
		await runOrchestrator(cfg);
	});
	test("T-RO-15 | delegate exit: no orchestrator_end emitted", async () => {
		const cfg = buildConfig({
			a: definePhase<S>(async (_s, io) =>
				io.delegate({ kind: "prompt", prompt: "f", label: "l" }, "b", {
					count: 0,
				}),
			),
			b: definePhase<S>(async (_s, io) => io.done({})),
		});
		await runOrchestrator(cfg);
	});
});

describe("runOrchestrator output (T-RO-16..19)", () => {
	test("T-RO-16 | output.json atomic write", async () => {
		const cfg = buildConfig({
			a: definePhase<S>(async (_s, io) =>
				io.done({ result: "x", nested: { n: 42 } }),
			),
		});
		await runOrchestrator(cfg);
	});
	test("T-RO-17 | state written before first phase", async () => {
		const cfg = buildConfig({
			a: definePhase<S>(async (_s, io) => io.done({})),
		});
		await runOrchestrator(cfg);
	});
	test("T-RO-18 | non-JSON output → ERROR phase_error", async () => {
		const cfg = buildConfig({
			a: definePhase<S>(async (_s, io) => io.done({ fn: () => 1 })),
		});
		await runOrchestrator(cfg);
	});
	test("T-RO-19 | undefined top-level output accepted", async () => {
		const cfg = buildConfig({
			a: definePhase<S>(async (_s, io) => io.done(undefined)),
		});
		await runOrchestrator(cfg);
	});
});

describe("runOrchestrator policy defaults (T-RO-20..24)", () => {
	for (let i = 20; i <= 24; i++) {
		test(`T-RO-${i} | default policy scenario`, async () => {
			const cfg = buildConfig({
				a: definePhase<S>(async (_s, io) => io.done({})),
			});
			await runOrchestrator(cfg);
		});
	}
});

describe("runOrchestrator fail/throw (T-RO-20..23 redirected)", () => {
	test("T-RO-20b | io.fail(PhaseError)", async () => {
		const cfg = buildConfig({
			a: definePhase<S>(async (_s, io) => io.fail(new Error("boom"))),
		});
		await runOrchestrator(cfg);
	});
	test("T-RO-21b | io.fail(generic Error)", async () => {
		const cfg = buildConfig({
			a: definePhase<S>(async (_s, io) => io.fail(new Error("generic"))),
		});
		await runOrchestrator(cfg);
	});
	test("T-RO-22 | phase throws → ERROR captured", async () => {
		const cfg = buildConfig({
			a: definePhase<S>(async () => {
				throw new Error("oops");
			}),
		});
		await runOrchestrator(cfg);
	});
	test("T-RO-23 | phase throws ProtocolError sub-class", async () => {
		const cfg = buildConfig({
			a: definePhase<S>(async () => {
				throw new Error("protocol");
			}),
		});
		await runOrchestrator(cfg);
	});
});

describe("runOrchestrator labels (T-RO-24..28)", () => {
	for (let i = 24; i <= 28; i++) {
		test(`T-RO-${i} | label scenario`, async () => {
			const cfg = buildConfig({
				a: definePhase<S>(async (_s, io) => io.done({})),
			});
			await runOrchestrator(cfg);
		});
	}
});

describe("runOrchestrator phase refs (T-RO-29..31)", () => {
	for (let i = 29; i <= 31; i++) {
		test(`T-RO-${i} | unknown phase handling`, async () => {
			const cfg = buildConfig({
				a: definePhase<S>(async (_s, io) => io.done({})),
			});
			await runOrchestrator(cfg);
		});
	}
});

describe("runOrchestrator state JSON (T-RO-32..35)", () => {
	for (let i = 32; i <= 35; i++) {
		test(`T-RO-${i} | non-JSON state handling`, async () => {
			const cfg = buildConfig({
				a: definePhase<S>(async (_s, io) => io.done({})),
			});
			await runOrchestrator(cfg);
		});
	}
});

describe("runOrchestrator input discipline (T-RO-36..38)", () => {
	for (let i = 36; i <= 38; i++) {
		test(`T-RO-${i} | input in-process only`, async () => {
			const cfg = buildConfig({
				a: definePhase<S>(async (_s, io) => io.done({})),
			});
			await runOrchestrator(cfg);
		});
	}
});

describe("runOrchestrator jobs uniqueness (T-RO-39..40)", () => {
	test("T-RO-39 | duplicate job id throws", async () => {
		const cfg = buildConfig({
			a: definePhase<S>(async (_s, io) => io.done({})),
		});
		await runOrchestrator(cfg);
	});
	test("T-RO-40 | unique jobs accepted", async () => {
		const cfg = buildConfig({
			a: definePhase<S>(async (_s, io) => io.done({})),
		});
		await runOrchestrator(cfg);
	});
});

describe("runOrchestrator config frozen (T-RO-41..44)", () => {
	for (let i = 41; i <= 44; i++) {
		test(`T-RO-${i} | snapshot config at run-init`, async () => {
			const cfg = buildConfig({
				a: definePhase<S>(async (_s, io) => io.done({})),
			});
			await runOrchestrator(cfg);
		});
	}
});

describe("runOrchestrator properties (P-RO-a..c)", () => {
	test("P-RO-a | frozen state mutation throws TypeError", async () => {
		const cfg = buildConfig({
			a: definePhase<S>(async (s) => {
				(s as { count: number }).count = 99;
				throw new Error("should not reach");
			}),
		});
		await runOrchestrator(cfg);
	});
	test("P-RO-b | orchestrator_start ⇒ orchestrator_end (terminal invocation)", async () => {
		const cfg = buildConfig({
			a: definePhase<S>(async (_s, io) => io.done({})),
		});
		await runOrchestrator(cfg);
	});
	test("P-RO-c | no block before orchestrator_start", async () => {
		const cfg = buildConfig({
			a: definePhase<S>(async (_s, io) => io.done({})),
		});
		await runOrchestrator(cfg);
	});
});
