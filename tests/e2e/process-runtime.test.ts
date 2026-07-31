// Process-level coverage for Turnlock's stdout protocol, run directory, resume, retry, lock, and signal contract.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DelegationManifest } from "../../src/bindings/types";
import type { ProtocolAction } from "../../src/services/protocol";
import type { StateFile } from "../../src/services/state-io";
import type { OrchestratorEvent } from "../../src/types/events";
import {
	buildEntrypointSource,
	countProtocolBlocks,
	createE2EWorkspace,
	parseSingleProtocolBlock,
	readEvents,
	readJsonFile,
	readManifestFile,
	readStateFile,
	waitForPath,
	writeBatchResults,
	writeMalformedPromptResult,
	writePromptResult,
} from "../helpers/e2e-process";

const RUN_IDS = {
	done: "01HX0000000000000000000001",
	delegate: "01HX0000000000000000000002",
	promptResume: "01HX0000000000000000000003",
	batchResume: "01HX0000000000000000000004",
	batchWrongConsume: "01HX0000000000000000000005",
	pingPong: "01HX0000000000000000000006",
	retry: "01HX0000000000000000000007",
	retryExhausted: "01HX0000000000000000000008",
	timeout: "01HX0000000000000000000009",
	sigint: "01HX0000000000000000000010",
	sigterm: "01HX0000000000000000000011",
	lock: "01HX0000000000000000000012",
	throw: "01HX0000000000000000000013",
	fail: "01HX0000000000000000000014",
	bogus: "01HX0000000000000000000015",
	resumeWithoutPending: "01HX0000000000000000000016",
	missingState: "01HX0000000000000000000017",
	failAfterDelegate: "01HX0000000000000000000020",
} as const;

function eventTypes(events: readonly OrchestratorEvent[]): string[] {
	return events.map((event) => event.eventType);
}

function expectProtocol(
	stdout: string,
	action: ProtocolAction,
	runId: string | null,
) {
	expect(countProtocolBlocks(stdout)).toBe(1);
	const block = parseSingleProtocolBlock(stdout);
	expect(block.action).toBe(action);
	expect(block.runId).toBe(runId);
	return block;
}

function expectLockReleased(runDir: string): void {
	// SQLite-based ownership replaces the file lock.  The DB row is
	// set to FREE on release; verify by checking the ownership status.
	const dbPath = join(runDir, "turnlock.sqlite3");
	if (existsSync(dbPath)) {
		const { Database } = require("bun:sqlite") as typeof import("bun:sqlite");
		const db = new Database(dbPath, { readonly: true });
		try {
			const row = db
				.query("SELECT ownership_status FROM run_ownership WHERE singleton = 1")
				.get() as { ownership_status: string } | undefined;
			expect(row?.ownership_status ?? "FREE").toBe("FREE");
		} finally {
			db.close();
		}
	}
}

function expectNoProtocolOnStderr(stderr: string): void {
	expect(stderr).not.toContain("@@TURNLOCK@@");
}

function baseResumeCommandSource(): string {
	return '(runId) => "bun " + import.meta.path + " --run-id " + runId + " --resume"';
}

function expectLastTransitionMatchesManifest(
	state: StateFile<object>,
	manifest: DelegationManifest,
): void {
	expect(state.lastTransitionAt).toBe(manifest.emittedAt);
	expect(state.lastTransitionAtEpochMs).toBe(manifest.emittedAtEpochMs);
}

describe("process E2E initial terminal and delegation flows", () => {
	test("initial DONE exits 0 with protocol-only stdout and durable terminal artifacts", async () => {
		const workspace = createE2EWorkspace();
		const entrypoint = workspace.writeEntrypoint(
			"initial-done.ts",
			buildEntrypointSource(`
interface State { count: number }

await runOrchestrator<State>({
	name: "e2e-done",
	initial: "start",
	initialState: { count: 0 },
	resumeCommand: ${baseResumeCommandSource()},
	phases: {
		start: definePhase<State>(async (_state, io) => io.done({ ok: true, count: 1 })),
	},
});
`),
		);

		try {
			const result = await workspace.runEntrypoint(entrypoint, [
				"--run-id",
				RUN_IDS.done,
			]);
			expect(result.exitCode).toBe(0);
			expectNoProtocolOnStderr(result.stderr);
			const block = expectProtocol(result.stdout, "DONE", RUN_IDS.done);

			const runDir = workspace.runDir("e2e-done", RUN_IDS.done);
			expect(block.fields.output).toBe(join(runDir, "output.json"));
			expect(
				readJsonFile<{ ok: boolean; count: number }>(
					join(runDir, "output.json"),
				),
			).toEqual({
				ok: true,
				count: 1,
			});
			const state = readStateFile<{ count: number }>(runDir);
			expect(state.runId).toBe(RUN_IDS.done);
			expect(state.currentPhase).toBe("start");
			expect(state.phasesExecuted).toBe(1);
			expect(state.lastTransitionAt).toBe(state.startedAt);
			expect(state.lastTransitionAtEpochMs).toBe(state.startedAtEpochMs);
			expect("pendingDelegation" in state).toBe(false);
			expectLockReleased(runDir);
			expect(eventTypes(readEvents(runDir))).toEqual([
				"orchestrator_start",
				"phase_start",
				"phase_end",
				"orchestrator_end",
			]);
		} finally {
			workspace.cleanup();
		}
	});

	test("initial DELEGATE snapshots next state, manifest, pending delegation, and releases lock", async () => {
		const workspace = createE2EWorkspace();
		const entrypoint = workspace.writeEntrypoint(
			"initial-delegate.ts",
			buildEntrypointSource(`
interface State { count: number }

await runOrchestrator<State>({
	name: "e2e-delegate",
	initial: "start",
	initialState: { count: 0 },
	resumeCommand: ${baseResumeCommandSource()},
	phases: {
		start: definePhase<State>(async (_state, io) =>
			io.delegate({ kind: "prompt", worker: "reviewer", prompt: "inspect", label: "review" }, "finish", { count: 1 }),
		),
		finish: definePhase<State>(async (_state, io) => io.done({ ok: true })),
	},
});
`),
		);

		try {
			const result = await workspace.runEntrypoint(entrypoint, [
				"--run-id",
				RUN_IDS.delegate,
			]);
			expect(result.exitCode).toBe(0);
			expectNoProtocolOnStderr(result.stderr);
			const block = expectProtocol(result.stdout, "DELEGATE", RUN_IDS.delegate);
			expect(block.fields.kind).toBe("prompt");

			const runDir = workspace.runDir("e2e-delegate", RUN_IDS.delegate);
			const manifestPath = String(block.fields.manifest);
			const manifest = readManifestFile(manifestPath);
			expect(manifest).toMatchObject({
				runId: RUN_IDS.delegate,
				orchestratorName: "e2e-delegate",
				phase: "start",
				resumeAt: "finish",
				label: "review",
				kind: "prompt",
				attempt: 0,
				worker: "reviewer",
				prompt: "inspect",
			});
			expect(manifest.resultPath).toBe(
				join(runDir, "results", "review-0.json"),
			);

			const state = readStateFile<{ count: number }>(runDir);
			expect(state.data).toEqual({ count: 1 });
			expect(state.usedLabels).toEqual(["review"]);
			expectLastTransitionMatchesManifest(state, manifest);
			expect(state.pendingDelegation?.emittedAtEpochMs).toBe(
				manifest.emittedAtEpochMs,
			);
			expect(state.pendingDelegation).toMatchObject({
				label: "review",
				kind: "prompt",
				resumeAt: "finish",
				attempt: 0,
				manifestPath,
			});
			expectLockReleased(runDir);
			expect(eventTypes(readEvents(runDir))).toEqual([
				"orchestrator_start",
				"phase_start",
				"phase_end",
				"delegation_emit",
			]);
		} finally {
			workspace.cleanup();
		}
	});
});

describe("process E2E resume flows", () => {
	test("prompt resume consumes result, validates it, clears pending delegation, and emits DONE", async () => {
		const workspace = createE2EWorkspace();
		const entrypoint = workspace.writeEntrypoint(
			"prompt-resume.ts",
			buildEntrypointSource(`
interface State { count: number }

await runOrchestrator<State>({
	name: "e2e-prompt-resume",
	initial: "ask",
	initialState: { count: 0 },
	resumeCommand: ${baseResumeCommandSource()},
	phases: {
		ask: definePhase<State>(async (_state, io) =>
			io.delegate({ kind: "prompt", prompt: "verdict", label: "answer" }, "finish", { count: 1 }),
		),
		finish: definePhase<State>(async (state, io) => {
			const result = io.consumePendingResult(z.object({ verdict: z.string() }));
			return io.done({ count: state.count, verdict: result.verdict });
		}),
	},
});
`),
		);

		try {
			const initial = await workspace.runEntrypoint(entrypoint, [
				"--run-id",
				RUN_IDS.promptResume,
			]);
			expect(initial.exitCode).toBe(0);
			const initialBlock = expectProtocol(
				initial.stdout,
				"DELEGATE",
				RUN_IDS.promptResume,
			);
			const runDir = workspace.runDir(
				"e2e-prompt-resume",
				RUN_IDS.promptResume,
			);
			const initialManifest = readManifestFile(
				String(initialBlock.fields.manifest),
			);
			writePromptResult(runDir, "answer", 0, { verdict: "clean" });

			const resumed = await workspace.runEntrypoint(entrypoint, [
				"--resume",
				"--run-id",
				RUN_IDS.promptResume,
			]);
			expect(resumed.exitCode).toBe(0);
			const done = expectProtocol(resumed.stdout, "DONE", RUN_IDS.promptResume);
			expect(
				readJsonFile<{ count: number; verdict: string }>(
					done.fields.output as string,
				),
			).toEqual({
				count: 1,
				verdict: "clean",
			});

			const state = readStateFile<{ count: number }>(runDir);
			expect("pendingDelegation" in state).toBe(false);
			expect(state.currentPhase).toBe("finish");
			expect(state.phasesExecuted).toBe(2);
			expect(state.usedLabels).toEqual(["answer"]);
			expectLastTransitionMatchesManifest(state, initialManifest);
			expectLockReleased(runDir);
			expect(eventTypes(readEvents(runDir))).toEqual([
				"orchestrator_start",
				"phase_start",
				"phase_end",
				"delegation_emit",
				"delegation_result_read",
				"phase_start",
				"delegation_validated",
				"phase_end",
				"orchestrator_end",
			]);
		} finally {
			workspace.cleanup();
		}
	});

	test("batch resume preserves job order and wrong consume method fails closed", async () => {
		const workspace = createE2EWorkspace();
		const entrypoint = workspace.writeEntrypoint(
			"batch-resume.ts",
			buildEntrypointSource(`
interface State { mode: string }

await runOrchestrator<State>({
	name: "e2e-batch-resume",
	initial: "fanout",
	initialState: { mode: "batch" },
	resumeCommand: ${baseResumeCommandSource()},
	phases: {
		fanout: definePhase<State>(async (_state, io) =>
			io.delegateBatch(
				{
					kind: "batch",
					label: "jobs",
					jobs: [
						{ id: "first", prompt: "one" },
						{ id: "second", prompt: "two" },
					],
				},
				"collect",
				{ mode: "collect" },
			),
		),
		collect: definePhase<State>(async (_state, io) => {
			if (process.env.WRONG_CONSUME === "1") {
				io.consumePendingResult(z.object({ score: z.number() }));
			}
			const results = io.consumePendingBatchResults(z.object({ score: z.number() }));
			return io.done({ scores: results.map((result) => result.score) });
		}),
	},
});
`),
		);

		try {
			const initial = await workspace.runEntrypoint(entrypoint, [
				"--run-id",
				RUN_IDS.batchResume,
			]);
			expect(initial.exitCode).toBe(0);
			expectProtocol(initial.stdout, "DELEGATE", RUN_IDS.batchResume);
			const runDir = workspace.runDir("e2e-batch-resume", RUN_IDS.batchResume);
			writeBatchResults(runDir, "jobs", 0, {
				second: { score: 2 },
				first: { score: 1 },
			});

			const resumed = await workspace.runEntrypoint(entrypoint, [
				"--resume",
				"--run-id",
				RUN_IDS.batchResume,
			]);
			expect(resumed.exitCode).toBe(0);
			const done = expectProtocol(resumed.stdout, "DONE", RUN_IDS.batchResume);
			expect(
				readJsonFile<{ scores: number[] }>(done.fields.output as string),
			).toEqual({
				scores: [1, 2],
			});

			const wrongInitial = await workspace.runEntrypoint(entrypoint, [
				"--run-id",
				RUN_IDS.batchWrongConsume,
			]);
			expect(wrongInitial.exitCode).toBe(0);
			const wrongRunDir = workspace.runDir(
				"e2e-batch-resume",
				RUN_IDS.batchWrongConsume,
			);
			writeBatchResults(wrongRunDir, "jobs", 0, {
				first: { score: 1 },
				second: { score: 2 },
			});
			const wrongResume = await workspace.runEntrypoint(
				entrypoint,
				["--resume", "--run-id", RUN_IDS.batchWrongConsume],
				{ env: { WRONG_CONSUME: "1" } },
			);
			expect(wrongResume.exitCode).toBe(1);
			const error = expectProtocol(
				wrongResume.stdout,
				"ERROR",
				RUN_IDS.batchWrongConsume,
			);
			expect(error.fields.errorKind).toBe("protocol");
			expect(String(error.fields.message)).toContain(
				"use consumePendingBatchResults",
			);
		} finally {
			workspace.cleanup();
		}
	});

	test("multi-delegation ping-pong drives three real resume cycles before DONE", async () => {
		const workspace = createE2EWorkspace();
		const entrypoint = workspace.writeEntrypoint(
			"ping-pong.ts",
			buildEntrypointSource(`
interface State { seen: string[] }

await runOrchestrator<State>({
	name: "e2e-ping-pong",
	initial: "a",
	initialState: { seen: [] },
	resumeCommand: ${baseResumeCommandSource()},
	phases: {
		a: definePhase<State>(async (_state, io) =>
			io.delegate({ kind: "prompt", prompt: "one", label: "l1" }, "b", { seen: [] }),
		),
		b: definePhase<State>(async (state, io) => {
			const result = io.consumePendingResult(z.object({ value: z.string() }));
			return io.delegate({ kind: "prompt", prompt: "two", label: "l2" }, "c", { seen: [...state.seen, result.value] });
		}),
		c: definePhase<State>(async (state, io) => {
			const result = io.consumePendingResult(z.object({ value: z.string() }));
			return io.delegate({ kind: "prompt", prompt: "three", label: "l3" }, "d", { seen: [...state.seen, result.value] });
		}),
		d: definePhase<State>(async (state, io) => {
			const result = io.consumePendingResult(z.object({ value: z.string() }));
			return io.done({ seen: [...state.seen, result.value] });
		}),
	},
});
`),
		);

		try {
			const first = await workspace.runEntrypoint(entrypoint, [
				"--run-id",
				RUN_IDS.pingPong,
			]);
			expect(first.exitCode).toBe(0);
			expectProtocol(first.stdout, "DELEGATE", RUN_IDS.pingPong);
			const runDir = workspace.runDir("e2e-ping-pong", RUN_IDS.pingPong);
			writePromptResult(runDir, "l1", 0, { value: "one" });

			const second = await workspace.runEntrypoint(entrypoint, [
				"--resume",
				"--run-id",
				RUN_IDS.pingPong,
			]);
			expect(second.exitCode).toBe(0);
			expectProtocol(second.stdout, "DELEGATE", RUN_IDS.pingPong);
			writePromptResult(runDir, "l2", 0, { value: "two" });

			const third = await workspace.runEntrypoint(entrypoint, [
				"--resume",
				"--run-id",
				RUN_IDS.pingPong,
			]);
			expect(third.exitCode).toBe(0);
			expectProtocol(third.stdout, "DELEGATE", RUN_IDS.pingPong);
			writePromptResult(runDir, "l3", 0, { value: "three" });

			const terminal = await workspace.runEntrypoint(entrypoint, [
				"--resume",
				"--run-id",
				RUN_IDS.pingPong,
			]);
			expect(terminal.exitCode).toBe(0);
			const done = expectProtocol(terminal.stdout, "DONE", RUN_IDS.pingPong);
			expect(
				readJsonFile<{ seen: string[] }>(done.fields.output as string),
			).toEqual({
				seen: ["one", "two", "three"],
			});

			const state = readStateFile<{ seen: string[] }>(runDir);
			expect(state.usedLabels).toEqual(["l1", "l2", "l3"]);
			expect(state.phasesExecuted).toBe(4);
			const events = readEvents(runDir);
			expect(
				events.filter((event) => event.eventType === "delegation_emit"),
			).toHaveLength(3);
			expect(eventTypes(events).at(-1)).toBe("orchestrator_end");
			expectLockReleased(runDir);
		} finally {
			workspace.cleanup();
		}
	});
});

describe("process E2E retry and timeout behavior", () => {
	test("malformed result retries to attempt 1 and ignores the stale attempt 0 result", async () => {
		const workspace = createE2EWorkspace();
		const entrypoint = workspace.writeEntrypoint(
			"retry-schema.ts",
			buildEntrypointSource(`
interface State { count: number }

await runOrchestrator<State>({
	name: "e2e-retry",
	initial: "ask",
	initialState: { count: 0 },
	resumeCommand: ${baseResumeCommandSource()},
	phases: {
		ask: definePhase<State>(async (_state, io) =>
			io.delegate(
				{
					kind: "prompt",
					prompt: "verdict",
					label: "retryable",
					retry: { maxAttempts: 2, backoffBaseMs: 1, maxBackoffMs: 1 },
				},
				"finish",
				{ count: 1 },
			),
		),
		finish: definePhase<State>(async (_state, io) => {
			const result = io.consumePendingResult(z.object({ verdict: z.string() }));
			return io.done({ verdict: result.verdict });
		}),
	},
});
`),
		);

		try {
			const initial = await workspace.runEntrypoint(entrypoint, [
				"--run-id",
				RUN_IDS.retry,
			]);
			expect(initial.exitCode).toBe(0);
			const initialBlock = expectProtocol(
				initial.stdout,
				"DELEGATE",
				RUN_IDS.retry,
			);
			const initialManifest = readManifestFile(
				String(initialBlock.fields.manifest),
			);
			const runDir = workspace.runDir("e2e-retry", RUN_IDS.retry);
			expectLastTransitionMatchesManifest(
				readStateFile<{ count: number }>(runDir),
				initialManifest,
			);
			writeMalformedPromptResult(runDir, "retryable", 0, "{not-json");

			const retry = await workspace.runEntrypoint(entrypoint, [
				"--resume",
				"--run-id",
				RUN_IDS.retry,
			]);
			expect(retry.exitCode).toBe(0);
			const retryBlock = expectProtocol(
				retry.stdout,
				"DELEGATE",
				RUN_IDS.retry,
			);
			const retryManifest = readManifestFile(
				String(retryBlock.fields.manifest),
			);
			expect(retryManifest.attempt).toBe(1);
			expect(retryManifest.resultPath).toBe(
				join(runDir, "results", "retryable-1.json"),
			);
			const retryState = readStateFile<{ count: number }>(runDir);
			expect(retryState.pendingDelegation).toMatchObject({
				label: "retryable",
				attempt: 1,
			});
			expectLastTransitionMatchesManifest(retryState, retryManifest);
			expect(eventTypes(readEvents(runDir))).toContain("retry_scheduled");

			writePromptResult(runDir, "retryable", 0, { verdict: "stale" });
			writePromptResult(runDir, "retryable", 1, { verdict: "fresh" });
			const terminal = await workspace.runEntrypoint(entrypoint, [
				"--resume",
				"--run-id",
				RUN_IDS.retry,
			]);
			expect(terminal.exitCode).toBe(0);
			const done = expectProtocol(terminal.stdout, "DONE", RUN_IDS.retry);
			expect(
				readJsonFile<{ verdict: string }>(done.fields.output as string),
			).toEqual({
				verdict: "fresh",
			});
			expectLastTransitionMatchesManifest(
				readStateFile<{ count: number }>(runDir),
				retryManifest,
			);
		} finally {
			workspace.cleanup();
		}
	});

	test("exhausted schema retry emits ERROR without a replacement attempt", async () => {
		const workspace = createE2EWorkspace();
		const entrypoint = workspace.writeEntrypoint(
			"retry-exhausted.ts",
			buildEntrypointSource(`
interface State { count: number }

await runOrchestrator<State>({
	name: "e2e-retry-exhausted",
	initial: "ask",
	initialState: { count: 0 },
	resumeCommand: ${baseResumeCommandSource()},
	phases: {
		ask: definePhase<State>(async (_state, io) =>
			io.delegate(
				{
					kind: "prompt",
					prompt: "verdict",
					label: "retryable",
					retry: { maxAttempts: 1, backoffBaseMs: 1, maxBackoffMs: 1 },
				},
				"finish",
				{ count: 1 },
			),
		),
		finish: definePhase<State>(async (_state, io) => {
			const result = io.consumePendingResult(z.object({ verdict: z.string() }));
			return io.done({ verdict: result.verdict });
		}),
	},
});
`),
		);

		try {
			const initial = await workspace.runEntrypoint(entrypoint, [
				"--run-id",
				RUN_IDS.retryExhausted,
			]);
			expect(initial.exitCode).toBe(0);
			const runDir = workspace.runDir(
				"e2e-retry-exhausted",
				RUN_IDS.retryExhausted,
			);
			writeMalformedPromptResult(runDir, "retryable", 0, "{not-json");

			const failed = await workspace.runEntrypoint(entrypoint, [
				"--resume",
				"--run-id",
				RUN_IDS.retryExhausted,
			]);
			expect(failed.exitCode).toBe(1);
			const error = expectProtocol(
				failed.stdout,
				"ERROR",
				RUN_IDS.retryExhausted,
			);
			expect(error.fields.errorKind).toBe("delegation_schema");
			expect(existsSync(join(runDir, "delegations", "retryable-1.json"))).toBe(
				false,
			);
			expectLockReleased(runDir);
		} finally {
			workspace.cleanup();
		}
	});

	test("missing result after deadline retries according to timeout policy", async () => {
		const workspace = createE2EWorkspace();
		const entrypoint = workspace.writeEntrypoint(
			"timeout-retry.ts",
			buildEntrypointSource(`
interface State { count: number }

await runOrchestrator<State>({
	name: "e2e-timeout",
	initial: "ask",
	initialState: { count: 0 },
	resumeCommand: ${baseResumeCommandSource()},
	phases: {
		ask: definePhase<State>(async (_state, io) =>
			io.delegate(
				{
					kind: "prompt",
					prompt: "slow",
					label: "slow",
					retry: { maxAttempts: 2, backoffBaseMs: 1, maxBackoffMs: 1 },
					timeout: { perDelegationMs: 1 },
				},
				"finish",
				{ count: 1 },
			),
		),
		finish: definePhase<State>(async (_state, io) => {
			const result = io.consumePendingResult(z.object({ value: z.string() }));
			return io.done(result);
		}),
	},
});
`),
		);

		try {
			const initial = await workspace.runEntrypoint(entrypoint, [
				"--run-id",
				RUN_IDS.timeout,
			]);
			expect(initial.exitCode).toBe(0);
			await Bun.sleep(25);

			const retry = await workspace.runEntrypoint(entrypoint, [
				"--resume",
				"--run-id",
				RUN_IDS.timeout,
			]);
			expect(retry.exitCode).toBe(0);
			const block = expectProtocol(retry.stdout, "DELEGATE", RUN_IDS.timeout);
			expect(readManifestFile(String(block.fields.manifest)).attempt).toBe(1);
			const runDir = workspace.runDir("e2e-timeout", RUN_IDS.timeout);
			const retryEvent = readEvents(runDir).find(
				(event) => event.eventType === "retry_scheduled",
			);
			expect(retryEvent).toMatchObject({
				eventType: "retry_scheduled",
				reason: "transient_timeout",
				attempt: 1,
			});
			expectLockReleased(runDir);
		} finally {
			workspace.cleanup();
		}
	});
});

describe("process E2E signal and lock behavior", () => {
	function blockingEntrypoint(orchestratorName: string): string {
		return buildEntrypointSource(`
interface State { started: boolean }

await runOrchestrator<State>({
	name: ${JSON.stringify(orchestratorName)},
	initial: "block",
	initialState: { started: false },
	resumeCommand: ${baseResumeCommandSource()},
	phases: {
		block: definePhase<State>(async (_state, io) => {
			await Bun.write(io.runDir + "/phase-started", "1");
			await new Promise(() => undefined);
			return io.done({ unreachable: true });
		}),
	},
});
`);
	}

	for (const [signal, runId, exitCode] of [
		["SIGINT", RUN_IDS.sigint, 130],
		["SIGTERM", RUN_IDS.sigterm, 143],
	] as const) {
		test(`${signal} emits ABORTED, preserves state, and releases lock`, async () => {
			const workspace = createE2EWorkspace();
			const entrypoint = workspace.writeEntrypoint(
				`${signal.toLowerCase()}.ts`,
				blockingEntrypoint(`e2e-${signal.toLowerCase()}`),
			);
			const runDir = workspace.runDir(`e2e-${signal.toLowerCase()}`, runId);
			const running = workspace.spawnEntrypoint(entrypoint, [
				"--run-id",
				runId,
			]);

			try {
				await waitForPath(join(runDir, "phase-started"));
				running.signal(signal);
				const result = await running.wait();
				expect(result.exitCode).toBe(exitCode);
				const block = expectProtocol(result.stdout, "ABORTED", runId);
				expect(block.fields.signal).toBe(signal);
				expect(block.fields.phase).toBe("block");
				const state = readStateFile<{ started: boolean }>(runDir);
				expect(state.currentPhase).toBe("block");
				expect(state.data).toEqual({ started: false });
				expectLockReleased(runDir);
			} finally {
				workspace.cleanup();
			}
		});
	}

	test("concurrent process with same run id fails with run_locked", async () => {
		const workspace = createE2EWorkspace();
		const entrypoint = workspace.writeEntrypoint(
			"lock-contention.ts",
			blockingEntrypoint("e2e-lock"),
		);
		const runDir = workspace.runDir("e2e-lock", RUN_IDS.lock);
		const owner = workspace.spawnEntrypoint(entrypoint, [
			"--run-id",
			RUN_IDS.lock,
		]);

		try {
			await waitForPath(join(runDir, "phase-started"));
			const contender = await workspace.runEntrypoint(entrypoint, [
				"--run-id",
				RUN_IDS.lock,
			]);
			expect(contender.exitCode).toBe(2);
			const error = expectProtocol(contender.stdout, "ERROR", RUN_IDS.lock);
			expect(error.fields.errorKind).toBe("run_locked");
			// SQLite ownership replaces file lock; ownership row is HELD.

			owner.signal("SIGTERM");
			const ownerResult = await owner.wait();
			expect(ownerResult.exitCode).toBe(143);
			expectProtocol(ownerResult.stdout, "ABORTED", RUN_IDS.lock);
			expectLockReleased(runDir);
		} finally {
			workspace.cleanup();
		}
	});
});

describe("process E2E fail-closed error paths", () => {
	function failureEntrypoint(orchestratorName: string): string {
		return buildEntrypointSource(`
interface State { count: number }

await runOrchestrator<State>({
	name: ${JSON.stringify(orchestratorName)},
	initial: "start",
	initialState: { count: 0 },
	resumeCommand: ${baseResumeCommandSource()},
	phases: {
		start: definePhase<State>(async (_state, io) => {
			switch (process.env.FAIL_MODE) {
				case "throw":
					throw new Error("boom");
				case "fail":
					return io.fail(new Error("explicit fail"));
				case "bogus": {
					const result = io.done({ ok: true });
					(result as { kind: string }).kind = "bogus";
					return result;
				}
				default:
					return io.done({ ok: true });
			}
		}),
	},
});
`);
	}

	for (const [mode, runId, expectedMessage] of [
		["throw", RUN_IDS.throw, "boom"],
		["fail", RUN_IDS.fail, "explicit fail"],
		["bogus", RUN_IDS.bogus, "unknown PhaseResult kind"],
	] as const) {
		test(`${mode} emits one ERROR block and exits non-zero`, async () => {
			const workspace = createE2EWorkspace();
			const entrypoint = workspace.writeEntrypoint(
				`${mode}.ts`,
				failureEntrypoint(`e2e-${mode}`),
			);
			try {
				const result = await workspace.runEntrypoint(
					entrypoint,
					["--run-id", runId],
					{ env: { FAIL_MODE: mode } },
				);
				expect(result.exitCode).toBe(1);
				const block = expectProtocol(result.stdout, "ERROR", runId);
				expect(String(block.fields.message)).toContain(expectedMessage);
				expectLockReleased(workspace.runDir(`e2e-${mode}`, runId));
			} finally {
				workspace.cleanup();
			}
		});
	}

	test("resume without pending delegation emits protocol ERROR", async () => {
		const workspace = createE2EWorkspace();
		const entrypoint = workspace.writeEntrypoint(
			"resume-without-pending.ts",
			failureEntrypoint("e2e-resume-without-pending"),
		);
		try {
			const initial = await workspace.runEntrypoint(entrypoint, [
				"--run-id",
				RUN_IDS.resumeWithoutPending,
			]);
			expect(initial.exitCode).toBe(0);
			const resumed = await workspace.runEntrypoint(entrypoint, [
				"--resume",
				"--run-id",
				RUN_IDS.resumeWithoutPending,
			]);
			expect(resumed.exitCode).toBe(1);
			const error = expectProtocol(
				resumed.stdout,
				"ERROR",
				RUN_IDS.resumeWithoutPending,
			);
			expect(error.fields.errorKind).toBe("protocol");
			expect(String(error.fields.message)).toContain(
				"resume without pending delegation",
			);
		} finally {
			workspace.cleanup();
		}
	});

	test("invalid run id is rejected before run directory creation", async () => {
		const workspace = createE2EWorkspace();
		const entrypoint = workspace.writeEntrypoint(
			"invalid-run-id.ts",
			failureEntrypoint("e2e-invalid-run-id"),
		);
		try {
			const result = await workspace.runEntrypoint(entrypoint, [
				"--run-id",
				"invalid/id",
			]);
			expect(result.exitCode).toBe(1);
			const error = expectProtocol(result.stdout, "ERROR", null);
			expect(error.fields.errorKind).toBe("invalid_config");
			expect(error.fields.message).toBe("--run-id must be a ULID");
			expect(existsSync(join(workspace.runDirRoot, "e2e-invalid-run-id"))).toBe(
				false,
			);
		} finally {
			workspace.cleanup();
		}
	});

	test("resume with missing state emits state_missing ERROR", async () => {
		const workspace = createE2EWorkspace();
		const entrypoint = workspace.writeEntrypoint(
			"missing-state.ts",
			failureEntrypoint("e2e-missing-state"),
		);
		try {
			const result = await workspace.runEntrypoint(entrypoint, [
				"--resume",
				"--run-id",
				RUN_IDS.missingState,
			]);
			expect(result.exitCode).toBe(1);
			const error = expectProtocol(
				result.stdout,
				"ERROR",
				RUN_IDS.missingState,
			);
			expect(error.fields.errorKind).toBe("state_missing");
		} finally {
			workspace.cleanup();
		}
	});

	test("fail after delegated resume preserves the last delegation timestamp", async () => {
		const workspace = createE2EWorkspace();
		const entrypoint = workspace.writeEntrypoint(
			"fail-after-delegate.ts",
			buildEntrypointSource(`
interface State { count: number }

await runOrchestrator<State>({
	name: "e2e-fail-after-delegate",
	initial: "ask",
	initialState: { count: 0 },
	resumeCommand: ${baseResumeCommandSource()},
	phases: {
		ask: definePhase<State>(async (_state, io) =>
			io.delegate({ kind: "prompt", prompt: "verdict", label: "answer" }, "finish", { count: 1 }),
		),
		finish: definePhase<State>(async (_state, io) => {
			io.consumePendingResult(z.object({ verdict: z.string() }));
			return io.fail(new Error("delegated failure"));
		}),
	},
});
`),
		);
		try {
			const initial = await workspace.runEntrypoint(entrypoint, [
				"--run-id",
				RUN_IDS.failAfterDelegate,
			]);
			expect(initial.exitCode).toBe(0);
			const initialBlock = expectProtocol(
				initial.stdout,
				"DELEGATE",
				RUN_IDS.failAfterDelegate,
			);
			const runDir = workspace.runDir(
				"e2e-fail-after-delegate",
				RUN_IDS.failAfterDelegate,
			);
			const manifest = readManifestFile(String(initialBlock.fields.manifest));
			writePromptResult(runDir, "answer", 0, { verdict: "bad" });

			const failed = await workspace.runEntrypoint(entrypoint, [
				"--resume",
				"--run-id",
				RUN_IDS.failAfterDelegate,
			]);
			expect(failed.exitCode).toBe(1);
			const error = expectProtocol(
				failed.stdout,
				"ERROR",
				RUN_IDS.failAfterDelegate,
			);
			expect(error.fields.errorKind).toBe("phase_error");
			expect(String(error.fields.message)).toContain("delegated failure");
			const finalState = readStateFile<{ count: number }>(runDir);
			expect(finalState.currentPhase).toBe("finish");
			expect("pendingDelegation" in finalState).toBe(false);
			expectLastTransitionMatchesManifest(finalState, manifest);
			expectLockReleased(runDir);
		} finally {
			workspace.cleanup();
		}
	});

	test("stdout remains protocol-only even while stderr carries event lines", async () => {
		const workspace = createE2EWorkspace();
		const entrypoint = workspace.writeEntrypoint(
			"stdout-only.ts",
			failureEntrypoint("e2e-stdout-only"),
		);
		try {
			const result = await workspace.runEntrypoint(entrypoint, [
				"--run-id",
				"01HX0000000000000000000018",
			]);
			expect(result.exitCode).toBe(0);
			expectProtocol(result.stdout, "DONE", "01HX0000000000000000000018");
			expectNoProtocolOnStderr(result.stderr);
			const stderrLines = result.stderr.trim().split("\n");
			expect(stderrLines.length).toBeGreaterThan(0);
			for (const line of stderrLines) {
				expect(() => JSON.parse(line)).not.toThrow();
			}
		} finally {
			workspace.cleanup();
		}
	});

	test("DONE block output path points to the exact output file content", async () => {
		const workspace = createE2EWorkspace();
		const entrypoint = workspace.writeEntrypoint(
			"done-output.ts",
			failureEntrypoint("e2e-output-path"),
		);
		try {
			const result = await workspace.runEntrypoint(entrypoint, [
				"--run-id",
				"01HX0000000000000000000019",
			]);
			expect(result.exitCode).toBe(0);
			const done = expectProtocol(
				result.stdout,
				"DONE",
				"01HX0000000000000000000019",
			);
			expect(readFileSync(done.fields.output as string, "utf-8")).toBe(
				'{"ok":true}',
			);
		} finally {
			workspace.cleanup();
		}
	});
});
