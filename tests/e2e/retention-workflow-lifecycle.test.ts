import assert from "node:assert/strict";
import { existsSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { nodeSqliteDriver } from "../../src/persistence/sqlite/node-sqlite-driver.js";
import {
	buildEntrypointSource,
	createE2EWorkspace,
	parseSingleProtocolBlock,
	readStateFile,
	writePromptResult,
} from "../helpers/e2e-process.js";

const ORCHESTRATOR_NAME = "retention-workflow-lifecycle";
const SUSPENDED_RUN_ID = "01HX000000000000000000000A";
const CLEANUP_RUN_ID = "01HX000000000000000000000B";
const INDETERMINATE_RUN_ID = "01HX000000000000000000000C";
const FAILED_RUN_ID = "01HX000000000000000000000D";
const FAILURE_CLEANUP_RUN_ID = "01HX000000000000000000000E";
const DAY_MS = 24 * 60 * 60 * 1000;

function readOwnershipStatus(runDir: string): string | undefined {
	const database = nodeSqliteDriver.openReadOnly(
		join(runDir, "turnlock.sqlite3"),
	);
	try {
		return database
			.prepare("SELECT ownership_status FROM run_ownership WHERE singleton = 1")
			.get<{ readonly ownership_status: string }>()?.ownership_status;
	} finally {
		database.close();
	}
}

function readLifecycle(runDir: string): {
	readonly lifecycle_status: string;
	readonly terminal_kind: string | null;
} {
	const database = nodeSqliteDriver.openReadOnly(
		join(runDir, "turnlock.sqlite3"),
	);
	try {
		const lifecycle = database
			.prepare(`SELECT lifecycle_status, terminal_kind
				 FROM run_workflow_lifecycle WHERE singleton = 1`)
			.get<{
				readonly lifecycle_status: string;
				readonly terminal_kind: string | null;
			}>();
		if (lifecycle === undefined) throw new Error("lifecycle row missing");
		return {
			lifecycle_status: lifecycle.lifecycle_status,
			terminal_kind: lifecycle.terminal_kind,
		};
	} finally {
		database.close();
	}
}

describe("process E2E retention workflow lifecycle", () => {
	test("a suspended run survives foreign startup cleanup and remains resumable", async () => {
		const workspace = createE2EWorkspace("turnlock-retention-lifecycle-");
		const entrypoint = workspace.writeEntrypoint(
			"retention-workflow-lifecycle.ts",
			buildEntrypointSource(`
interface State { stage: string }

await runOrchestrator<State>({
	name: ${JSON.stringify(ORCHESTRATOR_NAME)},
	initial: "request-review",
	initialState: { stage: "initial" },
	retentionDays: 0,
	resumeCommand: (runId) =>
		"node retention-workflow-lifecycle.ts --run-id " + runId + " --resume",
	phases: {
		"request-review": definePhase<State>(async (_state, io) =>
			io.delegate(
				{
					kind: "prompt",
					target: { kind: "host" },
					prompt: "continue this durable workflow",
					label: "review",
				},
				"finish",
				{ stage: "suspended" },
			),
		),
		finish: definePhase<State>(async (state, io) => {
			const result = io.consumePendingResult(z.object({ approved: z.boolean() }));
			return io.done({ stage: state.stage, approved: result.approved });
		}),
	},
});
`),
		);
		try {
			const suspendedProcess = await workspace.runEntrypoint(entrypoint, [
				"--run-id",
				SUSPENDED_RUN_ID,
			]);
			assert.strictEqual(suspendedProcess.exitCode, 0);
			assert.strictEqual(
				parseSingleProtocolBlock(suspendedProcess.stdout).action,
				"DELEGATE",
			);

			const suspendedRunDir = workspace.runDir(
				ORCHESTRATOR_NAME,
				SUSPENDED_RUN_ID,
			);
			assert.ok(readStateFile(suspendedRunDir).pendingDelegation);
			assert.strictEqual(readOwnershipStatus(suspendedRunDir), "FREE");
			const oldTimestamp = new Date(Date.now() - DAY_MS);
			utimesSync(suspendedRunDir, oldTimestamp, oldTimestamp);

			const cleanupProcess = await workspace.runEntrypoint(entrypoint, [
				"--run-id",
				CLEANUP_RUN_ID,
			]);
			assert.strictEqual(cleanupProcess.exitCode, 0);
			assert.strictEqual(existsSync(suspendedRunDir), true);

			writePromptResult(suspendedRunDir, "review", 0, { approved: true });
			const resumedProcess = await workspace.runEntrypoint(entrypoint, [
				"--resume",
				"--run-id",
				SUSPENDED_RUN_ID,
			]);
			assert.strictEqual(resumedProcess.exitCode, 0);
			assert.strictEqual(
				parseSingleProtocolBlock(resumedProcess.stdout).action,
				"DONE",
			);
		} finally {
			workspace.cleanup();
		}
	});

	test("only explicit fail terminalizes; indeterminate errors are retained", {
		timeout: 30_000,
	}, async () => {
		const workspace = createE2EWorkspace("turnlock-retention-failure-");
		const entrypoint = workspace.writeEntrypoint(
			"retention-failure-lifecycle.ts",
			buildEntrypointSource(`
interface State { stage: string }

await runOrchestrator<State>({
	name: ${JSON.stringify(ORCHESTRATOR_NAME)},
	initial: "start",
	initialState: { stage: "initial" },
	retentionDays: 0,
	resumeCommand: (runId) =>
		"node retention-failure-lifecycle.ts --run-id " + runId + " --resume",
	phases: {
		start: definePhase<State>(async (_state, io) => {
			if (process.env.MODE === "throw") throw new Error("indeterminate");
			if (process.env.MODE === "fail") return io.fail(new Error("terminal"));
			return io.delegate(
				{
					kind: "prompt",
					target: { kind: "host" },
					prompt: "cleanup trigger",
					label: "cleanup",
				},
				"finish",
				{ stage: "waiting" },
			);
		}),
		finish: definePhase<State>(async (_state, io) => io.done({ ok: true })),
	},
});
`),
		);
		try {
			const indeterminate = await workspace.runEntrypoint(
				entrypoint,
				["--run-id", INDETERMINATE_RUN_ID],
				{ env: { MODE: "throw" } },
			);
			assert.strictEqual(indeterminate.exitCode, 1);
			const indeterminateDir = workspace.runDir(
				ORCHESTRATOR_NAME,
				INDETERMINATE_RUN_ID,
			);
			assert.deepStrictEqual(readLifecycle(indeterminateDir), {
				lifecycle_status: "NONTERMINAL",
				terminal_kind: null,
			});

			const failed = await workspace.runEntrypoint(
				entrypoint,
				["--run-id", FAILED_RUN_ID],
				{ env: { MODE: "fail" } },
			);
			assert.strictEqual(failed.exitCode, 1);
			const failedDir = workspace.runDir(ORCHESTRATOR_NAME, FAILED_RUN_ID);
			assert.deepStrictEqual(readLifecycle(failedDir), {
				lifecycle_status: "TERMINAL",
				terminal_kind: "FAIL",
			});

			const oldTimestamp = new Date(Date.now() - DAY_MS);
			utimesSync(indeterminateDir, oldTimestamp, oldTimestamp);
			utimesSync(failedDir, oldTimestamp, oldTimestamp);
			const cleanup = await workspace.runEntrypoint(
				entrypoint,
				["--run-id", FAILURE_CLEANUP_RUN_ID],
				{ timeoutMs: 15_000 },
			);
			assert.strictEqual(cleanup.exitCode, 0);
			assert.strictEqual(existsSync(indeterminateDir), true);
			assert.strictEqual(existsSync(failedDir), false);
		} finally {
			workspace.cleanup();
		}
	});
});
