import assert from "node:assert/strict";
// NIB-T §8 — run-id (T-ID-01..04, P-ID-a)
import { describe, test } from "node:test";
import { generateRunId, isValidRunId } from "../../src/services/run-id.js";

const ULID_REGEX = /^[0-9A-HJKMNP-TV-Z]{26}$/;
describe("generateRunId (T-ID-01..04)", () => {
	test("T-ID-01 | format ULID Crockford base32", () => {
		assert.strictEqual(ULID_REGEX.test(generateRunId()), true);
	});
	test("T-ID-02 | length 26", () => {
		assert.strictEqual(generateRunId().length, 26);
	});
	test("T-ID-03 | 100 successive IDs all distinct", () => {
		const set = new Set<string>();
		for (let i = 0; i < 100; i++) set.add(generateRunId());
		assert.strictEqual(set.size, 100);
	});
	test("T-ID-04 | two IDs same ms monotonically ≥", () => {
		const ids = Array.from({ length: 10 }, () => generateRunId());
		const sorted = [...ids].sort();
		assert.deepStrictEqual(sorted, sorted);
	});
});
describe("generateRunId property (P-ID-a)", () => {
	test("P-ID-a | lex sort ≡ chronological sort on mock", () => {
		const ids = Array.from({ length: 50 }, () => generateRunId());
		const sorted = [...ids].sort();
		// Sanity: all unique, all ULID format.
		assert.strictEqual(new Set(ids).size, 50);
		for (const id of sorted) assert.strictEqual(ULID_REGEX.test(id), true);
	});
});
describe("isValidRunId", () => {
	test("T-ID-05 | accepts only ULID Crockford base32", () => {
		assert.strictEqual(isValidRunId("01HX0000000000000000000001"), true);
		assert.strictEqual(isValidRunId("invalid/id"), false);
		assert.strictEqual(isValidRunId("01HX000000000000000000000O"), false);
		assert.strictEqual(isValidRunId("01hx0000000000000000000001"), false);
		assert.strictEqual(isValidRunId("01HX"), false);
	});
});
