import assert from "node:assert/strict";
import { existsSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { nodeSqliteDriver } from "../../src/persistence/sqlite/node-sqlite-driver.js";
import type { StateFile } from "../../src/services/state-io.js";
import {
	buildEntrypointSource,
	createE2EWorkspace,
	parseSingleProtocolBlock,
	readEvents,
	readJsonFile,
	waitForPath,
} from "../helpers/e2e-process.js";

const ORCHESTRATOR_NAME = "e2e-distinct-run-concurrency";
const RUN_IDS = [
	"01HX0000000000000000000021",
	"01HX0000000000000000000022",
	"01HX0000000000000000000023",
	"01HX0000000000000000000024",
] as const;
const CLEANUP_RUN_ID = "01HX0000000000000000000025";
const DAY_MS = 24 * 60 * 60 * 1000;

interface MarkerState {
	readonly marker: string;
}

interface AuthoritySnapshot {
	readonly runId: string;
	readonly incarnationId: string;
	readonly orchestratorName: string;
	readonly ownershipStatus: string;
	readonly retentionStatus: string;
	readonly lifecycleStatus: string;
	readonly terminalKind: string | null;
	readonly state: StateFile<MarkerState>;
}

function readAuthority(runDir: string): AuthoritySnapshot {
	const database = nodeSqliteDriver.openReadOnly(
		join(runDir, "turnlock.sqlite3"),
	);
	try {
		const incarnation = database
			.prepare(
				"SELECT run_id, incarnation_id, orchestrator_name FROM run_incarnation WHERE singleton = 1",
			)
			.get<{
				readonly run_id: string;
				readonly incarnation_id: string;
				readonly orchestrator_name: string;
			}>();
		const ownership = database
			.prepare(
				"SELECT ownership_status FROM run_ownership WHERE singleton = 1",
			)
			.get<{ readonly ownership_status: string }>();
		const retention = database
			.prepare(
				"SELECT retention_status FROM run_retention WHERE singleton = 1",
			)
			.get<{ readonly retention_status: string }>();
		const lifecycle = database
			.prepare(
				"SELECT lifecycle_status, terminal_kind FROM run_workflow_lifecycle WHERE singleton = 1",
			)
			.get<{
				readonly lifecycle_status: string;
				readonly terminal_kind: string | null;
			}>();
		const stateRow = database
			.prepare("SELECT state_json FROM run_state WHERE singleton = 1")
			.get<{ readonly state_json: string }>();

		assert.ok(incarnation !== undefined);
		assert.ok(ownership !== undefined);
		assert.ok(retention !== undefined);
		assert.ok(lifecycle !== undefined);
		assert.ok(stateRow !== undefined);

		return {
			runId: incarnation.run_id,
			incarnationId: incarnation.incarnation_id,
			orchestratorName: incarnation.orchestrator_name,
			ownershipStatus: ownership.ownership_status,
			retentionStatus: retention.retention_status,
			lifecycleStatus: lifecycle.lifecycle_status,
			terminalKind: lifecycle.terminal_kind,
			state: JSON.parse(stateRow.state_json) as StateFile<MarkerState>,
		};
	} finally {
		database.close();
	}
}

describe("process E2E distinct-run concurrency", () => {
	test(
		"distinct run IDs execute concurrently without cross-run interference",
		{ timeout: 30_000 },
		async () => {
			const workspace = createE2EWorkspace("turnlock-distinct-runs-");
			const entrypoint = workspace.writeEntrypoint(
				"distinct-run-concurrency.ts",
				buildEntrypointSource(`
interface State { marker: string }

const marker = process.env.RUN_MARKER;
if (marker === undefined) throw new Error("RUN_MARKER is required");

await runOrchestrator<State>({
	name: ${JSON.stringify(ORCHESTRATOR_NAME)},
	initial: "hold",
	initialState: { marker },
	retentionDays: 0,
	resumeCommand: (runId) =>
		"node distinct-run-concurrency.ts --run-id " + runId + " --resume",
	phases: {
		hold: definePhase<State>(async (state, io) => {
			await writeFile(io.runDir + "/phase-started", state.marker);
			if (process.env.MODE !== "cleanup") {
				for (;;) {
					try {
						await readFile(io.runDir + "/release", "utf8");
						break;
					} catch {
						await new Promise((resolve) => setTimeout(resolve, 10));
					}
				}
			}
			return io.done({ marker: state.marker, runDir: io.runDir });
		}),
	},
});
`),
			);
			const runs = RUN_IDS.map((runId, index) => ({
				runId,
				marker: `marker-${index + 1}`,
				runDir: workspace.runDir(ORCHESTRATOR_NAME, runId),
				process: workspace.spawnEntrypoint(
					entrypoint,
					["--run-id", runId],
					{ env: { RUN_MARKER: `marker-${index + 1}` } },
				),
			}));
			let workersFinished = false;

			try {
				await Promise.all(
					runs.map((run) =>
						waitForPath(join(run.runDir, "phase-started"), 5_000),
					),
				);

				assert.strictEqual(
					new Set(runs.map((run) => run.runDir)).size,
					runs.length,
				);

				const activeIncarnations = new Set<string>();
				for (const run of runs) {
					const authority = readAuthority(run.runDir);
					assert.strictEqual(authority.runId, run.runId);
					assert.strictEqual(authority.orchestratorName, ORCHESTRATOR_NAME);
					assert.strictEqual(authority.ownershipStatus, "HELD");
					assert.strictEqual(authority.retentionStatus, "ACTIVE");
					assert.strictEqual(authority.lifecycleStatus, "NONTERMINAL");
					assert.strictEqual(authority.terminalKind, null);
					assert.strictEqual(authority.state.runId, run.runId);
					assert.deepStrictEqual(authority.state.data, {
						marker: run.marker,
					});
					activeIncarnations.add(authority.incarnationId);
				}
				assert.strictEqual(activeIncarnations.size, runs.length);

				const oldTimestamp = new Date(Date.now() - DAY_MS);
				for (const run of runs) {
					utimesSync(run.runDir, oldTimestamp, oldTimestamp);
				}

				const cleanup = await workspace.runEntrypoint(
					entrypoint,
					["--run-id", CLEANUP_RUN_ID],
					{
						env: { MODE: "cleanup", RUN_MARKER: "cleanup-trigger" },
						timeoutMs: 10_000,
					},
				);
				assert.strictEqual(cleanup.exitCode, 0);
				const cleanupBlock = parseSingleProtocolBlock(cleanup.stdout);
				assert.strictEqual(cleanupBlock.action, "DONE");
				assert.strictEqual(cleanupBlock.runId, CLEANUP_RUN_ID);

				for (const run of runs) {
					assert.strictEqual(existsSync(run.runDir), true);
					assert.strictEqual(
						existsSync(join(run.runDir, "turnlock.sqlite3")),
						true,
					);
					const authority = readAuthority(run.runDir);
					assert.strictEqual(authority.ownershipStatus, "HELD");
					assert.strictEqual(authority.retentionStatus, "ACTIVE");
					assert.strictEqual(authority.runId, run.runId);
					assert.deepStrictEqual(authority.state.data, {
						marker: run.marker,
					});
				}

				for (const run of runs) {
					writeFileSync(join(run.runDir, "release"), "go", "utf8");
				}
				const results = await Promise.all(
					runs.map((run) => run.process.wait(10_000)),
				);
				workersFinished = true;

				const completedIncarnations = new Set<string>();
				for (const [index, run] of runs.entries()) {
					const result = results[index];
					assert.ok(result !== undefined);
					assert.strictEqual(result.exitCode, 0);
					assert.ok(!result.stdout.includes("run_locked"));
					const block = parseSingleProtocolBlock(result.stdout);
					assert.strictEqual(block.action, "DONE");
					assert.strictEqual(block.runId, run.runId);
					assert.strictEqual(
						block.fields.output,
						join(run.runDir, "output.json"),
					);

					const output = readJsonFile<{
						readonly marker: string;
						readonly runDir: string;
					}>(join(run.runDir, "output.json"));
					assert.deepStrictEqual(output, {
						marker: run.marker,
						runDir: run.runDir,
					});

					const authority = readAuthority(run.runDir);
					assert.strictEqual(authority.runId, run.runId);
					assert.strictEqual(authority.orchestratorName, ORCHESTRATOR_NAME);
					assert.strictEqual(authority.ownershipStatus, "FREE");
					assert.strictEqual(authority.retentionStatus, "ACTIVE");
					assert.strictEqual(authority.lifecycleStatus, "TERMINAL");
					assert.strictEqual(authority.terminalKind, "DONE");
					assert.strictEqual(authority.state.runId, run.runId);
					assert.deepStrictEqual(authority.state.data, {
						marker: run.marker,
					});
					completedIncarnations.add(authority.incarnationId);

					for (const other of runs) {
						if (other.runId === run.runId) continue;
						assert.ok(!JSON.stringify(authority.state).includes(other.runId));
						assert.ok(!JSON.stringify(authority.state).includes(other.marker));
						assert.ok(!JSON.stringify(output).includes(other.runId));
						assert.ok(!JSON.stringify(output).includes(other.marker));
					}

					const events = readEvents(run.runDir);
					assert.deepStrictEqual(
						events.map((event) => event.eventType),
						[
							"orchestrator_start",
							"phase_start",
							"phase_end",
							"orchestrator_end",
						],
					);
					assert.ok(events.every((event) => event.runId === run.runId));
				}
				assert.strictEqual(completedIncarnations.size, runs.length);
			} finally {
				if (!workersFinished) {
					for (const run of runs) {
						run.process.signal("SIGKILL");
					}
					await Promise.all(
						runs.map((run) =>
							run.process.wait(1_000).catch(() => undefined),
						),
					);
				}
				workspace.cleanup();
			}
		},
	);
});
