import assert from "node:assert/strict";
// NIB-T §27.6 — error classes (C-ER-01..03)
import { describe, test } from "node:test";
import { InvalidConfigError, OrchestratorError, RunLockedError, } from "../../src/index.js";
describe("[GREEN-L1] error classes (C-ER-01..03)", () => {
    test("C-ER-01 | RunLockedError public props", () => {
        const err = new RunLockedError("x", {
            ownerPid: 12345,
            acquiredAtEpochMs: 100,
            leaseUntilEpochMs: 200,
        });
        assert.strictEqual(err.ownerPid, 12345);
        assert.strictEqual(err.acquiredAtEpochMs, 100);
        assert.strictEqual(err.leaseUntilEpochMs, 200);
    });
    test("C-ER-02 | OrchestratorError public opts", () => {
        const err = new InvalidConfigError("x", {
            runId: "R",
            orchestratorName: "O",
            phase: "P",
        });
        assert.strictEqual(err.runId, "R");
        assert.strictEqual(err.orchestratorName, "O");
        assert.strictEqual(err.phase, "P");
    });
    test("C-ER-03 | throw + instanceof working", () => {
        try {
            throw new InvalidConfigError("x");
        }
        catch (err) {
            assert.ok(err instanceof InvalidConfigError);
            assert.ok(err instanceof OrchestratorError);
            assert.ok(err instanceof Error);
        }
    });
});
//# sourceMappingURL=errors.test.js.map