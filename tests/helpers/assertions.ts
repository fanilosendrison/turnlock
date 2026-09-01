import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";

export function assertArrayContainsDeepEqual<T>(
	values: readonly T[],
	expected: T,
): void {
	assert.ok(
		values.some((value) => isDeepStrictEqual(value, expected)),
		"expected array to contain a deeply equal value",
	);
}

export function assertArrayContainsPartialDeepEqual<T>(
	values: readonly T[],
	expected: Partial<T>,
): void {
	assert.ok(
		values.some((value) => {
			try {
				assert.partialDeepStrictEqual(value, expected);
				return true;
			} catch {
				return false;
			}
		}),
		"expected array to contain a partially deeply equal value",
	);
}
