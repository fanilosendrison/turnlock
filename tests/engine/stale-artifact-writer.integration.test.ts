import assert from "node:assert/strict";
import { existsSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
// Stale runtime filesystem writes — RED proof.
//
// A runtime whose lease expired and whose ownership was fenced by
// retention can still run code that performs artifact installation:
//
//   prepare artifact
//   installPreparedArtifact(ctx.runDir, ...)
//   commit state fenced afterwards
//
// `installPreparedArtifact()` creates parents with
// `mkdirSync(..., { recursive: true })`, so a stale process can either:
//   - recreate the canonical RUN_DIR pathname after the old incarnation
//     was detached (canonical absent), or
//   - install an artifact into a NEW incarnation that already occupies
//     the canonical pathname.
//
// Both are forbidden by the namespace authority: runtime artifact
// installation must be checked against ownership/lease/fence/retention
// BEFORE any filesystem I/O.
import { describe, test } from "node:test";
import { STATE_SCHEMA_VERSION } from "../../src/constants.js";
import type { DispatchContext } from "../../src/engine/context.js";
import { handleDone } from "../../src/engine/terminal-handlers.js";
import { AuthorityLostError } from "../../src/errors/concrete.js";
import { nodeSqliteDriver } from "../../src/persistence/sqlite/node-sqlite-driver.js";
import { bootstrapNewRunAtomic } from "../../src/persistence/sqlite/run-bootstrap.js";
import { openRunDatabase } from "../../src/persistence/sqlite/run-database.js";
import { claimRunForRetentionDeletion } from "../../src/persistence/sqlite/retention-claim.js";
import {
	installPreparedArtifact,
	prepareJsonArtifact,
} from "../../src/services/artifact-store.js";
import type { StateFile } from "../../src/services/state-io.js";
import type { OrchestratorConfig } from "../../src/types/config.js";
import { createMockLogger } from "../helpers/mock-logger.js";
import { cleanupTempDir, makeTempDir } from "../helpers/temp-run-dir.js";

const ORCHESTRATOR_NAME = "stale-writer-orch";
const RUN_B = "01HX000000000000000000000B";

interface WriterTestState {
	readonly stage: string;
}

function makeConfig(): OrchestratorConfig<WriterTestState> {
	return {
		name: ORCHESTRATOR_NAME,
		initial: "start",
		initialState: { stage: "fresh" },
		resumeCommand: (runId) => `node worker.mjs --run-id ${runId} --resume`,
		retentionDays: 7,
		phases: {
			start: async (_state, io) => io.done({ stage: "done" }),
		},
	};
}

/** Bootstrap a genuine Turnlock run database via the production primitive. */
function bootstrapForeignRun(
	runDir: string,
	runId: string,
): ReturnType<typeof bootstrapNewRunAtomic> {
	mkdirSync(runDir, { recursive: true });
	const dbPath = join(runDir, "turnlock.sqlite3");
	const runDb = openRunDatabase({
		driver: nodeSqliteDriver,
		dbPath,
		busyTimeoutMs: 2000,
	});
	const nowEpochMs = Date.now();
	const nowIso = new Date(nowEpochMs).toISOString();
	const result = bootstrapNewRunAtomic({
		db: runDb.connection,
		runId,
		orchestratorName: ORCHESTRATOR_NAME,
		nowEpochMs,
		nowIso,
		leaseDurationMs: 30 * 60 * 1000,
		initialState: {
			schemaVersion: STATE_SCHEMA_VERSION,
			runId,
			orchestratorName: ORCHESTRATOR_NAME,
			startedAt: nowIso,
			startedAtEpochMs: nowEpochMs,
			lastTransitionAt: nowIso,
			lastTransitionAtEpochMs: nowEpochMs,
			currentPhase: "start",
			phasesExecuted: 0,
			accumulatedDurationMs: 0,
			data: { stage: "active" },
			usedLabels: [],
		},
		stateSchemaVersion: STATE_SCHEMA_VERSION,
		contentionDeadlineMs: 5000,
	});
	runDb.close();
	assert.strictEqual(result.kind, "BOOTSTRAPPED");
	return result;
}

function expireAndFence(runDir: string): void {
	const dbPath = join(runDir, "turnlock.sqlite3");
	const runDb = openRunDatabase({
		driver: nodeSqliteDriver,
		dbPath,
		busyTimeoutMs: 2000,
	});
	runDb.connection.exec(
		`UPDATE run_ownership SET lease_until_epoch_ms = ${Date.now() - 1000} WHERE singleton = 1`,
	);
	runDb.close();
	const claim = claimRunForRetentionDeletion({
		driver: nodeSqliteDriver,
		dbPath,
		runId: RUN_B,
		busyTimeoutMs: 2000,
		contentionDeadlineMs: 5000,
	});
	assert.strictEqual(claim.kind, "CLAIMED");
}

describe("stale runtime filesystem writes", () => {
	test("stale artifact install must not recreate the absent canonical RUN_DIR (RED)", () => {
		const root = makeTempDir();
		try {
			const runDirRoot = join(root, "runs");
			const runBDir = join(runDirRoot, ORCHESTRATOR_NAME, RUN_B);
			bootstrapForeignRun(runBDir, RUN_B);
			expireAndFence(runBDir);
			// Cleanup detaches the old incarnation: canonical path absent.
			const asidePath = join(root, "aside");
			renameSync(runBDir, asidePath);
			assert.strictEqual(existsSync(runBDir), false);
			// The stale runtime performs a direct artifact installation at
			// the canonical pathname.
			const prepared = prepareJsonArtifact(runBDir, "terminal-output", {
				stage: "stale",
			});
			installPreparedArtifact(runBDir, prepared);
			// Desired: a stale runtime must never recreate the canonical
			// RUN_DIR through an indirect recursive mkdir.
			assert.strictEqual(
				existsSync(runBDir),
				false,
				"expected: canonical RUN_DIR remains absent; actual: stale runtime recreated it via recursive mkdir",
			);
		} finally {
			cleanupTempDir(root);
		}
	});

	test("stale runtime handleDone must not install artifacts into the NEW incarnation (RED)", async () => {
		const root = makeTempDir();
		try {
			const runDirRoot = join(root, "runs");
			const runBDir = join(runDirRoot, ORCHESTRATOR_NAME, RUN_B);
			// Old incarnation + handle kept by the stale runtime.
			const oldBoot = bootstrapForeignRun(runBDir, RUN_B);
			if (oldBoot.kind !== "BOOTSTRAPPED") throw new Error("setup");
			const staleHandle = oldBoot.handle;
			expireAndFence(runBDir);
			// Cleanup detaches the old incarnation.
			const asidePath = join(root, "aside");
			renameSync(runBDir, asidePath);
			assert.strictEqual(existsSync(runBDir), false);
			// A NEW incarnation bootstraps at the canonical pathname.
			const freshBoot = bootstrapForeignRun(runBDir, RUN_B);
			assert.strictEqual(freshBoot.kind, "BOOTSTRAPPED");
			// The stale runtime still holds a connection to its (moved)
			// OLD database and its fenced handle; its ctx.runDir is the
			// canonical pathname now owned by the NEW incarnation.
			const staleDb = openRunDatabase({
				driver: nodeSqliteDriver,
				dbPath: join(asidePath, "turnlock.sqlite3"),
				busyTimeoutMs: 2000,
			});
			const ctx: DispatchContext<WriterTestState> = {
				config: makeConfig(),
				runId: RUN_B,
				runDir: runBDir,
				runDb: staleDb,
				handle: staleHandle,
				logger: createMockLogger(),
				abortController: new AbortController(),
				currentPhase: "start",
				phasesExecuted: 0,
				accumulatedDurationMs: 0,
				stateRevision: oldBoot.committed.stateRevision,
			};
			const state: StateFile<WriterTestState> = {
				schemaVersion: STATE_SCHEMA_VERSION,
				runId: RUN_B,
				orchestratorName: ORCHESTRATOR_NAME,
				startedAt: String(oldBoot.committed.state.startedAt),
				startedAtEpochMs: Number(oldBoot.committed.state.startedAtEpochMs),
				lastTransitionAt: String(oldBoot.committed.state.lastTransitionAt),
				lastTransitionAtEpochMs: Number(
					oldBoot.committed.state.lastTransitionAtEpochMs,
				),
				currentPhase: "start",
				phasesExecuted: 0,
				accumulatedDurationMs: 0,
				data: { stage: "active" },
				usedLabels: [],
			};
			// The stale runtime attempts a done commit (its lease expired
			// and its handle was fenced by the retirement claim).
			let caught: unknown;
			try {
				await handleDone(
					ctx,
					state,
					{ kind: "done", output: { stage: "stale" } },
					10,
				);
			} catch (error) {
				caught = error;
			}
			// The stale handle must be rejected...
			assert.ok(
				caught instanceof AuthorityLostError ||
					caught instanceof Error,
				`expected a stale-handle rejection, got: ${String(caught)}`,
			);
			staleDb.close();
			// ...and the filesystem write must NOT have landed inside the
			// NEW incarnation.
			const prepared = prepareJsonArtifact(runBDir, "terminal-output", {
				stage: "stale",
			});
			assert.strictEqual(
				existsSync(join(runBDir, prepared.ref.relativePath)),
				false,
				"expected: NEW incarnation untouched by the stale writer; actual: stale runtime installed an artifact into the NEW incarnation",
			);
			// The NEW incarnation remains fully authoritative.
			assert.strictEqual(existsSync(join(runBDir, "turnlock.sqlite3")), true);
		} finally {
			cleanupTempDir(root);
		}
	});
});
