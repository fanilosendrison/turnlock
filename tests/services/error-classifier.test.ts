// NIB-T §3 — error-classifier tests (T-EC-01..14, P-EC-a/b)
import { describe, expect, test } from "bun:test";
import {
	AbortedError,
	DelegationMissingResultError,
	DelegationSchemaError,
	DelegationTimeoutError,
	ExternalResolutionMalformedError,
	ExternalResolutionMissingError,
	ExternalResolutionSchemaError,
	InvalidConfigError,
	PhaseError,
	ProtocolError,
	RunLockedError,
	StateCorruptedError,
	StateMissingError,
	StateVersionMismatchError,
} from "../../src/errors/concrete";
import { classify } from "../../src/services/error-classifier";

const locked = new RunLockedError("x", {
	ownerPid: 1,
	acquiredAtEpochMs: 0,
	leaseUntilEpochMs: 1,
});

describe("error-classifier acceptance (T-EC-01..14)", () => {
	test("T-EC-01 | InvalidConfigError → permanent", () => {
		expect(classify(new InvalidConfigError("x"))).toBe("permanent");
	});
	test("T-EC-02 | StateCorruptedError → permanent", () => {
		expect(classify(new StateCorruptedError("x"))).toBe("permanent");
	});
	test("T-EC-03 | StateMissingError → permanent", () => {
		expect(classify(new StateMissingError("x"))).toBe("permanent");
	});
	test("T-EC-04 | StateVersionMismatchError → permanent", () => {
		expect(classify(new StateVersionMismatchError("x"))).toBe("permanent");
	});
	test("T-EC-05 | DelegationTimeoutError → transient", () => {
		expect(classify(new DelegationTimeoutError("x"))).toBe("transient");
	});
	test("T-EC-06 | DelegationSchemaError → transient", () => {
		expect(classify(new DelegationSchemaError("x"))).toBe("transient");
	});
	test("T-EC-07 | DelegationMissingResultError → permanent", () => {
		expect(classify(new DelegationMissingResultError("x"))).toBe("permanent");
	});
	test("external resolution errors are permanent", () => {
		for (const error of [
			new ExternalResolutionMissingError("x"),
			new ExternalResolutionSchemaError("x"),
			new ExternalResolutionMalformedError("x"),
		]) {
			expect(classify(error)).toBe("permanent");
		}
	});
	test("T-EC-08 | PhaseError(cause=Error) → permanent", () => {
		expect(classify(new PhaseError("x", { cause: new Error("y") }))).toBe(
			"permanent",
		);
	});
	test("T-EC-09 | PhaseError(cause=AbortedError) → abort", () => {
		expect(
			classify(new PhaseError("x", { cause: new AbortedError("y") })),
		).toBe("abort");
	});
	test("T-EC-10 | ProtocolError → permanent", () => {
		expect(classify(new ProtocolError("x"))).toBe("permanent");
	});
	test("T-EC-11 | AbortedError → abort", () => {
		expect(classify(new AbortedError("x"))).toBe("abort");
	});
	test("T-EC-12 | RunLockedError → permanent", () => {
		expect(classify(locked)).toBe("permanent");
	});
	test("T-EC-13 | bare Error → unknown", () => {
		expect(classify(new Error("unknown"))).toBe("unknown");
	});
	test("T-EC-14 | TypeError → unknown", () => {
		expect(classify(new TypeError("x"))).toBe("unknown");
	});
});

describe("error-classifier properties (P-EC-a/b)", () => {
	test("P-EC-a | pure over 50 iterations", () => {
		const err = new DelegationSchemaError("x");
		const first = classify(err);
		for (let i = 0; i < 50; i++) expect(classify(err)).toBe(first);
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
			expect(allowed.has(classify(input))).toBe(true);
		}
	});
});
