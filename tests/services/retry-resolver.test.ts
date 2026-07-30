// NIB-T §2 — retry-resolver tests (T-RR-01..23, P-RR-a..e)
import { describe, expect, test } from "bun:test";
import {
	AbortedError,
	DelegationMissingResultError,
	DelegationSchemaError,
	DelegationTimeoutError,
	InvalidConfigError,
	PhaseError,
	ProtocolError,
	RunLockedError,
	StateCorruptedError,
	StateMissingError,
	StateVersionMismatchError,
} from "../../src/errors/concrete";
import { resolveRetryDecision } from "../../src/services/retry-resolver";

const POLICY = {
	maxAttempts: 3,
	backoffBaseMs: 1000,
	maxBackoffMs: 30_000,
} as const;

function runLocked(): RunLockedError {
	return new RunLockedError("locked", {
		ownerPid: 1,
		acquiredAtEpochMs: 0,
		leaseUntilEpochMs: 1,
	});
}

describe("retry-resolver fatal errors (T-RR-01..09)", () => {
	for (const attempt of [0, 1, 2]) {
		test(`T-RR-01 | InvalidConfigError fatal @attempt=${attempt}`, () => {
			expect(
				resolveRetryDecision(new InvalidConfigError("x"), attempt, POLICY),
			).toEqual({
				retry: false,
				reason: "fatal_invalid_config",
			});
		});
		test(`T-RR-02 | StateCorruptedError fatal @attempt=${attempt}`, () => {
			expect(
				resolveRetryDecision(new StateCorruptedError("x"), attempt, POLICY),
			).toEqual({
				retry: false,
				reason: "fatal_state_corrupted",
			});
		});
		test(`T-RR-03 | StateMissingError fatal @attempt=${attempt}`, () => {
			expect(
				resolveRetryDecision(new StateMissingError("x"), attempt, POLICY),
			).toEqual({
				retry: false,
				reason: "fatal_state_missing",
			});
		});
		test(`T-RR-04 | StateVersionMismatchError fatal @attempt=${attempt}`, () => {
			expect(
				resolveRetryDecision(
					new StateVersionMismatchError("x"),
					attempt,
					POLICY,
				),
			).toEqual({
				retry: false,
				reason: "fatal_state_version_mismatch",
			});
		});
		test(`T-RR-05 | DelegationMissingResultError fatal @attempt=${attempt}`, () => {
			expect(
				resolveRetryDecision(
					new DelegationMissingResultError("x"),
					attempt,
					POLICY,
				),
			).toEqual({
				retry: false,
				reason: "fatal_delegation_missing_result",
			});
		});
		test(`T-RR-06 | ProtocolError fatal @attempt=${attempt}`, () => {
			expect(
				resolveRetryDecision(new ProtocolError("x"), attempt, POLICY),
			).toEqual({
				retry: false,
				reason: "fatal_protocol",
			});
		});
		test(`T-RR-07 | AbortedError fatal @attempt=${attempt}`, () => {
			expect(
				resolveRetryDecision(new AbortedError("x"), attempt, POLICY),
			).toEqual({
				retry: false,
				reason: "fatal_aborted",
			});
		});
		test(`T-RR-08 | PhaseError fatal @attempt=${attempt}`, () => {
			expect(
				resolveRetryDecision(new PhaseError("x"), attempt, POLICY),
			).toEqual({
				retry: false,
				reason: "fatal_phase_error",
			});
		});
		test(`T-RR-09 | RunLockedError fatal @attempt=${attempt}`, () => {
			expect(resolveRetryDecision(runLocked(), attempt, POLICY)).toEqual({
				retry: false,
				reason: "fatal_run_locked",
			});
		});
	}
});

describe("retry-resolver retriables with budget (T-RR-10..13)", () => {
	test("T-RR-10 | timeout attempt 0 → delay=1000", () => {
		expect(
			resolveRetryDecision(new DelegationTimeoutError("t"), 0, POLICY),
		).toEqual({
			retry: true,
			delayMs: 1000,
			reason: "transient_timeout",
		});
	});
	test("T-RR-11 | timeout attempt 1 → delay=2000", () => {
		expect(
			resolveRetryDecision(new DelegationTimeoutError("t"), 1, POLICY),
		).toEqual({
			retry: true,
			delayMs: 2000,
			reason: "transient_timeout",
		});
	});
	test("T-RR-12 | schema attempt 0 → delay=1000", () => {
		expect(
			resolveRetryDecision(new DelegationSchemaError("s"), 0, POLICY),
		).toEqual({
			retry: true,
			delayMs: 1000,
			reason: "transient_schema",
		});
	});
	test("T-RR-13 | schema attempt 1 → delay=2000", () => {
		expect(
			resolveRetryDecision(new DelegationSchemaError("s"), 1, POLICY),
		).toEqual({
			retry: true,
			delayMs: 2000,
			reason: "transient_schema",
		});
	});
});

describe("retry-resolver budget exhausted (T-RR-14..17)", () => {
	test("T-RR-14 | timeout attempt=2/max=3 exhausted", () => {
		expect(
			resolveRetryDecision(new DelegationTimeoutError("t"), 2, POLICY),
		).toEqual({
			retry: false,
			reason: "retry_exhausted",
		});
	});
	test("T-RR-15 | schema attempt=2/max=3 exhausted", () => {
		expect(
			resolveRetryDecision(new DelegationSchemaError("s"), 2, POLICY),
		).toEqual({
			retry: false,
			reason: "retry_exhausted",
		});
	});
	test("T-RR-16 | maxAttempts=1 pas de retry", () => {
		expect(
			resolveRetryDecision(new DelegationTimeoutError("t"), 0, {
				maxAttempts: 1,
				backoffBaseMs: 1000,
				maxBackoffMs: 30_000,
			}),
		).toEqual({ retry: false, reason: "retry_exhausted" });
	});
	test("T-RR-17 | attempt=5 beyond max défensif", () => {
		expect(
			resolveRetryDecision(new DelegationTimeoutError("t"), 5, POLICY),
		).toEqual({
			retry: false,
			reason: "retry_exhausted",
		});
	});
});

describe("retry-resolver backoff cap (T-RR-18..21)", () => {
	test("T-RR-18 | base=1000 attempt=5 → capé 30000", () => {
		expect(
			resolveRetryDecision(new DelegationTimeoutError("t"), 5, {
				maxAttempts: 10,
				backoffBaseMs: 1000,
				maxBackoffMs: 30_000,
			}),
		).toMatchObject({ retry: true, delayMs: 30_000 });
	});
	test("T-RR-19 | base=1000 attempt=6 → capé", () => {
		expect(
			resolveRetryDecision(new DelegationTimeoutError("t"), 6, {
				maxAttempts: 10,
				backoffBaseMs: 1000,
				maxBackoffMs: 30_000,
			}),
		).toMatchObject({ retry: true, delayMs: 30_000 });
	});
	test("T-RR-20 | base=500 attempt=0 → 500", () => {
		expect(
			resolveRetryDecision(new DelegationTimeoutError("t"), 0, {
				maxAttempts: 3,
				backoffBaseMs: 500,
				maxBackoffMs: 2000,
			}),
		).toMatchObject({ retry: true, delayMs: 500 });
	});
	test("T-RR-21 | base=500 attempt=2 → 2000", () => {
		expect(
			resolveRetryDecision(new DelegationTimeoutError("t"), 2, {
				maxAttempts: 5,
				backoffBaseMs: 500,
				maxBackoffMs: 2000,
			}),
		).toMatchObject({ retry: true, delayMs: 2000 });
	});
});

describe("retry-resolver unknown (T-RR-22..23)", () => {
	test("T-RR-22 | bare Error → fatal_unknown", () => {
		expect(resolveRetryDecision(new Error("weird"), 0, POLICY)).toEqual({
			retry: false,
			reason: "fatal_unknown",
		});
	});
	test("T-RR-23 | TypeError → fatal_unknown", () => {
		expect(resolveRetryDecision(new TypeError("oops"), 0, POLICY)).toEqual({
			retry: false,
			reason: "fatal_unknown",
		});
	});
});

describe("retry-resolver properties (P-RR-a..e)", () => {
	test("P-RR-a | pure (50 iterations)", () => {
		const err = new DelegationTimeoutError("t");
		const first = resolveRetryDecision(err, 0, POLICY);
		for (let i = 0; i < 50; i++) {
			expect(resolveRetryDecision(err, 0, POLICY)).toEqual(first);
		}
	});
	test("P-RR-b | fatal independent of policy", () => {
		const policies = [
			{ maxAttempts: 1, backoffBaseMs: 1, maxBackoffMs: 10 },
			{ maxAttempts: 10, backoffBaseMs: 100, maxBackoffMs: 1000 },
			{ maxAttempts: 3, backoffBaseMs: 1000, maxBackoffMs: 30_000 },
			{ maxAttempts: 99, backoffBaseMs: 500, maxBackoffMs: 2000 },
			{ maxAttempts: 2, backoffBaseMs: 250, maxBackoffMs: 500 },
		];
		for (const p of policies) {
			expect(
				resolveRetryDecision(new InvalidConfigError("x"), 0, p),
			).toMatchObject({
				retry: false,
			});
		}
	});
	test("P-RR-c | retry true ⇒ delayMs>0", () => {
		const decision = resolveRetryDecision(
			new DelegationTimeoutError("t"),
			0,
			POLICY,
		);
		if (decision.retry === true) {
			expect(decision.delayMs).toBeGreaterThan(0);
		} else {
			throw new Error("expected retry=true for this fixture");
		}
	});
	test("P-RR-d | retry false ⇒ no delayMs", () => {
		const decision = resolveRetryDecision(
			new InvalidConfigError("x"),
			0,
			POLICY,
		);
		expect(decision.retry).toBe(false);
		expect((decision as { delayMs?: number }).delayMs).toBeUndefined();
	});
	test("P-RR-e | delayMs ≤ maxBackoffMs", () => {
		for (let a = 0; a < 5; a++) {
			const d = resolveRetryDecision(new DelegationTimeoutError("t"), a, {
				maxAttempts: 10,
				backoffBaseMs: 1000,
				maxBackoffMs: 30_000,
			});
			if (d.retry === true) {
				expect(d.delayMs).toBeLessThanOrEqual(30_000);
			}
		}
	});
});
