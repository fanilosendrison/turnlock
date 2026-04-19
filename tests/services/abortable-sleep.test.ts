// NIB-T §10 — abortable-sleep (T-AS-01..05, P-AS-a/b)
import { describe, expect, test } from "bun:test";
import { AbortedError } from "../../src/errors/concrete";
import { abortableSleep } from "../../src/services/abortable-sleep";

describe("abortableSleep (T-AS-01..05)", () => {
	test("T-AS-01 | resolves after delay without abort", async () => {
		const c = new AbortController();
		await expect(abortableSleep(10, c.signal)).resolves.toBeUndefined();
	});
	test("T-AS-02 | pre-aborted signal rejects immediately", async () => {
		const c = new AbortController();
		c.abort();
		await expect(abortableSleep(1000, c.signal)).rejects.toBeInstanceOf(
			AbortedError,
		);
	});
	test("T-AS-03 | abort mid-sleep rejects", async () => {
		const c = new AbortController();
		setTimeout(() => c.abort(), 5);
		await expect(abortableSleep(1000, c.signal)).rejects.toBeInstanceOf(
			AbortedError,
		);
	});
	test("T-AS-04 | delayMs=0 resolves immediately", async () => {
		const c = new AbortController();
		await expect(abortableSleep(0, c.signal)).resolves.toBeUndefined();
	});
	test("T-AS-05 | delayMs negative resolves immediately", async () => {
		const c = new AbortController();
		await expect(abortableSleep(-100, c.signal)).resolves.toBeUndefined();
	});
});

describe("abortableSleep properties (P-AS-a/b)", () => {
	test.skip("[GREEN-L1] P-AS-a | no timer leak after resolve/reject (stub)", async () => {
		const c = new AbortController();
		const pre = process.listenerCount("beforeExit");
		await abortableSleep(1, c.signal).catch(() => {});
		expect(process.listenerCount("beforeExit")).toBe(pre);
	});
	test("P-AS-b | abort wins over delay", async () => {
		const c = new AbortController();
		c.abort();
		await expect(abortableSleep(0, c.signal)).rejects.toBeInstanceOf(
			AbortedError,
		);
	});
});
