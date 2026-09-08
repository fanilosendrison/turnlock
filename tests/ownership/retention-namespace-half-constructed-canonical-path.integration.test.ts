import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { runOrchestratorInternal } from "../../src/engine/run-orchestrator.js";
import type { OrchestratorConfig } from "../../src/types/config.js";
import { spawnNode } from "../helpers/node-subprocess.js";
import { cleanupTempDir, makeTempDir } from "../helpers/temp-run-dir.js";
import {
	ORCHESTRATOR_NAME,
	RUN_B,
} from "./retention-namespace-race-scenario-setup.js";

describe("half-constructed canonical path retention race", () => {
	test("retentionDays=0 cleanup cannot detach a half-constructed canonical path (initial survives)", {
		timeout: 120_000,
	}, async () => {
		const root = makeTempDir();
		try {
			const runDirRoot = join(root, "runs");
			const runBDir = join(runDirRoot, ORCHESTRATOR_NAME, RUN_B);
			const goFile = join(root, "go");
			const resultFile = join(root, "result.json");
			const cleanupWorkerScript = join(
				import.meta.dirname,
				"fixtures",
				"retention-namespace-cleanup-worker.js",
			);
			const worker = spawnNode(cleanupWorkerScript, [], {
				env: {
					...process.env,
					TL_RUN_DIR: runBDir,
					TL_RUN_ID: RUN_B,
					TL_ORCH: ORCHESTRATOR_NAME,
					TL_GO_FILE: goFile,
					TL_RESULT_FILE: resultFile,
					TURNLOCK_TEST: "1",
				},
			});
			// The initial phase parks until the test resolves it — the
			// ownership stays HELD/live while the cleanup contender runs.
			const phaseGateHandle: { release(): void } = { release: () => {} };
			const phaseGate = new Promise<void>((resolve) => {
				phaseGateHandle.release = resolve;
			});
			const config: OrchestratorConfig<{ stage: string }> = {
				name: ORCHESTRATOR_NAME,
				initial: "start",
				initialState: { stage: "fresh" },
				resumeCommand: (runId) => `node worker.mjs --run-id ${runId} --resume`,
				retentionDays: 7,
				runDirRoot,
				phases: {
					start: async (_state, io) => {
						await phaseGate;
						return io.done({ stage: "done" });
					},
				},
			};
			let cleanupBlockedWhileInitialHeld = false;
			const barrierSab = new Int32Array(new SharedArrayBuffer(4));
			const initialPromise = runOrchestratorInternal(
				config,
				{ resume: false, runId: RUN_B, rest: [] },
				{
					hooks: {
						beforeRunBootstrapCommit: () => {
							// Namespace mutex held here — the initial owns the
							// half-constructed canonical path.
							writeFileSync(goFile, "go");
							const blockedDeadline = Date.now() + 2500;
							while (Date.now() < blockedDeadline) {
								if (!existsSync(resultFile)) {
									cleanupBlockedWhileInitialHeld = true;
								} else {
									break;
								}
								Atomics.wait(barrierSab, 0, 0, 50);
							}
						},
					},
				},
			);
			// The cleanup contender must finish BEFORE the phase is released:
			// its claim sees the live HELD ownership.
			const resultDeadline = Date.now() + 30_000;
			while (!existsSync(resultFile) && Date.now() < resultDeadline) {
				await new Promise((resolve) => setTimeout(resolve, 50));
			}
			const cleanupResult = existsSync(resultFile)
				? (JSON.parse(readFileSync(resultFile, "utf8")) as {
						kind: string;
						reason?: string;
					})
				: null;
			// Release the parked phase — the initial completes normally.
			phaseGateHandle.release();
			let initialError: unknown = null;
			try {
				await initialPromise;
			} catch (error) {
				initialError = error;
			}
			try {
				worker.kill("SIGKILL");
			} catch {
				// already exited
			}
			const exitCode = await worker.exited;
			console.error(
				`retentionDays=0 proof: cleanup=${cleanupResult?.kind}/${cleanupResult?.reason ?? "?"} blockedWhileHeld=${cleanupBlockedWhileInitialHeld} initialError=${initialError instanceof Error ? initialError.message : String(initialError)} exit=${exitCode}`,
			);
			// The cleanup was blocked while the initial held the mutex, then
			// observed the live owner and kept the run.
			assert.strictEqual(cleanupBlockedWhileInitialHeld, true);
			assert.strictEqual(cleanupResult?.kind, "KEPT");
			assert.strictEqual(cleanupResult?.reason, "LIVE_OWNER");
			// The initial completed successfully (TestExitSignal is the
			// normal in-test completion path).
			assert.ok(
				initialError === null ||
					(initialError as { __turnlockExit?: boolean })?.__turnlockExit ===
						true,
				`initial must complete, got ${String(initialError)}`,
			);
			assert.strictEqual(existsSync(runBDir), true);
			assert.strictEqual(existsSync(join(runBDir, "turnlock.sqlite3")), true);
		} finally {
			cleanupTempDir(root);
		}
	});
});
