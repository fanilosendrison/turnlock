import { createHash } from "node:crypto";
const CONTENT_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
export function contentDigest(content) {
    return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}
export function isContentDigest(value) {
    return typeof value === "string" && CONTENT_DIGEST_PATTERN.test(value);
}
export function contentMatchesDigest(content, digest) {
    return isContentDigest(digest) && contentDigest(content) === digest;
}
//# sourceMappingURL=content-digest.js.map