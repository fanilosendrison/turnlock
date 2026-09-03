import assert from "node:assert/strict";
// Authority: ADR-0001 + docs/architecture/delegation-model.md — the logical
// target is immutable across retry attempts; only attempt-specific fields
// may change.
import { describe, test } from "node:test";
import type { DelegationManifest } from "../../src/bindings/types.js";
import { reconstructManifest } from "../../src/engine/shared.js";

const RUN_DIR = "/tmp/.turnlock/runs/orch/01HX";
function makePromptManifest(): DelegationManifest {
	return {
		manifestVersion: 3,
		runId: "01HX0000000000000000000001",
		orchestratorName: "orch",
		phase: "a",
		resumeAt: "b",
		label: "rev",
		kind: "prompt",
		emittedAt: "2026-04-19T12:00:00.000Z",
		emittedAtEpochMs: 1745062800000,
		timeoutMs: 600000,
		deadlineAtEpochMs: 1745063400000,
		attempt: 0,
		maxAttempts: 3,
		target: { kind: "worker", name: "reviewer" },
		prompt: "inspect",
		resultPath: `${RUN_DIR}/results/rev-0.json`,
	};
}
function makeBatchManifest(): DelegationManifest {
	return {
		manifestVersion: 3,
		runId: "01HX0000000000000000000001",
		orchestratorName: "orch",
		phase: "a",
		resumeAt: "b",
		label: "fanout",
		kind: "batch",
		emittedAt: "2026-04-19T12:00:00.000Z",
		emittedAtEpochMs: 1745062800000,
		timeoutMs: 600000,
		deadlineAtEpochMs: 1745063400000,
		attempt: 0,
		maxAttempts: 3,
		target: { kind: "host" },
		jobs: [
			{
				id: "j1",
				prompt: "p1",
				resultPath: `${RUN_DIR}/results/fanout-0/j1.json`,
			},
			{
				id: "j2",
				prompt: "p2",
				resultPath: `${RUN_DIR}/results/fanout-0/j2.json`,
			},
		],
	};
}
function updates(attempt: number) {
	return {
		attempt,
		emittedAt: `2026-04-19T12:0${attempt}:00.000Z`,
		emittedAtEpochMs: 1745062800000 + attempt * 1000,
		deadlineAtEpochMs: 1745063400000 + attempt * 1000,
		label: "rev",
		runDir: RUN_DIR,
	};
}
describe("reconstructManifest preserves the logical target across retries", () => {
	test("worker target survives prompt retry unchanged", () => {
		const old = makePromptManifest();
		const next = reconstructManifest(old, {
			...updates(1),
			label: old.label,
			target: old.target,
		});
		assert.deepStrictEqual(next.target, { kind: "worker", name: "reviewer" });
	});
	test("worker name survives two consecutive retries unchanged", () => {
		const old = makePromptManifest();
		const attempt1 = reconstructManifest(old, {
			...updates(1),
			label: old.label,
			target: old.target,
		});
		const attempt2 = reconstructManifest(attempt1, {
			...updates(2),
			label: old.label,
			target: old.target,
		});
		assert.deepStrictEqual(attempt2.target, {
			kind: "worker",
			name: "reviewer",
		});
	});
	test("host target survives batch retry unchanged", () => {
		const old = makeBatchManifest();
		const next = reconstructManifest(old, {
			...updates(1),
			label: old.label,
			target: old.target,
		});
		assert.deepStrictEqual(next.target, { kind: "host" });
	});
	test("retry changes only attempt-specific fields (prompt)", () => {
		const old = makePromptManifest();
		const next = reconstructManifest(old, {
			...updates(1),
			label: old.label,
			target: old.target,
		});
		assert.strictEqual(next.attempt, 1);
		assert.strictEqual(next.emittedAt, "2026-04-19T12:01:00.000Z");
		assert.strictEqual(next.emittedAtEpochMs, 1745062801000);
		assert.strictEqual(next.deadlineAtEpochMs, 1745063401000);
		assert.strictEqual(next.resultPath, `${RUN_DIR}/results/rev-1.json`);
		// Everything else must be byte-identical.
		assert.strictEqual(next.manifestVersion, old.manifestVersion);
		assert.strictEqual(next.runId, old.runId);
		assert.strictEqual(next.orchestratorName, old.orchestratorName);
		assert.strictEqual(next.phase, old.phase);
		assert.strictEqual(next.resumeAt, old.resumeAt);
		assert.strictEqual(next.label, old.label);
		assert.strictEqual(next.kind, old.kind);
		assert.strictEqual(next.timeoutMs, old.timeoutMs);
		assert.strictEqual(next.maxAttempts, old.maxAttempts);
		assert.strictEqual(next.prompt, old.prompt);
		assert.deepStrictEqual(next.target, old.target);
	});
	test("retry changes only attempt-specific fields (batch)", () => {
		const old = makeBatchManifest();
		const next = reconstructManifest(old, {
			...updates(2),
			label: old.label,
			target: old.target,
		});
		assert.strictEqual(next.attempt, 2);
		assert.strictEqual(
			next.jobs?.[0]?.resultPath,
			`${RUN_DIR}/results/fanout-2/j1.json`,
		);
		assert.strictEqual(
			next.jobs?.[1]?.resultPath,
			`${RUN_DIR}/results/fanout-2/j2.json`,
		);
		assert.strictEqual(next.jobs?.[0]?.prompt, old.jobs?.[0]?.prompt);
		assert.strictEqual(next.jobs?.[1]?.id, old.jobs?.[1]?.id);
		assert.deepStrictEqual(next.target, old.target);
		assert.strictEqual(next.manifestVersion, 3);
	});
	test("a legacy v2 source manifest with worker field migrates to canonical v3", () => {
		const legacy = {
			...makePromptManifest(),
			manifestVersion: 2,
			worker: "legacy-reviewer",
			target: undefined,
		} as unknown as DelegationManifest & { readonly worker?: string };
		const next = reconstructManifest(legacy, {
			...updates(1),
			label: "rev",
			target: { kind: "worker", name: "legacy-reviewer" },
		});
		assert.strictEqual(next.manifestVersion, 3);
		assert.deepStrictEqual(next.target, {
			kind: "worker",
			name: "legacy-reviewer",
		});
		assert.strictEqual("worker" in Object(next), false);
	});
	test("reconstructed manifest never derives destination from absence", () => {
		const old = makePromptManifest();
		const next = reconstructManifest(old, {
			...updates(3),
			label: old.label,
			target: old.target,
		});
		assert.notStrictEqual(next.target, undefined);
		assert.deepStrictEqual(next.target, { kind: "worker", name: "reviewer" });
	});
});
