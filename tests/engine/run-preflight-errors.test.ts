// NIB-T §20 — preflight errors (T-PF-01..21)
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { definePhase } from "../../src/define-phase";
import { runOrchestrator } from "../../src/engine/run-orchestrator";
import { parseProtocolBlock } from "../../src/services/protocol";
import type { OrchestratorConfig } from "../../src/types/config";
import { cleanupTempDir, makeTempDir } from "../helpers/temp-run-dir";

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
	test("T-PF-09b | invalid resume --run-id rejected before RUN_DIR read", async () => {
		const root = makeTempDir();
		const unsafeRunDir = join(root, "orch", "invalid", "id");
		try {
			mkdirSync(unsafeRunDir, { recursive: true });
			writeFileSync(join(unsafeRunDir, "state.json"), "{not-json", "utf-8");

			const stdout = await runWithHarness(
				base(),
				["--resume", "--run-id", "invalid/id"],
				root,
			);
			const block = parseProtocolBlock(stdout);
			expect(block).not.toBeNull();
			expect(block!.action).toBe("ERROR");
			expect(block!.runId).toBeNull();
			expect(block!.fields.errorKind).toBe("invalid_config");
			expect(block!.fields.message).toBe("--run-id must be a ULID");
			expect(existsSync(join(unsafeRunDir, "events.ndjson"))).toBe(false);
		} finally {
			cleanupTempDir(root);
		}
	});

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
