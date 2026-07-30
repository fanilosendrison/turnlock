import { describe, expect, test } from "bun:test";
import {
	contentDigest,
	contentMatchesDigest,
	isContentDigest,
} from "../../src/services/content-digest";

describe("content digest", () => {
	test("computes a self-describing SHA-256 digest over exact UTF-8 bytes", () => {
		expect(contentDigest("hello")).toBe(
			"sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
		);
	});

	test("distinguishes byte-different representations of equivalent JSON", () => {
		const compact = '{"payload":{"value":1}}';
		const spaced = '{ "payload": { "value": 1 } }';
		expect(JSON.parse(compact)).toEqual(JSON.parse(spaced));
		expect(contentDigest(compact)).not.toBe(contentDigest(spaced));
	});

	test("validates and matches only canonical digest strings", () => {
		const digest = contentDigest(new TextEncoder().encode("opaque bytes"));
		expect(isContentDigest(digest)).toBe(true);
		expect(contentMatchesDigest("opaque bytes", digest)).toBe(true);
		expect(contentMatchesDigest("changed", digest)).toBe(false);
		expect(isContentDigest(digest.toUpperCase())).toBe(false);
		expect(isContentDigest("sha256:abc")).toBe(false);
	});
});
