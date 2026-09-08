import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { resolveManifestTarget } from "../../src/bindings/target.js";
import {
	InvalidConfigError,
	ProtocolError,
} from "../../src/errors/concrete.js";

const CONTEXT = {
	runId: "01HX0000000000000000000001",
	orchestratorName: "orch",
	phase: "review",
} as const;
const LEGACY_NAME = "Commit Msg [old]!";

describe("persisted target compatibility provenance", () => {
	test("v2 migration returns its historical validation provenance", () => {
		const resolved = resolveManifestTarget(
			{ manifestVersion: 2, worker: LEGACY_NAME },
			"commit-message",
			CONTEXT,
		);
		assert.deepStrictEqual(resolved, {
			target: { kind: "worker", name: LEGACY_NAME },
			targetCompatibility: "legacy-v2",
		});
	});

	test("marked v3 accepts the exact historical worker shape byte-for-byte", () => {
		const resolved = resolveManifestTarget(
			{
				manifestVersion: 3,
				target: { kind: "worker", name: LEGACY_NAME },
				targetCompatibility: "legacy-v2",
			},
			"commit-message",
			CONTEXT,
		);
		assert.deepStrictEqual(resolved, {
			target: { kind: "worker", name: LEGACY_NAME },
			targetCompatibility: "legacy-v2",
		});
	});

	test("unmarked v3 keeps strict worker-name validation", () => {
		assert.throws(
			() =>
				resolveManifestTarget(
					{
						manifestVersion: 3,
						target: { kind: "worker", name: LEGACY_NAME },
					},
					"commit-message",
					CONTEXT,
				),
			InvalidConfigError,
		);
	});

	test("marked v3 rejects host, empty names, and extra target fields", () => {
		for (const target of [
			{ kind: "host" },
			{ kind: "worker", name: "" },
			{ kind: "worker", name: LEGACY_NAME, model: "unknown" },
		]) {
			assert.throws(
				() =>
					resolveManifestTarget(
						{
							manifestVersion: 3,
							target,
							targetCompatibility: "legacy-v2",
						},
						"commit-message",
						CONTEXT,
					),
				ProtocolError,
			);
		}
	});

	test("unknown compatibility markers fail closed", () => {
		assert.throws(
			() =>
				resolveManifestTarget(
					{
						manifestVersion: 3,
						target: { kind: "worker", name: "reviewer" },
						targetCompatibility: "legacy-v1",
					},
					"commit-message",
					CONTEXT,
				),
			ProtocolError,
		);
	});
});
