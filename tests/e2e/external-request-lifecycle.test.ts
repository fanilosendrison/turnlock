import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ProtocolAction } from "../../src/services/protocol";
import type { OrchestratorEvent } from "../../src/types/events";
import {
	buildEntrypointSource,
	countProtocolBlocks,
	createE2EWorkspace,
	parseSingleProtocolBlock,
	readEvents,
	readExternalRequestManifest,
	readJsonFile,
	readStateFile,
	writeExternalResolution,
} from "../helpers/e2e-process";

const RUN_IDS = {
	initial: "01HX0000000000000000000030",
	resolved: "01HX0000000000000000000031",
	reemit: "01HX0000000000000000000032",
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

function eventTypes(events: readonly OrchestratorEvent[]): string[] {
	return events.map((event) => event.eventType);
}

function lifecycleSource(orchestratorName: string): string {
	return buildEntrypointSource(`
interface State { stage: string }

await runOrchestrator<State>({
	name: ${JSON.stringify(orchestratorName)},
	initial: "push",
	initialState: { stage: "initial" },
	resumeCommand: ${baseResumeCommandSource()},
	phases: {
		push: definePhase<State>(async (_state, io) =>
			io.requestExternal(
				{
					label: "push-repo-a",
					requestType: "git.push",
					payload: {
						repository: "/repo-a",
						remote: "origin",
						branch: "main",
						targetSha: "abc123",
					},
				},
				"after-push",
				{ stage: "waiting" },
			),
		),
		"after-push": definePhase<State>(async (state, io) => {
			const resolution = io.consumePendingExternalResolution(
				z.object({
					outcome: z.enum(["PUSHED", "REJECTED", "UNKNOWN"]),
					remoteSha: z.string().optional(),
				}),
			);
			return io.done({ state, resolution });
		}),
	},
});
`);
}

describe("external request lifecycle", () => {
	test("initial emission persists the manifest and pending state before yielding", async () => {
		const workspace = createE2EWorkspace();
		const entrypoint = workspace.writeEntrypoint(
			"external-initial.ts",
			lifecycleSource("e2e-external-initial"),
		);
		try {
			const result = await workspace.runEntrypoint(entrypoint, [
				"--run-id",
				RUN_IDS.initial,
			]);
			expect(result.exitCode).toBe(0);
			const block = expectProtocol(
				result.stdout,
				"REQUEST_EXTERNAL",
				RUN_IDS.initial,
			);
			const runDir = workspace.runDir("e2e-external-initial", RUN_IDS.initial);
			const manifestPath = join(
				runDir,
				"external-requests",
				"push-repo-a.json",
			);
			const resultPath = join(runDir, "external-results", "push-repo-a.json");
			expect(block.fields.requestId).toBe(`${RUN_IDS.initial}/push-repo-a`);
			expect(block.fields.requestType).toBe("git.push");
			expect(block.fields.manifest).toBe(manifestPath);
			expect(block.fields.result).toBe(resultPath);

			const manifest = readExternalRequestManifest(manifestPath);
			expect(manifest).toEqual({
				manifestVersion: 1,
				kind: "external-request",
				requestId: `${RUN_IDS.initial}/push-repo-a`,
				runId: RUN_IDS.initial,
				orchestratorName: "e2e-external-initial",
				phase: "push",
				resumeAt: "after-push",
				label: "push-repo-a",
				requestType: "git.push",
				payload: {
					repository: "/repo-a",
					remote: "origin",
					branch: "main",
					targetSha: "abc123",
				},
				emittedAt: expect.any(String),
				emittedAtEpochMs: expect.any(Number),
				resultPath,
			});

			const state = readStateFile<{ stage: string }>(runDir);
			expect(state.data).toEqual({ stage: "waiting" });
			expect(state.usedLabels).toEqual(["push-repo-a"]);
			expect(state.pendingExternalRequest).toEqual({
				requestId: manifest.requestId,
				label: manifest.label,
				requestType: manifest.requestType,
				resumeAt: manifest.resumeAt,
				manifestPath,
				resultPath,
				emittedAt: manifest.emittedAt,
				emittedAtEpochMs: manifest.emittedAtEpochMs,
			});
			expect(state).not.toHaveProperty("pendingDelegation");
			expect(state.lastTransitionAt).toBe(manifest.emittedAt);
			expect(state.lastTransitionAtEpochMs).toBe(manifest.emittedAtEpochMs);
			expect(existsSync(join(runDir, ".lock"))).toBe(false);

			const events = readEvents(runDir);
			expect(eventTypes(events)).toEqual([
				"orchestrator_start",
				"phase_start",
				"phase_end",
				"external_request_emit",
			]);
			const emitted = events.at(-1);
			expect(emitted).toMatchObject({
				eventType: "external_request_emit",
				runId: RUN_IDS.initial,
				phase: "push",
				label: "push-repo-a",
				requestId: `${RUN_IDS.initial}/push-repo-a`,
				requestType: "git.push",
			});
			expect(JSON.stringify(emitted)).not.toContain("repository");
		} finally {
			workspace.cleanup();
		}
	});

	test("a durable opaque resolution resumes, validates, and clears the pending record", async () => {
		const workspace = createE2EWorkspace();
		const entrypoint = workspace.writeEntrypoint(
			"external-resolved.ts",
			lifecycleSource("e2e-external-resolved"),
		);
		try {
			const initial = await workspace.runEntrypoint(entrypoint, [
				"--run-id",
				RUN_IDS.resolved,
			]);
			expect(initial.exitCode).toBe(0);
			expectProtocol(initial.stdout, "REQUEST_EXTERNAL", RUN_IDS.resolved);
			const runDir = workspace.runDir(
				"e2e-external-resolved",
				RUN_IDS.resolved,
			);
			writeExternalResolution(runDir, "push-repo-a", {
				outcome: "PUSHED",
				remoteSha: "def456",
			});

			const resumed = await workspace.runEntrypoint(entrypoint, [
				"--resume",
				"--run-id",
				RUN_IDS.resolved,
			]);
			expect(resumed.exitCode).toBe(0);
			const done = expectProtocol(resumed.stdout, "DONE", RUN_IDS.resolved);
			expect(
				readJsonFile<{
					state: { stage: string };
					resolution: { outcome: string; remoteSha?: string };
				}>(done.fields.output as string),
			).toEqual({
				state: { stage: "waiting" },
				resolution: { outcome: "PUSHED", remoteSha: "def456" },
			});

			const state = readStateFile<{ stage: string }>(runDir);
			expect(state.currentPhase).toBe("after-push");
			expect(state.phasesExecuted).toBe(2);
			expect(state).not.toHaveProperty("pendingExternalRequest");
			expect(state).not.toHaveProperty("pendingDelegation");
			const types = eventTypes(readEvents(runDir));
			expect(types).toContain("external_resolution_read");
			expect(types).toContain("external_resolution_validated");
			expect(types).not.toContain("retry_scheduled");
			expect(existsSync(join(runDir, ".lock"))).toBe(false);
		} finally {
			workspace.cleanup();
		}
	});

	test("missing resolution re-emits the identical request without mutating state or manifest", async () => {
		const workspace = createE2EWorkspace();
		const entrypoint = workspace.writeEntrypoint(
			"external-reemit.ts",
			lifecycleSource("e2e-external-reemit"),
		);
		try {
			const initial = await workspace.runEntrypoint(entrypoint, [
				"--run-id",
				RUN_IDS.reemit,
			]);
			expect(initial.exitCode).toBe(0);
			const firstBlock = expectProtocol(
				initial.stdout,
				"REQUEST_EXTERNAL",
				RUN_IDS.reemit,
			);
			const runDir = workspace.runDir("e2e-external-reemit", RUN_IDS.reemit);
			const statePath = join(runDir, "state.json");
			const manifestPath = firstBlock.fields.manifest as string;
			const stateBefore = readFileSync(statePath, "utf-8");
			const manifestBefore = readFileSync(manifestPath, "utf-8");

			const resumed = await workspace.runEntrypoint(entrypoint, [
				"--resume",
				"--run-id",
				RUN_IDS.reemit,
			]);
			expect(resumed.exitCode).toBe(0);
			const secondBlock = expectProtocol(
				resumed.stdout,
				"REQUEST_EXTERNAL",
				RUN_IDS.reemit,
			);
			expect(secondBlock.fields.requestId).toBe(firstBlock.fields.requestId);
			expect(secondBlock.fields.manifest).toBe(firstBlock.fields.manifest);
			expect(secondBlock.fields.result).toBe(firstBlock.fields.result);
			expect(readFileSync(statePath, "utf-8")).toBe(stateBefore);
			expect(readFileSync(manifestPath, "utf-8")).toBe(manifestBefore);
			expect(readdirSync(join(runDir, "external-requests"))).toEqual([
				"push-repo-a.json",
			]);

			const resumedAgain = await workspace.runEntrypoint(entrypoint, [
				"--resume",
				"--run-id",
				RUN_IDS.reemit,
			]);
			expect(resumedAgain.exitCode).toBe(0);
			const thirdBlock = expectProtocol(
				resumedAgain.stdout,
				"REQUEST_EXTERNAL",
				RUN_IDS.reemit,
			);
			expect(thirdBlock.fields.requestId).toBe(firstBlock.fields.requestId);
			expect(thirdBlock.fields.requestType).toBe(firstBlock.fields.requestType);
			expect(thirdBlock.fields.manifest).toBe(firstBlock.fields.manifest);
			expect(thirdBlock.fields.result).toBe(firstBlock.fields.result);
			expect(readFileSync(statePath, "utf-8")).toBe(stateBefore);
			expect(readFileSync(manifestPath, "utf-8")).toBe(manifestBefore);

			const manifest = readExternalRequestManifest(manifestPath);
			expect(manifest.emittedAt).toBe(
				JSON.parse(manifestBefore).emittedAt as string,
			);
			expect(manifest.emittedAtEpochMs).toBe(
				JSON.parse(manifestBefore).emittedAtEpochMs as number,
			);
			const events = readEvents(runDir);
			expect(
				events.filter((event) => event.eventType === "external_request_emit"),
			).toHaveLength(1);
			expect(
				events.filter((event) => event.eventType === "external_request_reemit"),
			).toHaveLength(2);
			expect(eventTypes(events)).not.toContain("retry_scheduled");
			expect(existsSync(join(runDir, ".lock"))).toBe(false);
		} finally {
			workspace.cleanup();
		}
	});
});
