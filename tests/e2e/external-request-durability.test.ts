import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { nodeSqliteDriver } from "../../src/persistence/sqlite/node-sqlite-driver.js";
import type { ProtocolAction } from "../../src/services/protocol.js";
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
} from "../helpers/e2e-process.js";

const RUN_IDS = {
	crashAfterConsume: "01HX0000000000000000000040",
	migrationDelegation: "01HX0000000000000000000041",
	migrationRetry: "01HX0000000000000000000044",
	resumeCommandFailure: "01HX0000000000000000000049",
} as const;
function baseResumeCommandSource(): string {
	return '(runId) => "node " + import.meta.filename + " --run-id " + runId + " --resume"';
}
function expectProtocol(stdout: string, action: ProtocolAction, runId: string) {
	assert.strictEqual(countProtocolBlocks(stdout), 1);
	const block = parseSingleProtocolBlock(stdout);
	assert.strictEqual(block.action, action);
	assert.strictEqual(block.runId, runId);
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
			assert.strictEqual(initial.exitCode, 0);
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
			assert.strictEqual(crashed.exitCode, 77);
			assert.strictEqual(crashed.stdout, "");
			const stateAfterCrash = readStateFile<{
				stage: string;
			}>(runDir);
			const acceptedResolutionPath = join(
				runDir,
				"accepted-external-resolutions",
				"external-work.json",
			);
			assert.partialDeepStrictEqual(stateAfterCrash.pendingExternalRequest, {
				requestId: `${RUN_IDS.crashAfterConsume}/external-work`,
				resultPath: join(runDir, "external-results", "external-work.json"),
				acceptedResolutionPath,
			});
			const acceptedResolutionDigest =
				stateAfterCrash.pendingExternalRequest?.acceptedResolutionDigest;
			if (typeof acceptedResolutionDigest !== "string") {
				assert.fail("expected an accepted resolution digest");
			}
			assert.match(acceptedResolutionDigest, /^sha256:[0-9a-f]{64}$/);
			assert.strictEqual(
				typeof stateAfterCrash.pendingExternalRequest?.acceptedAt,
				"string",
			);
			assert.strictEqual(
				readFileSync(acceptedResolutionPath, "utf-8"),
				'{"value":"durable"}',
			);
			writeExternalResolution(runDir, "external-work", {
				value: "replacement",
			});
			// Expire the SQLite lease so the next process can take over.
			const dbPath = join(runDir, "turnlock.sqlite3");
			const db = nodeSqliteDriver.open(dbPath);
			try {
				db.exec(
					"UPDATE run_ownership SET lease_until_epoch_ms = 0 WHERE singleton = 1",
				);
			} finally {
				db.close();
			}
			const resumed = await workspace.runEntrypoint(entrypoint, [
				"--resume",
				"--run-id",
				RUN_IDS.crashAfterConsume,
			]);
			assert.strictEqual(resumed.exitCode, 0);
			const done = expectProtocol(
				resumed.stdout,
				"DONE",
				RUN_IDS.crashAfterConsume,
			);
			assert.deepStrictEqual(
				readJsonFile<{
					value: string;
				}>(done.fields.output as string),
				{ value: "durable" },
			);
			const finalState = readStateFile<{
				stage: string;
			}>(runDir);
			assert.ok(!("pendingExternalRequest" in Object(finalState)));
			// SQLite: ownership row is FREE on release.
			assert.strictEqual(
				readEvents(runDir).filter(
					(event) => event.eventType === "external_resolution_validated",
				).length,
				2,
			);
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
		return "node " + import.meta.filename + " --run-id " + runId + " --resume";
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
			assert.strictEqual(failed.exitCode, 1);
			expectProtocol(failed.stdout, "ERROR", RUN_IDS.resumeCommandFailure);
			const runDir = workspace.runDir(
				"e2e-external-resume-command-failure",
				RUN_IDS.resumeCommandFailure,
			);
			const committed = readStateFile<{
				stage: string;
			}>(runDir);
			assert.deepStrictEqual(committed.data, { stage: "waiting" });
			assert.strictEqual(committed.phasesExecuted, 1);
			assert.partialDeepStrictEqual(committed.pendingExternalRequest, {
				requestId: `${RUN_IDS.resumeCommandFailure}/external-work`,
				label: "external-work",
				resumeAt: "consume",
				/* manifestArtifact checked separately below */
			});
			// The immutable blob must exist even if the canonical projection doesn't.
			const artifactRef = committed.pendingExternalRequest?.manifestArtifact;
			assert.notStrictEqual(artifactRef, undefined);
			if (artifactRef?.relativePath) {
				assert.strictEqual(
					existsSync(join(runDir, artifactRef.relativePath)),
					true,
				);
			}
			const resumed = await workspace.runEntrypoint(entrypoint, [
				"--resume",
				"--run-id",
				RUN_IDS.resumeCommandFailure,
			]);
			assert.strictEqual(resumed.exitCode, 0);
			expectProtocol(
				resumed.stdout,
				"REQUEST_EXTERNAL",
				RUN_IDS.resumeCommandFailure,
			);
			assert.deepStrictEqual(readStateFile(runDir), committed);
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
				{ kind: "prompt", target: { kind: "host" }, label: "review", prompt: "review" },
				"consume",
				{ stage: "waiting" },
			),
		),
		consume: definePhase<State>(async (_state, io) => {
			const resolution = io.consumePendingResult(z.object({ value: z.string() }));
			const persisted = JSON.parse(await readFile(io.runDir + "/state.json", "utf8")) as { schemaVersion: number };
			// SQLite-based ownership: the DB holds the authority, not .lock.
			const dbPath = io.runDir + "/turnlock.sqlite3";
			const db = nodeSqliteDriver.open(dbPath);
			const lockRow = db.prepare("SELECT ownership_status FROM run_ownership WHERE singleton = 1").get() as { ownership_status: string } | undefined;
			const lockHeldAtResume = lockRow?.ownership_status === "HELD";
			db.close();
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
			assert.strictEqual(initial.exitCode, 0);
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
			assert.strictEqual(resumed.exitCode, 0);
			const done = expectProtocol(
				resumed.stdout,
				"DONE",
				RUN_IDS.migrationDelegation,
			);
			assert.deepStrictEqual(
				readJsonFile<{
					value: string;
					schemaVersionAtResume: number;
					lockHeldAtResume: boolean;
				}>(done.fields.output as string),
				{
					value: "preserved",
					schemaVersionAtResume: 4,
					lockHeldAtResume: true,
				},
			);
			const finalState = readStateFile<{
				stage: string;
			}>(runDir);
			assert.strictEqual(finalState.schemaVersion, 4);
			assert.ok(!("pendingDelegation" in Object(finalState)));
			assert.strictEqual(existsSync(join(runDir, "state.json.tmp")), false);
			assert.notStrictEqual(pendingBefore, undefined);
			assert.ok(readFileSync(statePath, "utf-8").includes('"schemaVersion":4'));
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
					target: { kind: "host" },
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
			assert.strictEqual(initial.exitCode, 0);
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
			assert.strictEqual(retried.exitCode, 0);
			const block = expectProtocol(
				retried.stdout,
				"DELEGATE",
				RUN_IDS.migrationRetry,
			);
			const manifest = readJsonFile<{
				attempt: number;
			}>(block.fields.manifest as string);
			assert.strictEqual(manifest.attempt, 1);
			const state = readStateFile<{
				stage: string;
			}>(runDir);
			assert.strictEqual(state.schemaVersion, 4);
			assert.strictEqual(state.pendingDelegation?.attempt, 1);
			assert.strictEqual(
				readEvents(runDir).some(
					(event) => event.eventType === "retry_scheduled",
				),
				true,
			);
		} finally {
			workspace.cleanup();
		}
	});
});
