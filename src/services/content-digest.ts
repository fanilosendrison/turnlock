import { createHash } from "node:crypto";

const CONTENT_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
export function contentDigest(content: string | Uint8Array): string {
	return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}
export function isContentDigest(value: unknown): value is string {
	return typeof value === "string" && CONTENT_DIGEST_PATTERN.test(value);
}
export function contentMatchesDigest(
	content: string | Uint8Array,
	digest: string,
): boolean {
	return isContentDigest(digest) && contentDigest(content) === digest;
}
