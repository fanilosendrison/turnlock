import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ProtocolAction } from "../../src/services/protocol";
import {
	buildEntrypointSource,
	countProtocolBlocks,
	createE2EWorkspace,
	parseSingleProtocolBlock,
	readEvents,
	readJsonFile,
	readStateFile,
	writeExternalResolution,
	writeMalformedPromptResult,
	writePromptResult,
} from "../helpers/e2e-process";

const RUN_IDS = {
	crashAfterConsume: "01HX0000000000000000000040",
	migrationDelegation: "01HX0000000000000000000041",
	migrationRetry: "01HX0000000000000000000044",
	resumeCommandFailure: "01HX0000000000000000000049",
} as const;

function baseResumeCommandSource(): string {
	return '(runId) => "bun " + import.meta.path + " --run-id " + runId + " --resume"';
}

function expectProtocol(stdout: string, action: ProtocolAction, runId: string) {
	expect(countProtocolBlocks(stdout)).toBe(1);
	const block = parseSingleProtocolBlock(stdout);
	expect(block.action).toBe(action);
	expect(block.runId).toBe(runId);
	return block;
}

describe("external request crash durability", () => {
	test("a crash after consumption leaves the same resolution consumable on the next resume", async () => {
		const workspace = createE2EWorkspace();
		const entrypoint = workspace.writeEntrypoint(
			"external-crash-after-consume.ts",
			buildEntrypointSource(`
interface State { stage: string }

await runOrchestrator<State>({
	name: "e2e-external-crash",
	initial: "request",
	initialState: { stage: "initial" },
	resumeCommand: ${baseResumeCommandSource()},
	phases: {
		request: definePhase<State>(async (_state, io) =>
			io.requestExternal(
				{ label: "external-work", requestType: "example.work", payload: null },
				"consume",
				{ stage: "waiting" },
			),
		),
		consume: definePhase<State>(async (_state, io) => {
			const resolution = io.consumePendingExternalResolution(
				z.object({ value: z.string() }),
			);
			if (process.env.CRASH_AFTER_CONSUME === "1") process.exit(77);
			return io.done({ value: resolution.value });
		}),
	},
});
`),
		);
		try {
			const initial = await workspace.runEntrypoint(entrypoint, [
				"--run-id",
				RUN_IDS.crashAfterConsume,
			]);
			expect(initial.exitCode).toBe(0);
			const runDir = workspace.runDir(
				"e2e-external-crash",
				RUN_IDS.crashAfterConsume,
			);
			writeExternalResolution(runDir, "external-work", { value: "durable" });

			const crashed = await workspace.runEntrypoint(
				entrypoint,
				["--resume", "--run-id", RUN_IDS.crashAfterConsume],
				{ env: { CRASH_AFTER_CONSUME: "1" } },
			);
			expect(crashed.exitCode).toBe(77);
			expect(crashed.stdout).toBe("");
			const stateAfterCrash = readStateFile<{ stage: string }>(runDir);
			const acceptedResolutionPath = join(
				runDir,
				"accepted-external-resolutions",
				"external-work.json",
			);
			expect(stateAfterCrash.pendingExternalRequest).toMatchObject({
				requestId: `${RUN_IDS.crashAfterConsume}/external-work`,
				resultPath: join(runDir, "external-results", "external-work.json"),
				acceptedResolutionPath,
				acceptedResolutionDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
				acceptedAt: expect.any(String),
			});
			expect(readFileSync(acceptedResolutionPath, "utf-8")).toBe(
				'{"value":"durable"}',
			);

			writeExternalResolution(runDir, "external-work", {
				value: "replacement",
			});

			const lockPath = join(runDir, ".lock");
			const lock = readJsonFile<Record<string, unknown>>(lockPath);
			writeFileSync(
				lockPath,
				JSON.stringify({ ...lock, leaseUntilEpochMs: 0 }),
			);

			const resumed = await workspace.runEntrypoint(entrypoint, [
				"--resume",
				"--run-id",
				RUN_IDS.crashAfterConsume,
			]);
			expect(resumed.exitCode).toBe(0);
			const done = expectProtocol(
				resumed.stdout,
				"DONE",
				RUN_IDS.crashAfterConsume,
			);
			expect(
				readJsonFile<{ value: string }>(done.fields.output as string),
			).toEqual({ value: "durable" });
			const finalState = readStateFile<{ stage: string }>(runDir);
			expect(finalState).not.toHaveProperty("pendingExternalRequest");
			expect(existsSync(lockPath)).toBe(false);
			expect(
				readEvents(runDir).filter(
					(event) => event.eventType === "external_resolution_validated",
				),
			).toHaveLength(2);
		} finally {
			workspace.cleanup();
		}
	});

	test("a resume command failure cannot roll back a committed external request", async () => {
		const workspace = createE2EWorkspace();
		const entrypoint = workspace.writeEntrypoint(
			"external-resume-command-failure.ts",
			buildEntrypointSource(`
interface State { stage: string }

await runOrchestrator<State>({
	name: "e2e-external-resume-command-failure",
	initial: "request",
	initialState: { stage: "initial" },
	resumeCommand: (runId) => {
		if (process.env.RESUME_COMMAND_BOOM === "1") throw new Error("boom");
		return "bun " + import.meta.path + " --run-id " + runId + " --resume";
	},
	phases: {
		request: definePhase<State>(async (_state, io) =>
			io.requestExternal(
				{ label: "external-work", requestType: "example.work", payload: null },
				"consume",
				{ stage: "waiting" },
			),
		),
		consume: definePhase<State>(async (_state, io) => {
			const resolution = io.consumePendingExternalResolution(z.unknown());
			return io.done(resolution);
		}),
	},
});
`),
		);
		try {
			const failed = await workspace.runEntrypoint(
				entrypoint,
				["--run-id", RUN_IDS.resumeCommandFailure],
				{ env: { RESUME_COMMAND_BOOM: "1" } },
			);
			expect(failed.exitCode).toBe(1);
			expectProtocol(
				failed.stdout,
				"ERROR",
				RUN_IDS.resumeCommandFailure,
			);

			const runDir = workspace.runDir(
				"e2e-external-resume-command-failure",
				RUN_IDS.resumeCommandFailure,
			);
			const committed = readStateFile<{ stage: string }>(runDir);
			expect(committed.data).toEqual({ stage: "waiting" });
			expect(committed.phasesExecuted).toBe(1);
			expect(committed.pendingExternalRequest).toMatchObject({
				requestId: `${RUN_IDS.resumeCommandFailure}/external-work`,
				label: "external-work",
				resumeAt: "consume",
				manifestDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
			});
			expect(
				existsSync(
					join(runDir, "external-requests", "external-work.json"),
				),
			).toBe(true);

			const resumed = await workspace.runEntrypoint(entrypoint, [
				"--resume",
				"--run-id",
				RUN_IDS.resumeCommandFailure,
			]);
			expect(resumed.exitCode).toBe(0);
			expectProtocol(
				resumed.stdout,
				"REQUEST_EXTERNAL",
				RUN_IDS.resumeCommandFailure,
			);
			expect(readStateFile(runDir)).toEqual(committed);
		} finally {
			workspace.cleanup();
		}
	});
});

describe("state v2 migration during resume", () => {
	test("a v2 pending delegation is persisted as v3 under the acquired lock and remains resumable", async () => {
		const workspace = createE2EWorkspace();
		const entrypoint = workspace.writeEntrypoint(
			"state-v2-delegation.ts",
			buildEntrypointSource(`
interface State { stage: string }

await runOrchestrator<State>({
	name: "e2e-state-v2-delegation",
	initial: "request",
	initialState: { stage: "initial" },
	resumeCommand: ${baseResumeCommandSource()},
	phases: {
		request: definePhase<State>(async (_state, io) =>
			io.delegate(
				{ kind: "prompt", label: "review", prompt: "review" },
				"consume",
				{ stage: "waiting" },
			),
		),
		consume: definePhase<State>(async (_state, io) => {
			const resolution = io.consumePendingResult(z.object({ value: z.string() }));
			const persisted = await Bun.file(io.runDir + "/state.json").json() as { schemaVersion: number };
			const lockHeldAtResume = await Bun.file(io.runDir + "/.lock").exists();
			return io.done({
				value: resolution.value,
				schemaVersionAtResume: persisted.schemaVersion,
				lockHeldAtResume,
			});
		}),
	},
});
`),
		);
		try {
			const initial = await workspace.runEntrypoint(entrypoint, [
				"--run-id",
				RUN_IDS.migrationDelegation,
			]);
			expect(initial.exitCode).toBe(0);
			expectProtocol(initial.stdout, "DELEGATE", RUN_IDS.migrationDelegation);
			const runDir = workspace.runDir(
				"e2e-state-v2-delegation",
				RUN_IDS.migrationDelegation,
			);
			const statePath = join(runDir, "state.json");
			const current = readJsonFile<Record<string, unknown>>(statePath);
			const pendingBefore = current.pendingDelegation;
			writeFileSync(
				statePath,
				JSON.stringify({ ...current, schemaVersion: 2 }),
			);
			writePromptResult(runDir, "review", 0, { value: "preserved" });

			const resumed = await workspace.runEntrypoint(entrypoint, [
				"--resume",
				"--run-id",
				RUN_IDS.migrationDelegation,
			]);
			expect(resumed.exitCode).toBe(0);
			const done = expectProtocol(
				resumed.stdout,
				"DONE",
				RUN_IDS.migrationDelegation,
			);
			expect(
				readJsonFile<{
					value: string;
					schemaVersionAtResume: number;
					lockHeldAtResume: boolean;
				}>(done.fields.output as string),
			).toEqual({
				value: "preserved",
				schemaVersionAtResume: 3,
				lockHeldAtResume: true,
			});
			const finalState = readStateFile<{ stage: string }>(runDir);
			expect(finalState.schemaVersion).toBe(3);
			expect(finalState).not.toHaveProperty("pendingDelegation");
			expect(existsSync(join(runDir, "state.json.tmp"))).toBe(false);
			expect(pendingBefore).toBeDefined();
			expect(readFileSync(statePath, "utf-8")).toContain('"schemaVersion":3');
		} finally {
			workspace.cleanup();
		}
	});

	test("a migrated v2 pending delegation keeps its existing retry behavior", async () => {
		const workspace = createE2EWorkspace();
		const entrypoint = workspace.writeEntrypoint(
			"state-v2-delegation-retry.ts",
			buildEntrypointSource(`
interface State { stage: string }

await runOrchestrator<State>({
	name: "e2e-state-v2-retry",
	initial: "request",
	initialState: { stage: "initial" },
	resumeCommand: ${baseResumeCommandSource()},
	phases: {
		request: definePhase<State>(async (_state, io) =>
			io.delegate(
				{
					kind: "prompt",
					label: "review",
					prompt: "review",
					retry: { maxAttempts: 2, backoffBaseMs: 1, maxBackoffMs: 1 },
				},
				"consume",
				{ stage: "waiting" },
			),
		),
		consume: definePhase<State>(async (_state, io) => {
			const resolution = io.consumePendingResult(z.object({ value: z.string() }));
			return io.done(resolution);
		}),
	},
});
`),
		);
		try {
			const initial = await workspace.runEntrypoint(entrypoint, [
				"--run-id",
				RUN_IDS.migrationRetry,
			]);
			expect(initial.exitCode).toBe(0);
			const runDir = workspace.runDir(
				"e2e-state-v2-retry",
				RUN_IDS.migrationRetry,
			);
			const statePath = join(runDir, "state.json");
			const current = readJsonFile<Record<string, unknown>>(statePath);
			writeFileSync(
				statePath,
				JSON.stringify({ ...current, schemaVersion: 2 }),
			);
			writeMalformedPromptResult(runDir, "review", 0, "{not-json");

			const retried = await workspace.runEntrypoint(entrypoint, [
				"--resume",
				"--run-id",
				RUN_IDS.migrationRetry,
			]);
			expect(retried.exitCode).toBe(0);
			const block = expectProtocol(
				retried.stdout,
				"DELEGATE",
				RUN_IDS.migrationRetry,
			);
			const manifest = readJsonFile<{ attempt: number }>(
				block.fields.manifest as string,
			);
			expect(manifest.attempt).toBe(1);
			const state = readStateFile<{ stage: string }>(runDir);
			expect(state.schemaVersion).toBe(3);
			expect(state.pendingDelegation?.attempt).toBe(1);
			expect(
				readEvents(runDir).some(
					(event) => event.eventType === "retry_scheduled",
				),
			).toBe(true);
		} finally {
			workspace.cleanup();
		}
	});
});
