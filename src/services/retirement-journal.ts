// Durable retirement recovery journal.
//
// This module owns recovery sweeps and retired-payload deletion.  READY
// marker serialization/publication and path derivation live in
// retirement-ready-marker.ts; this facade re-exports that marker API for
// callers that historically imported it from retirement-journal.ts.
import * as fs from "node:fs";
import * as path from "node:path";
import { RUN_DB_FILENAME } from "../constants.js";
import { inspectRetiredRunAuthority } from "../persistence/sqlite/retired-run-inspection.js";
import type { SqliteDriver } from "../persistence/sqlite/sqlite-driver.js";
import {
	ensureDirectoryPathWithoutSymlinks,
	fsyncDirectory,
} from "./durable-fs.js";
import {
	captureRetiredPayloadIdentity,
	isValidRetiredEntryName,
	parseRetiredEntryName,
	publishRetirementReadyMarker,
	RETIRED_PAYLOAD_DIR_NAME,
	RETIRED_READY_DIR_NAME,
	RETIREMENT_READY_MARKER_VERSION,
	type RetirementReadyMarkerV1,
	readRetirementReadyMarker,
	readyMarkerPath,
	retiredPayloadPath,
} from "./retirement-ready-marker.js";

export {
	captureRetiredPayloadIdentity,
	isValidRetiredEntryName,
	parseRetiredEntryName,
	parseRetirementReadyMarker,
	publishRetirementReadyMarker,
	RETIRED_PAYLOAD_DIR_NAME,
	RETIRED_READY_DIR_NAME,
	RETIREMENT_READY_MARKER_VERSION,
	type RetirementReadyMarkerV1,
	readRetirementReadyMarker,
	readyMarkerPath,
	retiredDirectoryName,
	retiredPayloadPath,
	serializeRetirementReadyMarker,
} from "./retirement-ready-marker.js";
// ---------------------------------------------------------------------------
// Physical deletion of retired payloads
// ---------------------------------------------------------------------------
/** Recursively delete one retired payload and durably persist the parent
 *  directory.  The caller must already hold a valid destructive
 *  authorization (READY marker identity match or strict read-only
 *  VALID_RETIRING inspection). */
export function removeRetiredPayloadDurably(payloadPath: string): boolean {
	try {
		fs.rmSync(payloadPath, { recursive: true, force: true });
	} catch {
		return false;
	}
	try {
		fsyncDirectory(path.dirname(payloadPath));
	} catch {
		// The payload is gone; a failed parent fsync only risks the
		// directory entry after power loss — the sweep will retry safely.
		return true;
	}
	return true;
}

/** Durably remove a READY marker file. */
export function removeRetirementReadyMarkerDurably(params: {
	readonly retiredRoot: string;
	readonly entryName: string;
}): boolean {
	const markerPath = readyMarkerPath(params.retiredRoot, params.entryName);
	if (markerPath === null) return false;
	try {
		ensureDirectoryPathWithoutSymlinks(
			path.dirname(markerPath),
			params.retiredRoot,
		);
		fs.unlinkSync(markerPath);
	} catch {
		return false;
	}
	try {
		fsyncDirectory(path.dirname(markerPath));
	} catch {
		// best-effort durability of the unlink
	}
	return true;
}

// ---------------------------------------------------------------------------
// Recovery sweep — READY first
// ---------------------------------------------------------------------------
/** Phase A of the recovery sweep: process `.retired/ready/*.json`.
 *
 *  Each marker is strictly validated; the payload path is derived ONLY
 *  from validated fields; symlinks are rejected; the payload root dev/ino
 *  must match the marker.  The payload is then deleted WITHOUT opening
 *  turnlock.sqlite3 — the READY marker plus the payload root identity IS
 *  the destructive authority.
 *
 *  Returns the number of retirements fully completed (payload gone and
 *  marker removed). */
export function sweepReadyRetirementMarkers(params: {
	readonly retiredRoot: string;
	readonly orchestratorName?: string | null;
}): number {
	const readyDir = path.join(params.retiredRoot, RETIRED_READY_DIR_NAME);
	try {
		if (!fs.existsSync(readyDir)) return 0;
		ensureDirectoryPathWithoutSymlinks(readyDir, params.retiredRoot);
	} catch {
		return 0;
	}
	let completed = 0;
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(readyDir, { withFileTypes: true });
	} catch {
		return 0;
	}
	for (const entry of entries) {
		if (!entry.isFile()) continue;
		const fileName = entry.name;
		if (!fileName.endsWith(".json")) continue;
		const entryName = fileName.slice(0, -".json".length);
		if (!isValidRetiredEntryName(entryName)) continue;
		const marker = readRetirementReadyMarker({
			retiredRoot: params.retiredRoot,
			entryName,
		});
		if (marker === null) continue; // malformed/ambiguous → KEEP
		if (
			params.orchestratorName !== undefined &&
			params.orchestratorName !== null &&
			marker.orchestratorName !== params.orchestratorName
		) {
			continue; // foreign-orchestrator marker → KEEP
		}
		const payloadPath = retiredPayloadPath(params.retiredRoot, entryName);
		if (payloadPath === null) continue;
		let payloadStat: fs.Stats | null;
		try {
			payloadStat = fs.lstatSync(payloadPath);
		} catch {
			payloadStat = null;
		}
		if (payloadStat === null) {
			// rm completed before the marker was removed — clean up the
			// leftover marker and persist the ready directory.
			if (
				removeRetirementReadyMarkerDurably({
					retiredRoot: params.retiredRoot,
					entryName,
				})
			) {
				completed++;
			}
			continue;
		}
		if (payloadStat.isSymbolicLink() || !payloadStat.isDirectory()) {
			continue; // KEEP
		}
		const identity = captureRetiredPayloadIdentity(payloadPath);
		if (
			identity === null ||
			identity.dev !== marker.payloadIdentity.dev ||
			identity.ino !== marker.payloadIdentity.ino
		) {
			continue; // identity mismatch → KEEP, never delete
		}
		if (!removeRetiredPayloadDurably(payloadPath)) {
			continue; // retry on a later sweep — marker stays
		}
		if (
			removeRetirementReadyMarkerDurably({
				retiredRoot: params.retiredRoot,
				entryName,
			})
		) {
			completed++;
		}
	}
	return completed;
}

// ---------------------------------------------------------------------------
// Recovery sweep — UNREADY next
// ---------------------------------------------------------------------------
/** Phase B of the recovery sweep: process `.retired/payload/*` entries
 *  that have NO READY marker (crashed after rename, before READY).
 *
 *  Each payload is strictly validated by name, symlinks are rejected, and
 *  its database is inspected STRICTLY READ-ONLY.  A VALID_RETIRING
 *  payload whose token matches its pathname has its READY marker durably
 *  published and is then treated exactly like a READY payload.  Anything
 *  else — including a payload whose DB is missing (never recreated!) — is
 *  KEPT. */
export function sweepUnreadyRetiredPayloads(params: {
	readonly driver: SqliteDriver;
	readonly retiredRoot: string;
	/** The namespace being swept; foreign payload databases are kept. */
	readonly expectedOrchestratorName?: string;
}): number {
	const payloadDir = path.join(params.retiredRoot, RETIRED_PAYLOAD_DIR_NAME);
	try {
		if (!fs.existsSync(payloadDir)) return 0;
		ensureDirectoryPathWithoutSymlinks(payloadDir, params.retiredRoot);
	} catch {
		return 0;
	}
	let completed = 0;
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(payloadDir, { withFileTypes: true });
	} catch {
		return 0;
	}
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const entryName = entry.name;
		const parsed = parseRetiredEntryName(entryName);
		if (parsed === null) continue;
		// A payload with an existing READY marker belongs to Phase A —
		// even a corrupt marker must keep the payload (never double-handle).
		const existingMarker = readyMarkerPath(params.retiredRoot, entryName);
		if (existingMarker !== null && fs.existsSync(existingMarker)) {
			continue;
		}
		const payloadPath = retiredPayloadPath(params.retiredRoot, entryName);
		if (payloadPath === null) continue;
		// Reject symlinked payloads (defense in depth — Dirent is lstat-based).
		let payloadStat: fs.Stats | null;
		try {
			payloadStat = fs.lstatSync(payloadPath);
		} catch {
			payloadStat = null;
		}
		if (payloadStat === null || payloadStat.isSymbolicLink()) continue;
		const inspection = inspectRetiredRunAuthority({
			driver: params.driver,
			dbPath: path.join(payloadPath, RUN_DB_FILENAME),
			expectedRunId: parsed.runId,
			...(params.expectedOrchestratorName !== undefined
				? { expectedOrchestratorName: params.expectedOrchestratorName }
				: {}),
			expectedRetirementToken: parsed.token,
		});
		if (inspection.kind !== "VALID_RETIRING") continue; // KEEP
		const identity = captureRetiredPayloadIdentity(payloadPath);
		if (identity === null) continue;
		const marker: RetirementReadyMarkerV1 = {
			version: RETIREMENT_READY_MARKER_VERSION,
			orchestratorName: inspection.orchestratorName,
			runId: inspection.runId,
			incarnationId: inspection.incarnationId,
			retirementToken: inspection.retirementToken,
			retirementClaimedAtEpochMs: inspection.retirementClaimedAtEpochMs,
			retiredEntryName: entryName,
			payloadIdentity: identity,
		};
		const publish = publishRetirementReadyMarker({
			retiredRoot: params.retiredRoot,
			marker,
		});
		if (publish.kind === "CONFLICT" || publish.kind === "FAILURE") {
			continue; // KEEP — never delete on an unpublishable marker
		}
		// Treat exactly like a READY payload.
		if (!removeRetiredPayloadDurably(payloadPath)) continue;
		if (
			removeRetirementReadyMarkerDurably({
				retiredRoot: params.retiredRoot,
				entryName,
			})
		) {
			completed++;
		}
	}
	return completed;
}
