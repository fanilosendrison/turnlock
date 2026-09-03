import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
// Authority: ADR-0001 + docs/architecture/delegation-model.md — legacy
// manifest v2 compatibility (deterministic worker migration, never guessing
// host, fail-closed ambiguous re-emission).
import { describe, test } from "node:test";
import type { DelegationManifest } from "../../src/bindings/types.js";
import { nodeSqliteDriver } from "../../src/persistence/sqlite/node-sqlite-driver.js";
import type { ProtocolAction } from "../../src/services/protocol.js";
import {
	buildEntrypointSource,
	countProtocolBlocks,
	createE2EWorkspace,
	parseSingleProtocolBlock,
	readEvents,
	readJsonFile,
	readManifestFile,
	readStateFile,
	writeMalformedPromptResult,
	writePromptResult,
} from "../helpers/e2e-process.js";

function expectProtocol(stdout: string, action: ProtocolAction, runId: string) {
	assert.strictEqual(countProtocolBlocks(stdout), 1);
	const block = parseSingleProtocolBlock(stdout);
	assert.strictEqual(block.action, action);
	assert.strictEqual(block.runId, runId);
	return block;
}

const RUN_IDS = {
	migrateWorker: "01HX0000000000000000000101",
	ambiguousReemit: "01HX0000000000000000000102",
	safeResume: "01HX0000000000000000000103",
} as const;

function baseResumeCommandSource(): string {
	return '(runId) => "node " + import.meta.filename + " --run-id " + runId + " --resume"';
}
function entrypointSource(orchestratorName: string): string {
	return buildEntrypointSource(`
interface State { count: number }

await runOrchestrator<State>({
	name: ${JSON.stringify(orchestratorName)},
	initial: "ask",
	initialState: { count: 0 },
	resumeCommand: ${baseResumeCommandSource()},
	phases: {
		ask: definePhase<State>(async (_state, io) =>
			io.delegate(
				{
					kind: "prompt",
					target: { kind: "worker", name: "reviewer" },
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
`);
}
/**
 * Rewrite the stored delegation manifest (canonical projection AND the
 * immutable artifact blob referenced by SQLite) to a legacy v2 shape.
 * Updates the authoritative SQLite state so resume reads the legacy ref.
 */
function rewriteStoredManifestAsV2(
	runDir: string,
	label: string,
	options: { readonly worker: string | undefined },
): void {
	const statePath = join(runDir, "state.json");
	const state = readJsonFile<{
		pendingDelegation?: {
			manifestArtifact?: {
				digest: string;
				relativePath: string;
				sizeBytes: number;
			};
		};
	}>(statePath);
	const artifact = state.pendingDelegation?.manifestArtifact;
	if (artifact === undefined) {
		assert.fail("expected a manifestArtifact in the initial state");
	}
	const current = readJsonFile<Record<string, unknown>>(
		join(runDir, "delegations", `${label}-0.json`),
	);
	const legacy: Record<string, unknown> = {
		...current,
		manifestVersion: 2,
	};
	delete legacy.target;
	if (options.worker !== undefined) {
		legacy.worker = options.worker;
	}
	const bytes = Buffer.from(JSON.stringify(legacy), "utf-8");
	const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
	const hex = digest.slice(7);
	const relativePath = `artifacts/sha256/${hex.slice(0, 2)}/${hex.slice(2)}.json`;
	const newRef = {
		kind: "delegation-manifest",
		digestAlgorithm: "sha256",
		digest,
		relativePath,
		mediaType: "application/json",
		sizeBytes: bytes.length,
	};
	// Immutable blob + canonical projection.
	mkdirSync(join(runDir, "artifacts", "sha256", hex.slice(0, 2)), {
		recursive: true,
	});
	writeFileSync(join(runDir, relativePath), bytes);
	writeFileSync(
		join(runDir, "delegations", `${label}-0.json`),
		JSON.stringify(legacy, null, "\t"),
	);
	// Authoritative SQLite state.
	const dbPath = join(runDir, "turnlock.sqlite3");
	const db = nodeSqliteDriver.open(dbPath);
	try {
		const row = db
			.prepare("SELECT state_json FROM run_state WHERE singleton = 1")
			.get() as { state_json: string } | null;
		if (row === null) assert.fail("expected run_state row");
		const parsed = JSON.parse(row.state_json) as Record<string, unknown>;
		const pending = parsed.pendingDelegation as Record<string, unknown>;
		pending.manifestArtifact = newRef;
		const newJson = JSON.stringify(parsed);
		const newDigest = `sha256:${createHash("sha256").update(newJson).digest("hex")}`;
		db.prepare(
			"UPDATE run_state SET state_json = ?, state_digest = ? WHERE singleton = 1",
		).run(newJson, newDigest);
	} finally {
		db.close();
	}
	// The projection is regenerated from SQLite on resume; drop the stale copy.
	rmSync(statePath, { force: true });
}
describe("legacy manifest v2 delegation-target compatibility (ADR-0001)", () => {
	test("v2 manifest with worker migrates deterministically on retry", async () => {
		const workspace = createE2EWorkspace();
		const entrypoint = workspace.writeEntrypoint(
			"legacy-v2-worker.ts",
			entrypointSource("e2e-legacy-v2-worker"),
		);
		try {
			const initial = await workspace.runEntrypoint(entrypoint, [
				"--run-id",
				RUN_IDS.migrateWorker,
			]);
			assert.strictEqual(initial.exitCode, 0);
			const initialBlock = expectProtocol(
				initial.stdout,
				"DELEGATE",
				RUN_IDS.migrateWorker,
			);
			const runDir = workspace.runDir(
				"e2e-legacy-v2-worker",
				RUN_IDS.migrateWorker,
			);
			const initialManifest = readManifestFile(
				String(initialBlock.fields.manifest),
			);
			assert.deepStrictEqual(initialManifest.target, {
				kind: "worker",
				name: "reviewer",
			});
			rewriteStoredManifestAsV2(runDir, "retryable", { worker: "reviewer" });
			writeMalformedPromptResult(runDir, "retryable", 0, "{not-json");
			const retry = await workspace.runEntrypoint(entrypoint, [
				"--resume",
				"--run-id",
				RUN_IDS.migrateWorker,
			]);
			assert.strictEqual(retry.exitCode, 0);
			const retryBlock = expectProtocol(
				retry.stdout,
				"DELEGATE",
				RUN_IDS.migrateWorker,
			);
			const retryManifest = readManifestFile(
				String(retryBlock.fields.manifest),
			) as DelegationManifest;
			assert.strictEqual(retryManifest.attempt, 1);
			assert.strictEqual(retryManifest.manifestVersion, 3);
			assert.deepStrictEqual(retryManifest.target, {
				kind: "worker",
				name: "reviewer",
			});
			assert.strictEqual("worker" in Object(retryManifest), false);
			assert.strictEqual(
				existsSync(join(runDir, "delegations", "retryable-1.json")),
				true,
			);
			const emits = readEvents(runDir).filter(
				(e) => e.eventType === "delegation_emit",
			);
			assert.strictEqual(emits.length, 2);
			const emit1 = emits[1];
			if (emit1 === undefined || emit1.eventType !== "delegation_emit") {
				assert.fail("expected retry delegation_emit");
			}
			assert.strictEqual(emit1.attempt, 1);
			assert.deepStrictEqual(emit1.target, {
				kind: "worker",
				name: "reviewer",
			});
		} finally {
			workspace.cleanup();
		}
	});
	test("v2 manifest without worker fails closed when re-emission is required", async () => {
		const workspace = createE2EWorkspace();
		const entrypoint = workspace.writeEntrypoint(
			"legacy-v2-ambiguous.ts",
			entrypointSource("e2e-legacy-v2-ambiguous"),
		);
		try {
			const initial = await workspace.runEntrypoint(entrypoint, [
				"--run-id",
				RUN_IDS.ambiguousReemit,
			]);
			assert.strictEqual(initial.exitCode, 0);
			const runDir = workspace.runDir(
				"e2e-legacy-v2-ambiguous",
				RUN_IDS.ambiguousReemit,
			);
			rewriteStoredManifestAsV2(runDir, "retryable", {
				worker: undefined,
			});
			writeMalformedPromptResult(runDir, "retryable", 0, "{not-json");
			const resumed = await workspace.runEntrypoint(entrypoint, [
				"--resume",
				"--run-id",
				RUN_IDS.ambiguousReemit,
			]);
			assert.strictEqual(resumed.exitCode, 1);
			const block = parseSingleProtocolBlock(resumed.stdout);
			assert.strictEqual(block.action, "ERROR");
			assert.strictEqual(
				block.fields.errorKind,
				"ambiguous_legacy_delegation_target",
			);
			assert.ok(
				String(block.fields.message).includes("manifest v2 without a worker"),
			);
			// No replacement attempt may exist — the target was never guessed.
			assert.strictEqual(
				existsSync(join(runDir, "delegations", "retryable-1.json")),
				false,
			);
			const emits = readEvents(runDir).filter(
				(e) => e.eventType === "delegation_emit",
			);
			assert.strictEqual(emits.length, 1);
		} finally {
			workspace.cleanup();
		}
	});
	test("v2 manifest without worker still resumes safely when results already exist", async () => {
		const workspace = createE2EWorkspace();
		const entrypoint = workspace.writeEntrypoint(
			"legacy-v2-safe-resume.ts",
			entrypointSource("e2e-legacy-v2-safe-resume"),
		);
		try {
			const initial = await workspace.runEntrypoint(entrypoint, [
				"--run-id",
				RUN_IDS.safeResume,
			]);
			assert.strictEqual(initial.exitCode, 0);
			const runDir = workspace.runDir(
				"e2e-legacy-v2-safe-resume",
				RUN_IDS.safeResume,
			);
			rewriteStoredManifestAsV2(runDir, "retryable", {
				worker: undefined,
			});
			writePromptResult(runDir, "retryable", 0, { verdict: "clean" });
			const resumed = await workspace.runEntrypoint(entrypoint, [
				"--resume",
				"--run-id",
				RUN_IDS.safeResume,
			]);
			assert.strictEqual(resumed.exitCode, 0);
			const done = expectProtocol(resumed.stdout, "DONE", RUN_IDS.safeResume);
			assert.deepStrictEqual(
				readJsonFile<{ verdict: string }>(done.fields.output as string),
				{ verdict: "clean" },
			);
			const state = readStateFile<{ count: number }>(runDir);
			assert.strictEqual("pendingDelegation" in state, false);
			assert.strictEqual(state.phasesExecuted, 2);
		} finally {
			workspace.cleanup();
		}
	});
});
