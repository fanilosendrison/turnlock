import * as fs from "node:fs";
import * as path from "node:path";
import { STATE_SCHEMA_VERSION } from "../constants.js";
import type { MigrationBlockReason } from "../errors/concrete.js";
import type { ArtifactRef, PreparedArtifact } from "../types/artifacts.js";
import { installPreparedArtifact } from "./artifact-store.js";
import { contentDigest } from "./content-digest.js";
import {
	type MigrationResult,
	PREVIOUS_STATE_SCHEMA_VERSION,
} from "./state-contracts.js";

export function migrateV2ToV3(
	parsed: Record<string, unknown>,
): Record<string, unknown> {
	const migrated = {
		...parsed,
		schemaVersion: PREVIOUS_STATE_SCHEMA_VERSION,
	};
	Reflect.deleteProperty(migrated, "pendingExternalRequest");
	return migrated;
}

/** Convert legacy manifest paths in a v3 state record to artifact refs. */
export function migrateV3ToV4(
	parsed: Record<string, unknown>,
	runDir: string,
	installArtifact: (artifact: PreparedArtifact) => void = (artifact) =>
		installArtifactBlob(runDir, artifact),
): MigrationResult {
	const migrated: Record<string, unknown> = { ...parsed };
	let allConverted = true;
	let blockReason: MigrationBlockReason | null = null;
	let blockPath: string | undefined;
	if (migrated.pendingDelegation !== undefined) {
		const pending = migrated.pendingDelegation as Record<string, unknown>;
		if (
			pending.manifestPath !== undefined &&
			pending.manifestArtifact === undefined
		) {
			const rawPath = String(pending.manifestPath);
			const resolved = resolveManifestPath(runDir, rawPath);
			if (resolved === null) {
				allConverted = false;
				if (blockReason === null) {
					blockReason = "MANIFEST_OUTSIDE_RUN_DIR";
					blockPath = rawPath;
				}
			} else {
				const readResult = tryReadManifestBytesWithReason(resolved);
				if (readResult.kind === "OK") {
					const digest = contentDigest(readResult.bytes);
					const ref = buildArtifactRefFromBytes(
						"delegation-manifest",
						digest,
						readResult.bytes,
					);
					installArtifact({ ref, bytes: readResult.bytes });
					pending.manifestArtifact = ref;
					delete pending.manifestPath;
				} else {
					allConverted = false;
					if (blockReason === null) {
						blockReason = readResult.reason;
						blockPath = resolved;
					}
				}
			}
		}
	}
	if (migrated.pendingExternalRequest !== undefined) {
		const pending = migrated.pendingExternalRequest as Record<string, unknown>;
		if (
			pending.manifestPath !== undefined &&
			pending.manifestArtifact === undefined
		) {
			const rawPath = String(pending.manifestPath);
			const resolved = resolveManifestPath(runDir, rawPath);
			if (resolved === null) {
				allConverted = false;
				if (blockReason === null) {
					blockReason = "MANIFEST_OUTSIDE_RUN_DIR";
					blockPath = rawPath;
				}
			} else {
				const readResult = tryReadManifestBytesWithReason(resolved);
				if (readResult.kind === "OK") {
					const digest = contentDigest(readResult.bytes);
					if (
						pending.manifestDigest !== undefined &&
						String(pending.manifestDigest) !== digest
					) {
						allConverted = false;
						if (blockReason === null) {
							blockReason = "MANIFEST_DIGEST_MISMATCH";
							blockPath = resolved;
						}
					} else {
						const ref = buildArtifactRefFromBytes(
							"external-request-manifest",
							digest,
							readResult.bytes,
						);
						installArtifact({ ref, bytes: readResult.bytes });
						pending.manifestArtifact = ref;
						delete pending.manifestPath;
						delete pending.manifestDigest;
					}
				} else {
					allConverted = false;
					if (blockReason === null) {
						blockReason = readResult.reason;
						blockPath = resolved;
					}
				}
			}
		}
	}
	if (allConverted) {
		migrated.schemaVersion = STATE_SCHEMA_VERSION;
		return { kind: "MIGRATED", state: migrated };
	}
	return blockPath !== undefined
		? {
				kind: "BLOCKED" as const,
				reason: blockReason ?? "MANIFEST_MISSING",
				path: blockPath,
			}
		: {
				kind: "BLOCKED" as const,
				reason: blockReason ?? "MANIFEST_MISSING",
			};
}

function resolveManifestPath(runDir: string, stored: string): string | null {
	const root = path.resolve(runDir);
	const candidate = path.isAbsolute(stored)
		? path.resolve(stored)
		: path.resolve(root, stored);
	const relative = path.relative(root, candidate);
	if (
		relative === "" ||
		relative.startsWith(`..${path.sep}`) ||
		relative === ".." ||
		path.isAbsolute(relative)
	) {
		return null;
	}
	return candidate;
}

type ManifestReadResult =
	| { readonly kind: "OK"; readonly bytes: Buffer }
	| { readonly kind: "MISSING"; readonly reason: MigrationBlockReason };

function tryReadManifestBytesWithReason(filePath: string): ManifestReadResult {
	try {
		const stat = fs.lstatSync(filePath);
		if (stat.isSymbolicLink()) {
			return { kind: "MISSING", reason: "MANIFEST_SYMLINK" };
		}
		if (!stat.isFile()) {
			return { kind: "MISSING", reason: "MANIFEST_NOT_REGULAR" };
		}
		return { kind: "OK", bytes: fs.readFileSync(filePath) };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return { kind: "MISSING", reason: "MANIFEST_MISSING" };
		}
		throw error;
	}
}

function installArtifactBlob(runDir: string, artifact: PreparedArtifact): void {
	installPreparedArtifact(runDir, artifact);
}

function buildArtifactRefFromBytes(
	kind: ArtifactRef["kind"],
	digest: string,
	bytes: Uint8Array,
): ArtifactRef {
	const hex = digest.slice(7);
	const prefix = hex.slice(0, 2);
	const rest = hex.slice(2);
	return {
		kind,
		digestAlgorithm: "sha256",
		digest,
		relativePath: `artifacts/sha256/${prefix}/${rest}.json`,
		mediaType: "application/json",
		sizeBytes: bytes.length,
	};
}
