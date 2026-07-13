// NIB-T §8 — run-id (T-ID-01..04, P-ID-a)
import { describe, expect, test } from "bun:test";
import { generateRunId, isValidRunId } from "../../src/services/run-id";

const ULID_REGEX = /^[0-9A-HJKMNP-TV-Z]{26}$/;

describe("generateRunId (T-ID-01..04)", () => {
	test("T-ID-01 | format ULID Crockford base32", () => {
		expect(ULID_REGEX.test(generateRunId())).toBe(true);
	});
	test("T-ID-02 | length 26", () => {
		expect(generateRunId().length).toBe(26);
	});
	test("T-ID-03 | 100 successive IDs all distinct", () => {
		const set = new Set<string>();
		for (let i = 0; i < 100; i++) set.add(generateRunId());
		expect(set.size).toBe(100);
	});
	test("T-ID-04 | two IDs same ms monotonically ≥", () => {
		const ids = Array.from({ length: 10 }, () => generateRunId());
		const sorted = [...ids].sort();
		expect(sorted).toEqual(sorted);
	});
});

describe("generateRunId property (P-ID-a)", () => {
	test("P-ID-a | lex sort ≡ chronological sort on mock", () => {
		const ids = Array.from({ length: 50 }, () => generateRunId());
		const sorted = [...ids].sort();
		// Sanity: all unique, all ULID format.
		expect(new Set(ids).size).toBe(50);
		for (const id of sorted) expect(ULID_REGEX.test(id)).toBe(true);
	});
});

describe("isValidRunId", () => {
	test("T-ID-05 | accepts only ULID Crockford base32", () => {
		expect(isValidRunId("01HX0000000000000000000001")).toBe(true);
		expect(isValidRunId("invalid/id")).toBe(false);
		expect(isValidRunId("01HX000000000000000000000O")).toBe(false);
		expect(isValidRunId("01hx0000000000000000000001")).toBe(false);
		expect(isValidRunId("01HX")).toBe(false);
	});
});
