import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { isJsonValue } from "../../src/services/json-value.js";
describe("JSON value validation", () => {
    test("accepts every recursive JSON value shape", () => {
        const values = [
            null,
            "text",
            42,
            true,
            [null, "text", 42, false, { nested: [1, 2, 3] }],
            { repository: "/repo", options: { force: false }, tags: ["a"] },
        ];
        for (const value of values) {
            assert.strictEqual(isJsonValue(value), true);
        }
    });
    test("rejects values that JSON serialization would lose or rewrite", () => {
        const sparse = [];
        sparse[1] = "value";
        const values = [
            undefined,
            () => "value",
            1n,
            Symbol("value"),
            Number.NaN,
            Number.POSITIVE_INFINITY,
            { value: undefined },
            [undefined],
            sparse,
            new Date("2026-01-01T00:00:00.000Z"),
        ];
        for (const value of values) {
            assert.strictEqual(isJsonValue(value), false);
        }
    });
    test("rejects cyclic objects but accepts repeated non-cyclic references", () => {
        const cyclic = {};
        cyclic.self = cyclic;
        const shared = { value: 1 };
        assert.strictEqual(isJsonValue(cyclic), false);
        assert.strictEqual(isJsonValue({ first: shared, second: shared }), true);
    });
});
//# sourceMappingURL=json-value.test.js.map