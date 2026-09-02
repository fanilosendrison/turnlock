import assert from "node:assert/strict";
// NIB-T §5 — validator (T-VA-01..10, P-VA-a/b/c)
import { describe, test } from "node:test";
import { z } from "zod";
import {
	summarizeZodError,
	validateResult,
} from "../../src/services/validator.js";

const schema = z.object({ name: z.string(), count: z.number() });
describe("validateResult success (T-VA-01..02)", () => {
	test("T-VA-01 | valid object", () => {
		const r = validateResult({ name: "a", count: 1 }, schema);
		assert.strictEqual(r.ok, true);
		if (r.ok) assert.deepStrictEqual(r.data, { name: "a", count: 1 });
	});
	test("T-VA-02 | valid edge values", () => {
		const r = validateResult({ name: "", count: 0 }, schema);
		assert.strictEqual(r.ok, true);
	});
});
describe("validateResult failures (T-VA-03..07)", () => {
	test("T-VA-03 | wrong type for name", () => {
		const r = validateResult({ name: 1, count: 1 }, schema);
		assert.strictEqual(r.ok, false);
		if (!r.ok) {
			assert.strictEqual(
				r.error.issues.some((i) => i.path.includes("name")),
				true,
			);
		}
	});
	test("T-VA-04 | missing count", () => {
		const r = validateResult({ name: "a" }, schema);
		assert.strictEqual(r.ok, false);
	});
	test("T-VA-05 | null input", () => {
		const r = validateResult(null, schema);
		assert.strictEqual(r.ok, false);
	});
	test("T-VA-06 | plain string", () => {
		const r = validateResult("plain string", schema);
		assert.strictEqual(r.ok, false);
	});
	test("T-VA-07 | array input", () => {
		const r = validateResult([], schema);
		assert.strictEqual(r.ok, false);
	});
});
describe("summarizeZodError (T-VA-08..10)", () => {
	test("T-VA-08 | single field path+code ≤ 200", () => {
		const r = validateResult({ name: 1, count: 1 }, schema);
		if (!r.ok) {
			const summary = summarizeZodError(r.error);
			assert.ok(summary.length <= 200);
			assert.ok(summary.includes("name"));
		}
	});
	test("T-VA-09 | many fields truncated with ellipsis", () => {
		const bigSchema = z.object(
			Object.fromEntries(
				Array.from({ length: 50 }, (_, i) => [`f${i}`, z.string()]),
			),
		);
		const r = validateResult({}, bigSchema);
		if (!r.ok) {
			const summary = summarizeZodError(r.error);
			assert.ok(summary.length <= 200);
			assert.ok(summary.includes("…"));
		}
	});
	test("T-VA-10 | root issue starts with 'root: '", () => {
		const r = validateResult(null, schema);
		if (!r.ok) {
			const summary = summarizeZodError(r.error);
			assert.strictEqual(summary.startsWith("root: "), true);
		}
	});
});
describe("validator properties (P-VA-a..c)", () => {
	test("P-VA-a | validateResult pure", () => {
		const input = { name: "x", count: 2 };
		const a = validateResult(input, schema);
		const b = validateResult(input, schema);
		assert.deepStrictEqual(a, b);
	});
	test("P-VA-b | summary ≤ 200 chars (fuzz 50 errors)", () => {
		for (let i = 0; i < 50; i++) {
			const fakeSchema = z.object(
				Object.fromEntries(
					Array.from({ length: i + 1 }, (_, j) => [`k${j}`, z.string()]),
				),
			);
			const r = validateResult({}, fakeSchema);
			if (!r.ok) {
				assert.ok(summarizeZodError(r.error).length <= 200);
			}
		}
	});
	test("P-VA-c | ok ⇒ data re-validates", () => {
		const r = validateResult({ name: "a", count: 1 }, schema);
		if (r.ok) {
			const again = schema.safeParse(r.data);
			assert.strictEqual(again.success, true);
		}
	});
});
