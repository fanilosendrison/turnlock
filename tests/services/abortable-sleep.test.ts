import assert from "node:assert/strict";
// NIB-T §10 — abortable-sleep (T-AS-01..05, P-AS-a/b)
import { describe, test } from "node:test";
import { AbortedError } from "../../src/errors/concrete.js";
import { abortableSleep } from "../../src/services/abortable-sleep.js";

describe("abortableSleep (T-AS-01..05)", () => {
	test("T-AS-01 | resolves after delay without abort", async () => {
		const c = new AbortController();
		await assert.strictEqual(await abortableSleep(10, c.signal), undefined);
	});
	test("T-AS-02 | pre-aborted signal rejects immediately", async () => {
		const c = new AbortController();
		c.abort();
		await assert.rejects(abortableSleep(1000, c.signal), AbortedError);
	});
	test("T-AS-03 | abort mid-sleep rejects", async () => {
		const c = new AbortController();
		setTimeout(() => c.abort(), 5);
		await assert.rejects(abortableSleep(1000, c.signal), AbortedError);
	});
	test("T-AS-04 | delayMs=0 resolves immediately", async () => {
		const c = new AbortController();
		await assert.strictEqual(await abortableSleep(0, c.signal), undefined);
	});
	test("T-AS-05 | delayMs negative resolves immediately", async () => {
		const c = new AbortController();
		await assert.strictEqual(await abortableSleep(-100, c.signal), undefined);
	});
});
describe("abortableSleep properties (P-AS-a/b)", () => {
	test("[GREEN-L1] P-AS-a | no process listener leak after resolve", async () => {
		const c = new AbortController();
		const pre = process.listenerCount("beforeExit");
		await abortableSleep(1, c.signal).catch(() => {});
		assert.strictEqual(process.listenerCount("beforeExit"), pre);
	});
	test("P-AS-b | abort wins over delay", async () => {
		const c = new AbortController();
		c.abort();
		await assert.rejects(abortableSleep(0, c.signal), AbortedError);
	});
});
