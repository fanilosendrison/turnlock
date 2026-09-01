import assert from "node:assert/strict";
// NIB-T §9 — clock (T-CK-01..08, P-CK-a/b)
import { describe, test } from "node:test";
import { clock } from "../../src/services/clock.js";
import { createMockClock } from "../helpers/mock-clock.js";
describe("clock interface (T-CK-01..04)", () => {
    test("T-CK-01 | nowWall returns Date", () => {
        assert.ok(clock.nowWall() instanceof Date);
    });
    test("T-CK-02 | nowWallIso ISO 8601 UTC", () => {
        assert.match(clock.nowWallIso(), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    });
    test("T-CK-03 | nowEpochMs ≥ 0", () => {
        assert.ok(clock.nowEpochMs() >= 0);
    });
    test("T-CK-04 | nowMono ≥ 0", () => {
        assert.ok(clock.nowMono() >= 0);
    });
});
describe("[GREEN-L1] mock clock (T-CK-05..08)", () => {
    test("T-CK-05 | setWall returns set value", () => {
        const mc = createMockClock();
        mc.setWall("2026-04-19T12:00:00.000Z");
        assert.strictEqual(mc.nowWallIso(), "2026-04-19T12:00:00.000Z");
    });
    test("T-CK-06 | advanceEpoch accumulates", () => {
        const mc = createMockClock("2026-04-19T12:00:00.000Z", 1000);
        mc.advanceEpoch(1000);
        assert.strictEqual(mc.nowEpochMs(), 2000);
    });
    test("T-CK-07 | advanceMono accumulates", () => {
        const mc = createMockClock(undefined, undefined, 0);
        mc.advanceMono(500);
        assert.strictEqual(mc.nowMono(), 500);
    });
    test("T-CK-08 | setWall backward doesn't affect mono", () => {
        const mc = createMockClock("2026-04-19T12:00:00.000Z", 1000, 100);
        mc.setWall("2000-01-01T00:00:00.000Z");
        assert.strictEqual(mc.nowMono(), 100);
    });
});
describe("[GREEN-L1] clock properties (P-CK-a/b)", () => {
    test("P-CK-a | mono cumulates advances", () => {
        const mc = createMockClock(undefined, undefined, 0);
        let total = 0;
        for (const dx of [1, 5, 10, 100, 50]) {
            mc.advanceMono(dx);
            total += dx;
            assert.strictEqual(mc.nowMono(), total);
        }
    });
    test("P-CK-b | mono monotonically non-decreasing", () => {
        const mc = createMockClock(undefined, undefined, 0);
        let prev = mc.nowMono();
        for (let i = 0; i < 20; i++) {
            mc.advanceMono(Math.floor(Math.random() * 10));
            const cur = mc.nowMono();
            assert.ok(cur >= prev);
            prev = cur;
        }
    });
});
//# sourceMappingURL=clock.test.js.map