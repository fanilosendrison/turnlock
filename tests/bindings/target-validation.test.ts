import assert from "node:assert/strict";
// Authority: ADR-0001 + docs/architecture/delegation-model.md (fail-closed
// target validation and legacy manifest v2 compatibility).
import { describe, test } from "node:test";
import {
	assertValidDelegationTarget,
	resolveManifestTarget,
	WORKER_NAME_PATTERN,
} from "../../src/bindings/target.js";
import {
	AmbiguousLegacyDelegationTargetError,
	InvalidConfigError,
	ProtocolError,
} from "../../src/errors/concrete.js";
import { loadJsonFixture } from "../helpers/fixture-loader.js";

describe("manifest fixtures reflect the target contract", () => {
	test("v3 fixtures carry explicit targets", () => {
		const prompt = loadJsonFixture<{
			manifestVersion: number;
			target: unknown;
			worker?: string;
		}>("manifests/agent-attempt-0.json");
		assert.strictEqual(prompt.manifestVersion, 3);
		assert.deepStrictEqual(prompt.target, {
			kind: "worker",
			name: "reviewer",
		});
		assert.strictEqual("worker" in Object(prompt), false);
		const batch = loadJsonFixture<{
			manifestVersion: number;
			target: unknown;
		}>("manifests/agent-batch-3jobs.json");
		assert.strictEqual(batch.manifestVersion, 3);
		assert.deepStrictEqual(batch.target, { kind: "worker", name: "reviewer" });
	});
	test("legacy v2 fixture with worker resolves deterministically", () => {
		const raw = loadJsonFixture<Record<string, unknown>>(
			"manifests/legacy-v2-worker.json",
		);
		assert.strictEqual(raw.manifestVersion, 2);
		const target = resolveManifestTarget(raw, "rev", CONTEXT);
		assert.deepStrictEqual(target, { kind: "worker", name: "reviewer" });
	});
	test("legacy v2 fixture without worker fails closed", () => {
		const raw = loadJsonFixture<Record<string, unknown>>(
			"manifests/legacy-v2-no-worker.json",
		);
		assert.strictEqual(raw.manifestVersion, 2);
		assert.throws(
			() => resolveManifestTarget(raw, "rev", CONTEXT),
			AmbiguousLegacyDelegationTargetError,
		);
	});
	test("legacy v2 batch fixture with worker resolves deterministically", () => {
		const raw = loadJsonFixture<Record<string, unknown>>(
			"manifests/legacy-v2-batch-worker.json",
		);
		const target = resolveManifestTarget(raw, "batch", CONTEXT);
		assert.deepStrictEqual(target, { kind: "worker", name: "reviewer" });
	});
	test("legacy v2 batch fixture without worker fails closed", () => {
		const raw = loadJsonFixture<Record<string, unknown>>(
			"manifests/legacy-v2-batch-no-worker.json",
		);
		assert.throws(
			() => resolveManifestTarget(raw, "batch", CONTEXT),
			AmbiguousLegacyDelegationTargetError,
		);
	});
});
const CONTEXT = {
	runId: "01HX0000000000000000000001",
	orchestratorName: "orch",
	phase: "a",
} as const;
describe("assertValidDelegationTarget (fail-closed)", () => {
	test("accepts host target", () => {
		const value = { kind: "host" };
		assertValidDelegationTarget(value, "l1");
		assert.deepStrictEqual(value, { kind: "host" });
	});
	test("accepts worker target with valid name", () => {
		const value = { kind: "worker", name: "reviewer" };
		assertValidDelegationTarget(value, "l1");
		assert.deepStrictEqual(value, { kind: "worker", name: "reviewer" });
	});
	test("accepts multi-segment worker name", () => {
		assertValidDelegationTarget(
			{ kind: "worker", name: "git-commit-generator" },
			"l1",
		);
	});
	test("rejects empty worker name", () => {
		assert.throws(
			() => assertValidDelegationTarget({ kind: "worker", name: "" }, "l1"),
			InvalidConfigError,
		);
	});
	test("rejects missing worker name", () => {
		assert.throws(
			() => assertValidDelegationTarget({ kind: "worker" }, "l1"),
			InvalidConfigError,
		);
	});
	test("rejects non-string worker name", () => {
		assert.throws(
			() => assertValidDelegationTarget({ kind: "worker", name: 42 }, "l1"),
			InvalidConfigError,
		);
	});
	test("rejects worker name with invalid characters", () => {
		assert.throws(
			() =>
				assertValidDelegationTarget(
					{ kind: "worker", name: "Reviewer!" },
					"l1",
				),
			InvalidConfigError,
		);
	});
	test("rejects worker name starting with a digit", () => {
		assert.throws(
			() =>
				assertValidDelegationTarget(
					{ kind: "worker", name: "1reviewer" },
					"l1",
				),
			InvalidConfigError,
		);
	});
	test("rejects overlong worker name", () => {
		assert.throws(
			() =>
				assertValidDelegationTarget(
					{ kind: "worker", name: `a${"b".repeat(200)}` },
					"l1",
				),
			InvalidConfigError,
		);
	});
	test("rejects unknown target kind", () => {
		assert.throws(
			() => assertValidDelegationTarget({ kind: "unknown" }, "l1"),
			InvalidConfigError,
		);
	});
	test("rejects host target carrying a name", () => {
		assert.throws(
			() => assertValidDelegationTarget({ kind: "host", name: "x" }, "l1"),
			InvalidConfigError,
		);
	});
	test("rejects worker target carrying extra fields", () => {
		assert.throws(
			() =>
				assertValidDelegationTarget(
					{ kind: "worker", name: "reviewer", model: "gpt" },
					"l1",
				),
			InvalidConfigError,
		);
	});
	test("rejects null / primitives / arrays", () => {
		for (const value of [null, undefined, "host", 42, ["host"], true]) {
			assert.throws(
				() => assertValidDelegationTarget(value, "l1"),
				InvalidConfigError,
			);
		}
	});
	test("worker name pattern accepts label-shaped names only", () => {
		assert.strictEqual(WORKER_NAME_PATTERN.test("reviewer"), true);
		assert.strictEqual(WORKER_NAME_PATTERN.test("git-commit-generator"), true);
		assert.strictEqual(WORKER_NAME_PATTERN.test(""), false);
		assert.strictEqual(WORKER_NAME_PATTERN.test("UPPER"), false);
		assert.strictEqual(WORKER_NAME_PATTERN.test("with_underscore"), false);
		assert.strictEqual(WORKER_NAME_PATTERN.test("with space"), false);
	});
});
describe("resolveManifestTarget (re-emission compatibility)", () => {
	test("v3 manifest target is validated and returned", () => {
		const target = resolveManifestTarget(
			{
				manifestVersion: 3,
				target: { kind: "worker", name: "reviewer" },
			},
			"l1",
			CONTEXT,
		);
		assert.deepStrictEqual(target, { kind: "worker", name: "reviewer" });
	});
	test("v3 host target is validated and returned", () => {
		const target = resolveManifestTarget(
			{ manifestVersion: 3, target: { kind: "host" } },
			"l1",
			CONTEXT,
		);
		assert.deepStrictEqual(target, { kind: "host" });
	});
	test("v3 manifest without target fails closed", () => {
		assert.throws(
			() => resolveManifestTarget({ manifestVersion: 3 }, "l1", CONTEXT),
			InvalidConfigError,
		);
	});
	test("v3 manifest with invalid target fails closed", () => {
		assert.throws(
			() =>
				resolveManifestTarget(
					{ manifestVersion: 3, target: { kind: "worker", name: "" } },
					"l1",
					CONTEXT,
				),
			InvalidConfigError,
		);
	});
	test("v2 manifest with worker migrates deterministically to worker target", () => {
		const target = resolveManifestTarget(
			{ manifestVersion: 2, worker: "reviewer" },
			"l1",
			CONTEXT,
		);
		assert.deepStrictEqual(target, { kind: "worker", name: "reviewer" });
	});
	test("v2 worker name is preserved byte-for-byte", () => {
		// v2 imposed no naming constraints; migration must not reject
		// historical names retroactively.
		const target = resolveManifestTarget(
			{ manifestVersion: 2, worker: "Commit Msg [old]!" },
			"l1",
			CONTEXT,
		);
		assert.deepStrictEqual(target, {
			kind: "worker",
			name: "Commit Msg [old]!",
		});
	});
	test("v2 manifest without worker is NEVER guessed as host", () => {
		assert.throws(
			() => resolveManifestTarget({ manifestVersion: 2 }, "l1", CONTEXT),
			AmbiguousLegacyDelegationTargetError,
		);
		try {
			resolveManifestTarget({ manifestVersion: 2 }, "l1", CONTEXT);
			assert.fail("expected AmbiguousLegacyDelegationTargetError");
		} catch (err) {
			assert.ok(err instanceof AmbiguousLegacyDelegationTargetError);
			assert.strictEqual(err.kind, "ambiguous_legacy_delegation_target");
			assert.ok(String((err as Error).message).includes("no legacy default"));
			assert.strictEqual((err as { runId?: string }).runId, CONTEXT.runId);
		}
	});
	test("v2 manifest with empty worker string is ambiguous (fail closed)", () => {
		assert.throws(
			() =>
				resolveManifestTarget(
					{ manifestVersion: 2, worker: "" },
					"l1",
					CONTEXT,
				),
			AmbiguousLegacyDelegationTargetError,
		);
	});
	test("v2 manifest with non-string worker is ambiguous (fail closed)", () => {
		assert.throws(
			() =>
				resolveManifestTarget(
					{ manifestVersion: 2, worker: 42 },
					"l1",
					CONTEXT,
				),
			AmbiguousLegacyDelegationTargetError,
		);
	});
	test("v2 manifest with worker null is ambiguous (fail closed)", () => {
		assert.throws(
			() =>
				resolveManifestTarget(
					{ manifestVersion: 2, worker: null },
					"l1",
					CONTEXT,
				),
			AmbiguousLegacyDelegationTargetError,
		);
	});
	test("unknown manifest version fails closed with protocol error", () => {
		assert.throws(
			() =>
				resolveManifestTarget(
					{ manifestVersion: 1, skill: "x" },
					"l1",
					CONTEXT,
				),
			ProtocolError,
		);
	});
	test("missing manifestVersion fails closed with protocol error", () => {
		assert.throws(
			() => resolveManifestTarget({ worker: "x" }, "l1", CONTEXT),
			ProtocolError,
		);
	});
});
