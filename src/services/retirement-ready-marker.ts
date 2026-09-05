// Durable retirement READY marker publication.
//
// The READY marker is the DURABLE, EXTERNAL authorization to physically
// destroy one retired payload.  Once a marker is durably published, the
// payload has already been detached from the canonical namespace and its
// deletion no longer depends on ANY file inside the payload — including
// turnlock.sqlite3.  This is what makes partial-rm recovery possible:
// the destructive permission lives OUTSIDE the object being destroyed.
//
// Layout (under RUN_ROOT/<orchestrator>/.retired):
//
//   payload/
//     <runId>--<retirementToken>/      ← the detached old incarnation
//
//   ready/
//     <runId>--<retirementToken>.json  ← durable destruction permission
//
// The journal is NOT a workflow authority: it only records a permission
// that the run-local SQLite authority already established.  Marker
// publication is atomic, create-once, fsynced, and never overwrites an
// existing different marker.
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	ensureDirectoryPathWithoutSymlinks,
	fsyncDirectory,
} from "./durable-fs.js";
import { isValidRunId } from "./run-id.js";

export const RETIRED_PAYLOAD_DIR_NAME = "payload" as const;
export const RETIRED_READY_DIR_NAME = "ready" as const;
export const RETIREMENT_READY_MARKER_VERSION = 1;

const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const DECIMAL_PATTERN = /^[0-9]+$/;

/** Durable destructive authorization for one retired payload. */
export interface RetirementReadyMarkerV1 {
	readonly version: 1;
	readonly orchestratorName: string;
	readonly runId: string;
	readonly incarnationId: string;
	readonly retirementToken: string;
	readonly retirementClaimedAtEpochMs: number;
	/** `<runId>--<retirementToken>` — the payload directory name. */
	readonly retiredEntryName: string;
	/** dev/ino of the payload ROOT directory, decimal strings from
	 *  lstatSync(path, { bigint: true }). */
	readonly payloadIdentity: {
		readonly dev: string;
		readonly ino: string;
	};
}

// ---------------------------------------------------------------------------
// Path safety
// ---------------------------------------------------------------------------
export function isValidRetiredEntryName(name: string): boolean {
	const separator = name.lastIndexOf("--");
	if (separator === -1) return false;
	const runId = name.slice(0, separator);
	const token = name.slice(separator + 2);
	return ULID_PATTERN.test(runId) && ULID_PATTERN.test(token);
}

export function parseRetiredEntryName(
	name: string,
): { runId: string; token: string } | null {
	if (!isValidRetiredEntryName(name)) return null;
	const separator = name.lastIndexOf("--");
	return {
		runId: name.slice(0, separator),
		token: name.slice(separator + 2),
	};
}

/** The directory name of a retirement-specific payload. */
export function retiredDirectoryName(
	runId: string,
	retirementToken: string,
): string {
	return `${runId}--${retirementToken}`;
}

export function retiredPayloadPath(
	retiredRoot: string,
	entryName: string,
): string | null {
	if (!isValidRetiredEntryName(entryName)) return null;
	const payloadDir = path.join(retiredRoot, RETIRED_PAYLOAD_DIR_NAME);
	const candidate = path.join(payloadDir, entryName);
	// Strict confinement: the derived path must stay inside
	// .retired/payload with the exact validated basename.
	if (
		path.isAbsolute(entryName) ||
		entryName.split(path.sep).includes("..") ||
		path.basename(candidate) !== entryName ||
		path.dirname(candidate) !== payloadDir
	) {
		return null;
	}
	return candidate;
}

export function readyMarkerPath(
	retiredRoot: string,
	entryName: string,
): string | null {
	if (!isValidRetiredEntryName(entryName)) return null;
	const readyDir = path.join(retiredRoot, RETIRED_READY_DIR_NAME);
	const fileName = `${entryName}.json`;
	const candidate = path.join(readyDir, fileName);
	if (
		path.basename(candidate) !== fileName ||
		path.dirname(candidate) !== readyDir
	) {
		return null;
	}
	return candidate;
}

// ---------------------------------------------------------------------------
// Identity capture
// ---------------------------------------------------------------------------
/** Capture the dev/ino identity of a retired payload root as decimal
 *  strings (BigInt-safe — never routed through `number`). */
export function captureRetiredPayloadIdentity(
	payloadPath: string,
): { dev: string; ino: string } | null {
	try {
		const stat = fs.lstatSync(payloadPath, { bigint: true });
		if (stat.isSymbolicLink() || !stat.isDirectory()) return null;
		return {
			dev: stat.dev.toString(),
			ino: stat.ino.toString(),
		};
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// Marker serialization / validation
// ---------------------------------------------------------------------------
export function serializeRetirementReadyMarker(
	marker: RetirementReadyMarkerV1,
): string {
	return JSON.stringify(marker);
}

function isValidMarkerShape(value: unknown): value is RetirementReadyMarkerV1 {
	if (typeof value !== "object" || value === null) return false;
	const m = value as Record<string, unknown>;
	if (m.version !== RETIREMENT_READY_MARKER_VERSION) return false;
	if (typeof m.orchestratorName !== "string" || m.orchestratorName === "") {
		return false;
	}
	if (typeof m.runId !== "string" || !isValidRunId(m.runId)) return false;
	if (
		typeof m.incarnationId !== "string" ||
		!ULID_PATTERN.test(m.incarnationId)
	) {
		return false;
	}
	if (
		typeof m.retirementToken !== "string" ||
		!ULID_PATTERN.test(m.retirementToken)
	) {
		return false;
	}
	if (
		typeof m.retirementClaimedAtEpochMs !== "number" ||
		!Number.isFinite(m.retirementClaimedAtEpochMs) ||
		m.retirementClaimedAtEpochMs < 0
	) {
		return false;
	}
	if (
		typeof m.retiredEntryName !== "string" ||
		m.retiredEntryName !== retiredDirectoryName(m.runId, m.retirementToken)
	) {
		return false;
	}
	const identity = m.payloadIdentity as Record<string, unknown> | undefined;
	if (identity === undefined || identity === null) return false;
	if (
		typeof identity.dev !== "string" ||
		!DECIMAL_PATTERN.test(identity.dev) ||
		typeof identity.ino !== "string" ||
		!DECIMAL_PATTERN.test(identity.ino)
	) {
		return false;
	}
	return true;
}

/** Strictly parse a READY marker.  Returns null on ANY ambiguity —
 *  callers must KEEP, never delete, on null. */
export function parseRetirementReadyMarker(
	text: string,
): RetirementReadyMarkerV1 | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return null;
	}
	if (!isValidMarkerShape(parsed)) return null;
	return parsed;
}

function markersEqual(
	a: RetirementReadyMarkerV1,
	b: RetirementReadyMarkerV1,
): boolean {
	return (
		a.version === b.version &&
		a.orchestratorName === b.orchestratorName &&
		a.runId === b.runId &&
		a.incarnationId === b.incarnationId &&
		a.retirementToken === b.retirementToken &&
		a.retirementClaimedAtEpochMs === b.retirementClaimedAtEpochMs &&
		a.retiredEntryName === b.retiredEntryName &&
		a.payloadIdentity.dev === b.payloadIdentity.dev &&
		a.payloadIdentity.ino === b.payloadIdentity.ino
	);
}

function cryptoRandomSuffix(): string {
	return createHash("sha256")
		.update(String(Date.now()) + String(Math.random()))
		.digest("hex")
		.slice(0, 8);
}

// ---------------------------------------------------------------------------
// Durable publication
// ---------------------------------------------------------------------------
export type RetirementReadyMarkerPublishResult =
	| { readonly kind: "PUBLISHED" }
	| { readonly kind: "ALREADY_PUBLISHED_IDENTICAL" }
	| {
			/** A DIFFERENT marker already exists at the target path —
			 *  integrity failure: never overwrite. */
			readonly kind: "CONFLICT";
			readonly reason: string;
	  }
	| { readonly kind: "FAILURE"; readonly cause: unknown };

/** Compare an existing target without following a symlink.  An identical
 * marker is only accepted after fsyncing its parent directory: another
 * publisher may have won the create-once race immediately before its own
 * durability step, and this caller may be the one that proceeds to delete. */
function compareExistingMarker(
	target: string,
	readyDir: string,
	serialized: string,
	expected: RetirementReadyMarkerV1,
): RetirementReadyMarkerPublishResult {
	try {
		const stat = fs.lstatSync(target);
		if (stat.isSymbolicLink() || !stat.isFile()) {
			return {
				kind: "CONFLICT",
				reason: "READY marker target is not a regular file",
			};
		}
		const existing = fs.readFileSync(target, "utf8");
		const parsed = parseRetirementReadyMarker(existing);
		if (
			existing !== serialized &&
			(parsed === null || !markersEqual(parsed, expected))
		) {
			return {
				kind: "CONFLICT",
				reason: "a different READY marker already exists at the target path",
			};
		}
		fsyncDirectory(readyDir);
		return { kind: "ALREADY_PUBLISHED_IDENTICAL" };
	} catch (error) {
		return { kind: "FAILURE", cause: error };
	}
}

/** Durably publish a READY marker: write unique temp → fsync temp →
 *  atomically install target (hard link, create-once) → fsync parent.
 *
 *  - target exists + identical bytes/content → idempotent success;
 *  - target exists + different content    → CONFLICT (never overwrite). */
export function publishRetirementReadyMarker(params: {
	readonly retiredRoot: string;
	readonly marker: RetirementReadyMarkerV1;
}): RetirementReadyMarkerPublishResult {
	if (!isValidMarkerShape(params.marker)) {
		return {
			kind: "FAILURE",
			cause: new Error("refusing to publish a malformed READY marker"),
		};
	}
	const target = readyMarkerPath(
		params.retiredRoot,
		params.marker.retiredEntryName,
	);
	if (target === null) {
		return { kind: "FAILURE", cause: new Error("invalid retired entry name") };
	}
	const readyDir = path.dirname(target);
	try {
		ensureDirectoryPathWithoutSymlinks(readyDir, params.retiredRoot);
	} catch (error) {
		return { kind: "FAILURE", cause: error };
	}
	const serialized = serializeRetirementReadyMarker(params.marker);
	try {
		fs.lstatSync(target);
		return compareExistingMarker(target, readyDir, serialized, params.marker);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			return { kind: "FAILURE", cause: error };
		}
	}
	const tmpPath = `${target}.tmp-${process.pid}-${cryptoRandomSuffix()}`;
	let fd: number;
	try {
		fd = fs.openSync(
			tmpPath,
			fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
			0o600,
		);
	} catch (error) {
		return { kind: "FAILURE", cause: error };
	}
	try {
		fs.writeFileSync(fd, serialized, { encoding: "utf8" });
		fs.fsyncSync(fd);
	} catch (error) {
		try {
			fs.unlinkSync(tmpPath);
		} catch {
			// best-effort
		}
		return { kind: "FAILURE", cause: error };
	} finally {
		try {
			fs.closeSync(fd);
		} catch {
			// already closed
		}
	}
	try {
		// Hard link is atomic and fails with EEXIST — create-once.
		fs.linkSync(tmpPath, target);
	} catch (error) {
		try {
			fs.unlinkSync(tmpPath);
		} catch {
			// best-effort
		}
		if ((error as NodeJS.ErrnoException).code === "EEXIST") {
			// Another process installed it first — compare, never overwrite.
			return compareExistingMarker(target, readyDir, serialized, params.marker);
		}
		return { kind: "FAILURE", cause: error };
	} finally {
		try {
			fs.unlinkSync(tmpPath);
		} catch {
			// best-effort
		}
	}
	try {
		fsyncDirectory(readyDir);
	} catch (error) {
		// The marker exists but its directory entry is not proven durable —
		// report failure so the caller stays recoverable (no rm).
		return { kind: "FAILURE", cause: error };
	}
	return { kind: "PUBLISHED" };
}

/** Read and strictly validate an existing READY marker.  Null on any
 *  ambiguity — never act destructively on null. */
export function readRetirementReadyMarker(params: {
	readonly retiredRoot: string;
	readonly entryName: string;
}): RetirementReadyMarkerV1 | null {
	const markerPath = readyMarkerPath(params.retiredRoot, params.entryName);
	if (markerPath === null) return null;
	let text: string;
	try {
		const stat = fs.lstatSync(markerPath);
		if (stat.isSymbolicLink() || !stat.isFile()) return null;
		text = fs.readFileSync(markerPath, "utf8");
	} catch {
		return null;
	}
	return parseRetirementReadyMarker(text);
}
