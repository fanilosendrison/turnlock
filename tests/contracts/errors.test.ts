// NIB-T §27.6 — error classes (C-ER-01..03)
import { describe, expect, test } from "bun:test";
import {
	InvalidConfigError,
	OrchestratorError,
	RunLockedError,
} from "../../src/index";

describe("[GREEN-L1] error classes (C-ER-01..03)", () => {
	test("C-ER-01 | RunLockedError public props", () => {
		const err = new RunLockedError("x", {
			ownerPid: 12345,
			acquiredAtEpochMs: 100,
			leaseUntilEpochMs: 200,
		});
		expect(err.ownerPid).toBe(12345);
		expect(err.acquiredAtEpochMs).toBe(100);
		expect(err.leaseUntilEpochMs).toBe(200);
	});
	test("C-ER-02 | OrchestratorError public opts", () => {
		const err = new InvalidConfigError("x", {
			runId: "R",
			orchestratorName: "O",
			phase: "P",
		});
		expect(err.runId).toBe("R");
		expect(err.orchestratorName).toBe("O");
		expect(err.phase).toBe("P");
	});
	test("C-ER-03 | throw + instanceof working", () => {
		try {
			throw new InvalidConfigError("x");
		} catch (err) {
			expect(err).toBeInstanceOf(InvalidConfigError);
			expect(err).toBeInstanceOf(OrchestratorError);
			expect(err).toBeInstanceOf(Error);
		}
	});
});
