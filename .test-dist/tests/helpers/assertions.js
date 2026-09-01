import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
export function assertArrayContainsDeepEqual(values, expected) {
    assert.ok(values.some((value) => isDeepStrictEqual(value, expected)), "expected array to contain a deeply equal value");
}
export function assertArrayContainsPartialDeepEqual(values, expected) {
    assert.ok(values.some((value) => {
        try {
            assert.partialDeepStrictEqual(value, expected);
            return true;
        }
        catch {
            return false;
        }
    }), "expected array to contain a partially deeply equal value");
}
//# sourceMappingURL=assertions.js.map