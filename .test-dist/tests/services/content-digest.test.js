import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { contentDigest, contentMatchesDigest, isContentDigest, } from "../../src/services/content-digest.js";
describe("content digest", () => {
    test("computes a self-describing SHA-256 digest over exact UTF-8 bytes", () => {
        assert.strictEqual(contentDigest("hello"), "sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
    });
    test("distinguishes byte-different representations of equivalent JSON", () => {
        const compact = '{"payload":{"value":1}}';
        const spaced = '{ "payload": { "value": 1 } }';
        assert.deepStrictEqual(JSON.parse(compact), JSON.parse(spaced));
        assert.notStrictEqual(contentDigest(compact), contentDigest(spaced));
    });
    test("validates and matches only canonical digest strings", () => {
        const digest = contentDigest(new TextEncoder().encode("opaque bytes"));
        assert.strictEqual(isContentDigest(digest), true);
        assert.strictEqual(contentMatchesDigest("opaque bytes", digest), true);
        assert.strictEqual(contentMatchesDigest("changed", digest), false);
        assert.strictEqual(isContentDigest(digest.toUpperCase()), false);
        assert.strictEqual(isContentDigest("sha256:abc"), false);
    });
});
//# sourceMappingURL=content-digest.test.js.map