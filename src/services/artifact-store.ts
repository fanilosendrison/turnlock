// Immutable artifact store — content-addressed blobs under RUN_DIR/artifacts/.
//
// Contract:
//   - prepareJsonArtifact  serializes + computes digest (no I/O).
//   - installPreparedArtifact  writes the blob atomically, create-if-absent.
//   - readAndVerifyArtifact  verifies digest + size before returning bytes.
//
// Blob paths are derived from SHA-256 digest:
//   RUN_DIR/artifacts/sha256/<hex[0:2]>/<hex[2:]>.json
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { ArtifactIntegrityError } from "../errors/concrete.js";
import type {
	ArtifactKind,
	ArtifactRef,
	PreparedArtifact,
} from "../types/artifacts.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function sha256Digest(bytes: Uint8Array): string {
	return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}
function hexFromDigest(digest: string): string {
	// digest is "sha256:3fc7f2...91"
	const colonIdx = digest.indexOf(":");
	if (colonIdx === -1)
		throw new ArtifactIntegrityError("invalid digest format");
	return digest.slice(colonIdx + 1);
}
function artifactRelativePath(digest: string): string {
	const hex = hexFromDigest(digest);
	const prefix = hex.slice(0, 2);
	const rest = hex.slice(2);
	return path.join("artifacts", "sha256", prefix, `${rest}.json`);
}
// ---------------------------------------------------------------------------
// Atomic install with integrity check on collision
// ---------------------------------------------------------------------------
function atomicInstallImmutable(
	targetPath: string,
	bytes: Uint8Array,
): "created" | "existing-match" {
	// Fast path: target already exists → verify integrity
	try {
		const existing = fs.readFileSync(targetPath);
		if (existing.length !== bytes.length) {
			throw new ArtifactIntegrityError(
				`artifact collision: existing blob at ${targetPath} has different size (${existing.length} vs ${bytes.length})`,
			);
		}
		const existingDigest = sha256Digest(existing);
		const newDigest = sha256Digest(bytes);
		if (existingDigest !== newDigest) {
			throw new ArtifactIntegrityError(
				`artifact collision: existing blob at ${targetPath} has different digest (${existingDigest} vs ${newDigest})`,
			);
		}
		return "existing-match";
	} catch (err) {
		if (err instanceof ArtifactIntegrityError) throw err;
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
		// File doesn't exist — proceed with install
	}
	// Create parent directories if needed
	const parentDir = path.dirname(targetPath);
	fs.mkdirSync(parentDir, { recursive: true });
	// Write to a unique temp file, then link atomically
	const tmpPath = `${targetPath}.tmp-${process.pid}-${cryptoRandomSuffix()}`;
	const fd = fs.openSync(
		tmpPath,
		fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
		0o600,
	);
	try {
		fs.writeFileSync(fd, bytes);
		fs.fsyncSync(fd);
	} finally {
		fs.closeSync(fd);
	}
	try {
		// Hard-link is atomic — fails with EEXIST if target already created
		fs.linkSync(tmpPath, targetPath);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "EEXIST") {
			// Another process installed it first — verify integrity
			try {
				fs.unlinkSync(tmpPath);
			} catch {
				/* best-effort */
			}
			const existing = fs.readFileSync(targetPath);
			if (existing.length !== bytes.length) {
				throw new ArtifactIntegrityError(
					`artifact collision on link: existing blob has different size`,
				);
			}
			const existingDigest = sha256Digest(existing);
			const newDigest = sha256Digest(bytes);
			if (existingDigest !== newDigest) {
				throw new ArtifactIntegrityError(
					`artifact collision on link: existing blob has different digest`,
				);
			}
			return "existing-match";
		}
		throw err;
	} finally {
		try {
			fs.unlinkSync(tmpPath);
		} catch {
			/* best-effort */
		}
	}
	// Sync parent directory to ensure durability
	const dirFd = fs.openSync(parentDir, fs.constants.O_RDONLY);
	try {
		fs.fsyncSync(dirFd);
	} finally {
		fs.closeSync(dirFd);
	}
	return "created";
}
function cryptoRandomSuffix(): string {
	return createHash("sha256")
		.update(String(Date.now()) + String(Math.random()))
		.digest("hex")
		.slice(0, 8);
}
// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
/** Serialize a value as JSON, compute its digest, and produce an ArtifactRef
 *  and bytes ready for immutable installation.  No filesystem I/O. */
export function prepareJsonArtifact(
	_runDir: string,
	kind: ArtifactKind,
	value: unknown,
): PreparedArtifact {
	const json = JSON.stringify(value);
	const bytes = Buffer.from(json, "utf-8");
	const digest = sha256Digest(bytes);
	const relativePath = artifactRelativePath(digest);
	const ref: ArtifactRef = {
		kind,
		digestAlgorithm: "sha256",
		digest,
		relativePath,
		mediaType: "application/json",
		sizeBytes: bytes.length,
	};
	return { ref, bytes };
}
/** Install a prepared artifact as an immutable blob under RUN_DIR.
 *
 *  - Creates parent directories as needed.
 *  - Never overwrites an existing blob.
 *  - If a blob already exists at the target path, verifies digest + size.
 *  - Throws ArtifactIntegrityError on collision with different content.
 */
export function installPreparedArtifact(
	runDir: string,
	artifact: PreparedArtifact,
): void {
	validateArtifactStructure(artifact.ref);
	const targetPath = path.join(runDir, artifact.ref.relativePath);
	atomicInstallImmutable(targetPath, artifact.bytes);
}
/** Read an immutable blob and verify its integrity.
 *
 *  - Reads the file at runDir / ref.relativePath.
 *  - Verifies actual size matches ref.sizeBytes.
 *  - Verifies actual SHA-256 digest matches ref.digest.
 *  - Returns the raw bytes.
 *
 *  Throws ArtifactIntegrityError on mismatch.
 */
export function readAndVerifyArtifact(
	runDir: string,
	ref: ArtifactRef,
): Uint8Array {
	// Structural validation — path confinement, digest format, etc.
	validateArtifactStructure(ref);
	const targetPath = path.join(runDir, ref.relativePath);
	let bytes: Buffer;
	try {
		bytes = fs.readFileSync(targetPath);
	} catch (err) {
		throw new ArtifactIntegrityError(
			`artifact blob unreadable at ${ref.relativePath}: ${err instanceof Error ? err.message : String(err)}`,
			{ cause: err },
		);
	}
	if (bytes.length !== ref.sizeBytes) {
		throw new ArtifactIntegrityError(
			`artifact size mismatch: expected ${ref.sizeBytes} bytes, got ${bytes.length} at ${ref.relativePath}`,
		);
	}
	const actualDigest = sha256Digest(bytes);
	if (actualDigest !== ref.digest) {
		throw new ArtifactIntegrityError(
			`artifact digest mismatch: expected ${ref.digest}, got ${actualDigest} at ${ref.relativePath}`,
		);
	}
	return bytes;
}
/** Given a digest string like "sha256:3fc7f2..." and a runDir, return the
 *  absolute filesystem path where the immutable blob would live.  Exported
 *  for use by tests and canonical projection. */
export function artifactAbsolutePath(runDir: string, digest: string): string {
	return path.join(runDir, artifactRelativePath(digest));
}
// ---------------------------------------------------------------------------
// ArtifactRef validation
// ---------------------------------------------------------------------------
/** Validate that an ArtifactRef is structurally sound and confined.
 *
 *  Checks:
 *    - digest matches the expected sha256:<hex> format.
 *    - relativePath is exactly derived from the digest.
 *    - relativePath is relative, stays under artifacts/sha256, no `..`.
 *    - kind matches expectedKind (caller must specify the correct kind for
 *      the field, e.g. "terminal-output" for terminalResult.outputArtifact).
 *    - mediaType is "application/json".
 *    - sizeBytes is a non-negative finite integer.
 *
 *  Throws ArtifactIntegrityError on any violation. */
export function validateArtifactRef(
	ref: ArtifactRef,
	expectedKind: ArtifactKind,
): void {
	// Structural checks first.
	validateArtifactStructure(ref);
	// Kind must match the field-specific expectation.
	if (ref.kind !== expectedKind) {
		throw new ArtifactIntegrityError(
			`artifact kind mismatch: expected ${expectedKind}, got ${ref.kind}`,
		);
	}
}
/** Validate the structural integrity of an ArtifactRef (digest format,
 *  path derivation, confinement, media type, size) WITHOUT checking the
 *  kind field.  Used by the store layer which doesn't know the expected
 *  kind.  Field-specific callers should use validateArtifactRef(). */
function validateArtifactStructure(ref: ArtifactRef): void {
	// Kind must be a valid ArtifactKind value.
	if (
		ref.kind !== "terminal-output" &&
		ref.kind !== "delegation-manifest" &&
		ref.kind !== "external-request-manifest"
	) {
		throw new ArtifactIntegrityError(`invalid artifact kind: ${ref.kind}`);
	}
	// Algorithm
	if (ref.digestAlgorithm !== "sha256") {
		throw new ArtifactIntegrityError(
			`unsupported digest algorithm: ${ref.digestAlgorithm}`,
		);
	}
	// Digest format: sha256:<64 hex chars>
	const digestPattern = /^sha256:[0-9a-f]{64}$/;
	if (!digestPattern.test(ref.digest)) {
		throw new ArtifactIntegrityError(
			`artifact digest has invalid format: ${ref.digest.slice(0, 20)}...`,
		);
	}
	// Digested path vs actual path
	const expectedPath = artifactRelativePath(ref.digest);
	if (ref.relativePath !== expectedPath) {
		throw new ArtifactIntegrityError(
			`artifact relativePath does not match digest: expected ${expectedPath}, got ${ref.relativePath}`,
		);
	}
	// Path confinement — must be relative, no traversal, under artifacts/sha256.
	if (path.isAbsolute(ref.relativePath)) {
		throw new ArtifactIntegrityError(
			`artifact relativePath must be relative: ${ref.relativePath}`,
		);
	}
	const segments = ref.relativePath.split(path.sep);
	if (segments.includes("..")) {
		throw new ArtifactIntegrityError(
			`artifact relativePath must not contain "..": ${ref.relativePath}`,
		);
	}
	if (segments[0] !== "artifacts" || segments[1] !== "sha256") {
		throw new ArtifactIntegrityError(
			`artifact relativePath must start with artifacts/sha256: ${ref.relativePath}`,
		);
	}
	// Media type
	if (ref.mediaType !== "application/json") {
		throw new ArtifactIntegrityError(
			`unsupported media type: ${ref.mediaType}`,
		);
	}
	// Size
	if (
		typeof ref.sizeBytes !== "number" ||
		!Number.isFinite(ref.sizeBytes) ||
		ref.sizeBytes < 0 ||
		!Number.isInteger(ref.sizeBytes)
	) {
		throw new ArtifactIntegrityError(
			`artifact sizeBytes invalid: ${ref.sizeBytes}`,
		);
	}
}
