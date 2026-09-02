import assert from "node:assert/strict";
// NIB-T §3 — error-classifier tests (T-EC-01..14, P-EC-a/b)
import { describe, test } from "node:test";
import {
	AbortedError,
	DelegationMissingResultError,
	DelegationSchemaError,
	DelegationTimeoutError,
	ExternalResolutionMalformedError,
	ExternalResolutionMissingError,
	ExternalResolutionSchemaError,
	IndeterminatePhaseExecutionError,
	InitialDispatchAlreadyClaimedError,
	InvalidConfigError,
	LegacyLockMigrationBlockedError,
	MixedOwnershipProtocolError,
	PhaseError,
	ProtocolError,
	RunLockedError,
	StateCorruptedError,
	StateMissingError,
	StateVersionMismatchError,
} from "../../src/errors/concrete.js";
import { classify } from "../../src/services/error-classifier.js";

const locked = new RunLockedError("x", {
	ownerPid: 1,
	acquiredAtEpochMs: 0,
	leaseUntilEpochMs: 1,
});
describe("error-classifier acceptance (T-EC-01..14)", () => {
	test("T-EC-01 | InvalidConfigError → permanent", () => {
		assert.strictEqual(classify(new InvalidConfigError("x")), "permanent");
	});
	test("T-EC-02 | StateCorruptedError → permanent", () => {
		assert.strictEqual(classify(new StateCorruptedError("x")), "permanent");
	});
	test("T-EC-03 | StateMissingError → permanent", () => {
		assert.strictEqual(classify(new StateMissingError("x")), "permanent");
	});
	test("T-EC-04 | StateVersionMismatchError → permanent", () => {
		assert.strictEqual(
			classify(new StateVersionMismatchError("x")),
			"permanent",
		);
	});
	test("T-EC-05 | DelegationTimeoutError → transient", () => {
		assert.strictEqual(classify(new DelegationTimeoutError("x")), "transient");
	});
	test("T-EC-06 | DelegationSchemaError → transient", () => {
		assert.strictEqual(classify(new DelegationSchemaError("x")), "transient");
	});
	test("T-EC-07 | DelegationMissingResultError → permanent", () => {
		assert.strictEqual(
			classify(new DelegationMissingResultError("x")),
			"permanent",
		);
	});
	test("external resolution errors are permanent", () => {
		for (const error of [
			new ExternalResolutionMissingError("x"),
			new ExternalResolutionSchemaError("x"),
			new ExternalResolutionMalformedError("x"),
		]) {
			assert.strictEqual(classify(error), "permanent");
		}
	});
	test("T-EC-08 | PhaseError(cause=Error) → permanent", () => {
		assert.strictEqual(
			classify(new PhaseError("x", { cause: new Error("y") })),
			"permanent",
		);
	});
	test("T-EC-09 | PhaseError(cause=AbortedError) → abort", () => {
		assert.strictEqual(
			classify(new PhaseError("x", { cause: new AbortedError("y") })),
			"abort",
		);
	});
	test("T-EC-10 | ProtocolError → permanent", () => {
		assert.strictEqual(classify(new ProtocolError("x")), "permanent");
	});
	test("T-EC-11 | AbortedError → abort", () => {
		assert.strictEqual(classify(new AbortedError("x")), "abort");
	});
	test("T-EC-12 | RunLockedError → permanent", () => {
		assert.strictEqual(classify(locked), "permanent");
	});
	test("ownership migration guard errors are permanent", () => {
		assert.strictEqual(
			classify(new LegacyLockMigrationBlockedError("x")),
			"permanent",
		);
		assert.strictEqual(
			classify(new MixedOwnershipProtocolError("x")),
			"permanent",
		);
	});
	test("initial dispatch recovery errors are permanent", () => {
		assert.strictEqual(
			classify(new IndeterminatePhaseExecutionError("x")),
			"permanent",
		);
		assert.strictEqual(
			classify(new InitialDispatchAlreadyClaimedError("x")),
			"permanent",
		);
	});
	test("T-EC-13 | bare Error → unknown", () => {
		assert.strictEqual(classify(new Error("unknown")), "unknown");
	});
	test("T-EC-14 | TypeError → unknown", () => {
		assert.strictEqual(classify(new TypeError("x")), "unknown");
	});
	test("unrecognized orchestrator error kind → unknown", () => {
		const error = Object.assign(new Error("future kind"), {
			kind: "future_kind",
		});
		assert.strictEqual(classify(error), "unknown");
	});
});
describe("error-classifier properties (P-EC-a/b)", () => {
	test("P-EC-a | pure over 50 iterations", () => {
		const err = new DelegationSchemaError("x");
		const first = classify(err);
		for (let i = 0; i < 50; i++) assert.strictEqual(classify(err), first);
	});
	test("P-EC-b | codomain ∈ {transient,permanent,abort,unknown}", () => {
		const allowed = new Set(["transient", "permanent", "abort", "unknown"]);
		const inputs: unknown[] = [
			new InvalidConfigError("x"),
			new DelegationTimeoutError("x"),
			new AbortedError("x"),
			new Error("x"),
			null,
			undefined,
			42,
			"string",
		];
		for (const input of inputs) {
			assert.strictEqual(allowed.has(classify(input)), true);
		}
	});
});
