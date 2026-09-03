import assert from "node:assert/strict";
// Authority: public types + serialization contracts + tests + ADR-0001 +
// docs/architecture/delegation-model.md
import { describe, test } from "node:test";
import type {
	BatchDelegationRequest,
	DelegationTarget,
	PromptDelegationRequest,
} from "../../src/index.js";
import { definePhase, runOrchestrator } from "../../src/index.js";

/** Compile-time proof that DelegationTarget is publicly importable. */
export type PublicTarget = DelegationTarget;

describe("[GREEN-L1] delegation target public contract", () => {
	test("DelegationTarget is importable as a type", () => {
		const host: PublicTarget = { kind: "host" };
		const worker: PublicTarget = { kind: "worker", name: "reviewer" };
		assert.deepStrictEqual(host, { kind: "host" });
		assert.deepStrictEqual(worker, { kind: "worker", name: "reviewer" });
	});
	test("PromptDelegationRequest requires target at compile time", () => {
		const request: PromptDelegationRequest = {
			kind: "prompt",
			target: { kind: "host" },
			prompt: "p",
			label: "l",
		};
		assert.strictEqual(request.target.kind, "host");
		// @ts-expect-error target is mandatory: missing target must not typecheck
		const _missing: PromptDelegationRequest = {
			kind: "prompt",
			prompt: "p",
			label: "l",
		};
		void _missing;
		const _legacy: PromptDelegationRequest = {
			kind: "prompt",
			// @ts-expect-error legacy worker field is gone from the public request shape
			worker: "reviewer",
			prompt: "p",
			label: "l",
		};
		void _legacy;
	});
	test("BatchDelegationRequest requires target at compile time", () => {
		const request: BatchDelegationRequest = {
			kind: "batch",
			target: { kind: "worker", name: "reviewer" },
			jobs: [{ id: "j1", prompt: "p1" }],
			label: "b",
		};
		assert.strictEqual(request.target.kind, "worker");
		// @ts-expect-error target is mandatory: missing target must not typecheck
		const _missing: BatchDelegationRequest = {
			kind: "batch",
			jobs: [{ id: "j1", prompt: "p1" }],
			label: "b",
		};
		void _missing;
		const _legacy: BatchDelegationRequest = {
			kind: "batch",
			// @ts-expect-error legacy worker field is gone from the public request shape
			worker: "reviewer",
			jobs: [{ id: "j1", prompt: "p1" }],
			label: "b",
		};
		void _legacy;
	});
	test("invalid target shapes fail to typecheck", () => {
		// @ts-expect-error unknown target kind must not typecheck
		const _unknownKind: DelegationTarget = { kind: "unknown" };
		void _unknownKind;
		// @ts-expect-error host target carries no name
		const _hostWithName: DelegationTarget = { kind: "host", name: "x" };
		void _hostWithName;
		// @ts-expect-error worker target requires a name
		const _workerNoName: DelegationTarget = { kind: "worker" };
		void _workerNoName;
	});
	test("phase code can delegate to host and worker targets", () => {
		const hostPhase = definePhase<{
			seen: string[];
		}>(async (_state, io) =>
			io.delegate(
				{
					kind: "prompt",
					target: { kind: "host" },
					prompt: "decide",
					label: "host-decision",
				},
				"next",
				{ seen: [] },
			),
		);
		const workerPhase = definePhase<{
			seen: string[];
		}>(async (_state, io) =>
			io.delegateBatch(
				{
					kind: "batch",
					target: { kind: "worker", name: "reviewer" },
					jobs: [{ id: "j1", prompt: "review" }],
					label: "parallel-reviews",
				},
				"next",
				{ seen: [] },
			),
		);
		assert.strictEqual(typeof hostPhase, "function");
		assert.strictEqual(typeof workerPhase, "function");
	});
	test("runOrchestrator stays exported and typed", () => {
		assert.strictEqual(typeof runOrchestrator, "function");
	});
});
