import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { nodeSqliteDriver } from "../../src/persistence/sqlite/node-sqlite-driver.js";
import { retireRunDirectoryInternal } from "../../src/services/run-retirement.js";
import { spawnNode } from "../helpers/node-subprocess.js";
import { cleanupTempDir, makeTempDir } from "../helpers/temp-run-dir.js";
import {
	ageDir,
	bootstrapForeignRun,
	expireLease,
	ORCHESTRATOR_NAME,
	RUN_B,
} from "./retention-namespace-race-scenario-setup.js";

describe("concurrent retention cleanups", () => {
	test("two concurrent cleanups: exactly one detaches, the second keeps", {
		timeout: 120_000,
	}, async () => {
		const root = makeTempDir();
		try {
			const runDirRoot = join(root, "runs");
			const runBDir = join(runDirRoot, ORCHESTRATOR_NAME, RUN_B);
			bootstrapForeignRun(runBDir, RUN_B);
			expireLease(runBDir);
			ageDir(runBDir, 100);
			const cleanupWorkerScript = join(
				import.meta.dirname,
				"fixtures",
				"retention-namespace-cleanup-worker.js",
			);
			const goBFile = join(root, "go-b");
			const resultBFile = join(root, "result-b.json");
			const workerB = spawnNode(cleanupWorkerScript, [], {
				env: {
					...process.env,
					TL_RUN_DIR: runBDir,
					TL_RUN_ID: RUN_B,
					TL_ORCH: ORCHESTRATOR_NAME,
					TL_GO_FILE: goBFile,
					TL_RESULT_FILE: resultBFile,
					TURNLOCK_TEST: "1",
				},
			});
			let bBlockedWhileAHeld = false;
			const barrierSab = new Int32Array(new SharedArrayBuffer(4));
			const outcome = retireRunDirectoryInternal(
				{
					driver: nodeSqliteDriver,
					runDir: runBDir,
					runId: RUN_B,
					retentionThresholdEpochMs: Date.now(),
				},
				{
					onFaultPoint: (point) => {
						if (point !== "AFTER_PRE_RENAME_VERIFICATION") return;
						writeFileSync(goBFile, "go");
						const blockedDeadline = Date.now() + 2500;
						while (Date.now() < blockedDeadline) {
							if (!existsSync(resultBFile)) {
								bBlockedWhileAHeld = true;
							} else {
								break;
							}
							Atomics.wait(barrierSab, 0, 0, 50);
						}
					},
				},
			);
			const resultDeadline = Date.now() + 30_000;
			while (!existsSync(resultBFile) && Date.now() < resultDeadline) {
				await new Promise((resolve) => setTimeout(resolve, 50));
			}
			const resultB = existsSync(resultBFile)
				? (JSON.parse(readFileSync(resultBFile, "utf8")) as {
						kind: string;
						reason?: string;
					})
				: null;
			try {
				workerB.kill("SIGKILL");
			} catch {
				// already exited
			}
			const exitB = await workerB.exited;
			console.error(
				`two-cleanup proof: cleanupA=${outcome.kind} cleanupB=${resultB?.kind}/${resultB?.reason ?? "?"} blockedWhileHeld=${bBlockedWhileAHeld} exitB=${exitB}`,
			);
			// A detached and deleted the OLD generation; B must not detach
			// anything a second time.
			assert.strictEqual(outcome.kind, "DELETED");
			assert.strictEqual(bBlockedWhileAHeld, true);
			assert.ok(
				resultB !== null && resultB.kind !== "DELETED",
				`cleanup B must keep, got ${JSON.stringify(resultB)}`,
			);
			assert.strictEqual(existsSync(runBDir), false);
		} finally {
			cleanupTempDir(root);
		}
	});
});
