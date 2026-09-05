// Filesystem retirement protocol for SQLite-backed RUN_DIRs.
//
// Retention uses three distinct boundaries:
//
//   1. SQLite retirement COMMIT:
//      the old run can never regain ownership.
//
//   2. Namespace-mutex-protected atomic rename:
//      the old physical incarnation leaves the canonical runId pathname
//      while no compliant creator can replace that pathname.
//
//   3. Durable READY marker:
//      physical deletion may proceed and recover independently of all
//      files inside the retired payload.
//
// Protocol:
//
//   acquire namespace mutex(runId)          RUN_ROOT/<orch>/.namespace/<runId>.sqlite3
//     ↓
//   claim ACTIVE → RETIRING (run-local SQLite authority; LIVE_OWNER /
//   UNKNOWN / FAILURE → release mutex → KEEP)
//     ↓
//   pre-rename identity + strict read-only DB verification
//     ↓
//   atomic rename canonical → .retired/payload/<runId>--<token>
//     ↓
//   fsync source + destination parents
//     ↓
//   post-rename strict verification (restore on mismatch, under mutex)
//     ↓
//   publish durable READY marker (create-once, fsynced)
//     ↓
//   release namespace mutex                    ← rm MUST NOT run under it
//     ↓
//   rm -rf the retired payload (READY remains until the payload is gone)
//
// Crash recovery (sweep):
//   READY first — marker + payload root identity is the destructive
//   authority; the payload's turnlock.sqlite3 is never opened.
//   UNREADY next — strict read-only DB inspection re-establishes READY
//   from an intact database.
//
// NORMATIVE LOCK ORDERING: the namespace mutex is acquired BEFORE any
// run-local SQLite BEGIN IMMEDIATE.  Never the reverse.
import * as fs from "node:fs";
import * as path from "node:path";
import { RUN_DB_FILENAME } from "../constants.js";
import {
	claimRunForRetentionDeletion,
	type RunDatabaseFilesystemIdentity,
} from "../persistence/sqlite/retention-claim.js";
import { inspectRetiredRunAuthority } from "../persistence/sqlite/retired-run-inspection.js";
import type { SqliteDriver } from "../persistence/sqlite/sqlite-driver.js";
import {
	ensureDirectoryPathWithoutSymlinks,
	fsyncDirectory,
} from "./durable-fs.js";
import {
	captureRetiredPayloadIdentity,
	publishRetirementReadyMarker,
	RETIRED_PAYLOAD_DIR_NAME,
	RETIRED_READY_DIR_NAME,
	RETIREMENT_READY_MARKER_VERSION,
	type RetirementReadyMarkerV1,
	removeRetirementReadyMarkerDurably,
	retiredDirectoryName,
	sweepReadyRetirementMarkers,
	sweepUnreadyRetiredPayloads,
} from "./retirement-journal.js";
import type { RunDirRetirement } from "./run-dir.js";
import { isValidRunId } from "./run-id.js";
import {
	acquireRunNamespaceMutex,
	NAMESPACE_MUTEX_BUSY_TIMEOUT_MS,
	resolveNamespaceMutexPath,
} from "./run-namespace-mutex.js";

export const RETIRED_DIR_NAME = ".retired" as const;

// Re-exports for the recovery journal layout.
export {
	RETIRED_PAYLOAD_DIR_NAME,
	RETIRED_READY_DIR_NAME,
	RETIREMENT_READY_MARKER_VERSION,
	retiredDirectoryName,
} from "./retirement-journal.js";

// ---------------------------------------------------------------------------
// Internal test seams (never exposed on the public package API)
// ---------------------------------------------------------------------------
/** Closed set of internal fault points reserved for tests.  Production
 *  callers never observe these. */
export type RunRetirementFaultPoint =
	| "AFTER_PRE_RENAME_VERIFICATION"
	| "AFTER_RENAME_BEFORE_POSTCHECK";

/** Internal dependencies — extends the production retirement flow with a
 *  fault-injection hook reserved for testing.  NEVER exposed on the public
 *  package API; production always uses {@link productionRetirementDependencies}. */
export interface RunRetirementInternalDependencies {
	readonly onFaultPoint?: (point: RunRetirementFaultPoint) => void;
}

const productionRetirementDependencies: RunRetirementInternalDependencies = {};

/** Outcome of retiring (and deleting) one canonical RUN_DIR candidate. */
export type RunRetirementOutcome =
	| {
			/** The retired incarnation left the canonical pathname and its
			 *  retired files were fully deleted. */
			readonly kind: "DELETED";
	  }
	| {
			/** The old incarnation no longer occupies the canonical
			 *  pathname but physical deletion was not completed — the
			 *  durable READY marker (or the intact DB, recovered by the
			 *  UNREADY sweep) authorizes a future sweep to finish. */
			readonly kind: "DETACHED_PENDING_SWEEP";
			readonly retirementToken: string;
	  }
	| {
			/** The canonical pathname was kept (fail-closed). */
			readonly kind: "KEPT";
			readonly reason:
				| "LIVE_OWNER"
				| "UNKNOWN"
				| "DB_FAILURE"
				| "DB_CONTENTION_TIMEOUT"
				| "IDENTITY_MISMATCH"
				| "NAMESPACE_MUTEX_FAILURE"
				| "FILESYSTEM_FAILURE";
	  };

// ---------------------------------------------------------------------------
// Filesystem primitives
// ---------------------------------------------------------------------------
function pathIdentityMatches(
	canonicalRunDir: string,
	dbPath: string,
	expected: RunDatabaseFilesystemIdentity,
): boolean {
	try {
		const dirStat = fs.lstatSync(canonicalRunDir, { bigint: true });
		const dbStat = fs.lstatSync(dbPath, { bigint: true });
		if (dirStat.isSymbolicLink() || dbStat.isSymbolicLink()) return false;
		return (
			dirStat.dev.toString() === expected.dirDev &&
			dirStat.ino.toString() === expected.dirIno &&
			dbStat.dev.toString() === expected.dbDev &&
			dbStat.ino.toString() === expected.dbIno
		);
	} catch {
		return false;
	}
}

// ---------------------------------------------------------------------------
// Rename — the filesystem namespace linearization point
// ---------------------------------------------------------------------------
export type RenameRunDirectoryResult =
	| {
			/** Detached and verified: rename + fsync + post-rename strict
			 *  verification all succeeded.  READY may now be published. */
			readonly kind: "RENAMED";
			readonly retiredPath: string;
	  }
	| {
			/** Canonical kept (or restored) — NEVER delete. */
			readonly kind: "MISMATCH";
	  }
	| {
			/** The rename happened but durability could not be proven —
			 *  NO READY, NO DELETE; the UNREADY sweep re-validates the
			 *  intact database later. */
			readonly kind: "DETACHED_UNREADY";
			readonly retiredPath: string;
	  };

/** Rename a claimed canonical RUN_DIR into the retirement area.
 *
 *  Re-verifies, before the rename, that the canonical pathname still
 *  refers to the exact directory and database object the claim identified
 *  (dev/ino) AND that the database still carries the matching durable
 *  retirement state (strictly read-only: RETIRING + token + incarnation,
 *  ownership FREE).  Re-verifies again AFTER the rename and, on mismatch,
 *  attempts to restore the directory to the canonical path — it is never
 *  deleted in that case.
 *
 *  The CALLER must hold the per-run namespace mutex for the whole call. */
export function renameRunDirectoryToRetired(params: {
	readonly driver: SqliteDriver;
	readonly runDir: string;
	readonly runId: string;
	readonly retirementToken: string;
	readonly incarnationId: string;
	/** Expected namespace identity, when known. */
	readonly expectedOrchestratorName?: string;
	readonly databaseIdentity: RunDatabaseFilesystemIdentity | null;
}): RenameRunDirectoryResult {
	return renameRunDirectoryToRetiredInternal(
		params,
		productionRetirementDependencies,
	);
}

/** Internal variant of {@link renameRunDirectoryToRetired} with test-only
 *  fault injection.  NEVER exposed on the public package API. */
export function renameRunDirectoryToRetiredInternal(
	params: {
		readonly driver: SqliteDriver;
		readonly runDir: string;
		readonly runId: string;
		readonly retirementToken: string;
		readonly incarnationId: string;
		/** Expected namespace identity, when known. */
		readonly expectedOrchestratorName?: string;
		readonly databaseIdentity: RunDatabaseFilesystemIdentity | null;
	},
	dependencies: RunRetirementInternalDependencies,
): RenameRunDirectoryResult {
	const { driver, runDir, runId, retirementToken, incarnationId } = params;
	const dbPath = path.join(runDir, RUN_DB_FILENAME);
	const orchestratorBaseDir = path.dirname(runDir);
	const retiredRoot = path.join(orchestratorBaseDir, RETIRED_DIR_NAME);
	const retiredPayloadDir = path.join(retiredRoot, RETIRED_PAYLOAD_DIR_NAME);
	const retiredPath = path.join(
		retiredPayloadDir,
		retiredDirectoryName(runId, retirementToken),
	);
	// Identity evidence is mandatory: without it, the rename cannot be
	// bound to the claimed object — fail closed.
	if (params.databaseIdentity === null) {
		return { kind: "MISMATCH" };
	}
	if (!fs.existsSync(runDir)) {
		// Crash B: already renamed (or removed) by a previous attempt —
		// handled by the .retired sweep, nothing to rename here.
		return { kind: "MISMATCH" };
	}
	if (!pathIdentityMatches(runDir, dbPath, params.databaseIdentity)) {
		return { kind: "MISMATCH" };
	}
	// Strict read-only database verification — never creates/migrates.
	const preInspection = inspectRetiredRunAuthority({
		driver,
		dbPath,
		expectedRunId: runId,
		...(params.expectedOrchestratorName !== undefined
			? { expectedOrchestratorName: params.expectedOrchestratorName }
			: {}),
		expectedRetirementToken: retirementToken,
		expectedIncarnationId: incarnationId,
	});
	if (preInspection.kind !== "VALID_RETIRING") {
		return { kind: "MISMATCH" };
	}
	// Do not let an existing symlink redirect the retirement payload or
	// READY journal outside this orchestrator namespace.
	ensureDirectoryPathWithoutSymlinks(retiredPayloadDir, orchestratorBaseDir);
	ensureDirectoryPathWithoutSymlinks(
		path.join(retiredRoot, RETIRED_READY_DIR_NAME),
		orchestratorBaseDir,
	);
	if (fs.existsSync(retiredPath)) {
		// Ambiguous: both the canonical path and a retired payload for the
		// same identity exist — fail closed and let the sweep handle the
		// retired side.
		return { kind: "MISMATCH" };
	}
	// Test-only fault point: fires after every pre-rename verification
	// passed and immediately before the atomic rename.
	dependencies.onFaultPoint?.("AFTER_PRE_RENAME_VERIFICATION");
	fs.renameSync(runDir, retiredPath);
	// Test-only fault point: fires immediately after the atomic rename
	// completed and BEFORE the post-rename verification (and any possible
	// restoration) gets a chance to observe the mismatch.
	dependencies.onFaultPoint?.("AFTER_RENAME_BEFORE_POSTCHECK");
	// Durability of the detach: the rename is the filesystem namespace
	// linearization point — its directory entries must survive power
	// loss.  A failed fsync means NO READY, NO DELETE.
	try {
		fsyncDirectory(orchestratorBaseDir);
		fsyncDirectory(retiredPayloadDir);
	} catch {
		return { kind: "DETACHED_UNREADY", retiredPath };
	}
	// Post-rename strict verification (defense in depth — the namespace
	// mutex is the primary serialization mechanism).
	const postInspection = inspectRetiredRunAuthority({
		driver,
		dbPath: path.join(retiredPath, RUN_DB_FILENAME),
		expectedRunId: runId,
		...(params.expectedOrchestratorName !== undefined
			? { expectedOrchestratorName: params.expectedOrchestratorName }
			: {}),
		expectedRetirementToken: retirementToken,
		expectedIncarnationId: incarnationId,
	});
	if (postInspection.kind !== "VALID_RETIRING") {
		// Mismatch under mutex: NEVER READY, NEVER DELETE.  If the
		// canonical pathname is absent, restore the moved object while the
		// mutex is still held — a compliant initial cannot race this
		// restoration.  If restoration is impossible, the payload stays
		// untouched and the sweep decides (a wrong object fails the
		// read-only inspection and is kept forever).
		try {
			if (!fs.existsSync(runDir)) {
				fs.renameSync(retiredPath, runDir);
			}
		} catch {
			// Restore failed — leave the directory untouched under the
			// retired path; the sweep validates before deleting.
		}
		return { kind: "MISMATCH" };
	}
	return { kind: "RENAMED", retiredPath };
}

/** Delete a retirement-specific directory.  The directory must already
 *  have passed destructive-authorization validation (READY marker
 *  identity match or strict read-only VALID_RETIRING inspection);
 *  deletion failure leaves the retired files in place for a later
 *  sweep. */
export function deleteRetiredRunDirectory(retiredPath: string):
	| {
			readonly kind: "DELETED";
	  }
	| { readonly kind: "FAILED" } {
	try {
		fs.rmSync(retiredPath, { recursive: true, force: true });
		return { kind: "DELETED" };
	} catch {
		return { kind: "FAILED" };
	}
}

// ---------------------------------------------------------------------------
// Recovery sweep
// ---------------------------------------------------------------------------
/** Sweep the .retired area of one orchestrator namespace.
 *
 *  Phase A (READY markers first): each durable marker is strictly
 *  validated and its payload deleted on payload-root identity match —
 *  WITHOUT opening the payload's turnlock.sqlite3.  Payload-absent
 *  markers are cleaned up; ambiguous markers keep everything.
 *
 *  Phase B (UNREADY payloads): entries without a marker are re-validated
 *  through the strict READ-ONLY database inspection; VALID_RETIRING
 *  payloads get their READY marker durably published and are then treated
 *  exactly like READY payloads.  Missing/invalid databases are kept and
 *  never recreated.
 *
 *  Returns the number of fully completed deletions. */
export function sweepRetiredRunDirectories(params: {
	readonly driver: SqliteDriver;
	readonly retiredRoot: string;
	readonly orchestratorName?: string;
}): number {
	const { driver, retiredRoot } = params;
	if (!fs.existsSync(retiredRoot)) return 0;
	let completed = 0;
	// Phase A — READY markers.
	completed += sweepReadyRetirementMarkers({
		retiredRoot,
		orchestratorName: params.orchestratorName ?? null,
	});
	// Phase B — UNREADY payloads.
	completed += sweepUnreadyRetiredPayloads({
		driver,
		retiredRoot,
		...(params.orchestratorName !== undefined
			? { expectedOrchestratorName: params.orchestratorName }
			: {}),
	});
	return completed;
}

// ---------------------------------------------------------------------------
// Full retirement flow
// ---------------------------------------------------------------------------
type KeptReason = Extract<RunRetirementOutcome, { kind: "KEPT" }>["reason"];

interface RetiredUnderMutex {
	readonly kind: "KEPT";
	readonly reason: KeptReason;
}
interface DetachedUnderMutex {
	readonly kind: "DETACHED";
	readonly retiredPath: string;
	readonly retirementToken: string;
	readonly readyPublished: boolean;
}
type RetireUnderMutexResult = RetiredUnderMutex | DetachedUnderMutex;

/** Claim → verify → rename → fsync → post-check → READY.  Runs entirely
 *  while the per-run namespace mutex is held.  NEVER performs recursive
 *  deletion. */
function retireUnderMutex(params: {
	readonly driver: SqliteDriver;
	readonly runDir: string;
	readonly runId: string;
	readonly orchestratorName?: string;
	readonly orchestratorBaseDir: string;
	readonly dependencies: RunRetirementInternalDependencies;
}): RetireUnderMutexResult {
	const { driver, runDir, runId, orchestratorBaseDir, dependencies } = params;
	const claim = claimRunForRetentionDeletion({
		driver,
		dbPath: path.join(runDir, RUN_DB_FILENAME),
		runId,
		...(params.orchestratorName !== undefined
			? { expectedOrchestratorName: params.orchestratorName }
			: {}),
		busyTimeoutMs: 2000,
		contentionDeadlineMs: 5000,
	});
	switch (claim.kind) {
		case "LIVE_OWNER":
			return { kind: "KEPT", reason: "LIVE_OWNER" };
		case "UNKNOWN":
			return { kind: "KEPT", reason: "UNKNOWN" };
		case "DB_FAILURE":
			return { kind: "KEPT", reason: "DB_FAILURE" };
		case "DB_CONTENTION_TIMEOUT":
			return { kind: "KEPT", reason: "DB_CONTENTION_TIMEOUT" };
		case "CLAIMED":
		case "ALREADY_RETIRING":
			break;
	}
	const rename = renameRunDirectoryToRetiredInternal(
		{
			driver,
			runDir,
			runId,
			retirementToken: claim.retirementToken,
			incarnationId: claim.incarnationId,
			...(params.orchestratorName !== undefined
				? { expectedOrchestratorName: params.orchestratorName }
				: {}),
			databaseIdentity: claim.databaseIdentity,
		},
		dependencies,
	);
	if (rename.kind === "MISMATCH") {
		return { kind: "KEPT", reason: "IDENTITY_MISMATCH" };
	}
	if (rename.kind === "DETACHED_UNREADY") {
		return {
			kind: "DETACHED",
			retiredPath: rename.retiredPath,
			retirementToken: claim.retirementToken,
			readyPublished: false,
		};
	}
	// RENAMED: publish the durable READY marker BEFORE releasing the
	// namespace mutex — after this point, deletion no longer depends on
	// any file inside the payload.
	const payloadIdentity = captureRetiredPayloadIdentity(rename.retiredPath);
	if (payloadIdentity === null) {
		return {
			kind: "DETACHED",
			retiredPath: rename.retiredPath,
			retirementToken: claim.retirementToken,
			readyPublished: false,
		};
	}
	const marker: RetirementReadyMarkerV1 = {
		version: RETIREMENT_READY_MARKER_VERSION,
		orchestratorName: claim.orchestratorName,
		runId: claim.runId,
		incarnationId: claim.incarnationId,
		retirementToken: claim.retirementToken,
		retirementClaimedAtEpochMs: claim.retirementClaimedAtEpochMs,
		retiredEntryName: retiredDirectoryName(runId, claim.retirementToken),
		payloadIdentity,
	};
	const publish = publishRetirementReadyMarker({
		retiredRoot: path.join(orchestratorBaseDir, RETIRED_DIR_NAME),
		marker,
	});
	return {
		kind: "DETACHED",
		retiredPath: rename.retiredPath,
		retirementToken: claim.retirementToken,
		readyPublished:
			publish.kind === "PUBLISHED" ||
			publish.kind === "ALREADY_PUBLISHED_IDENTICAL",
	};
}

/** Retire and delete one canonical RUN_DIR candidate.
 *
 *  namespace mutex → claim → verify → atomic rename → fsync →
 *  post-check → READY durable → release mutex → rm retired payload.
 *  Only CLAIMED / ALREADY_RETIRING authorize the filesystem phase; every
 *  other claim result or verification failure keeps the canonical path.
 *  The recursive rm NEVER runs while the namespace mutex is held. */
export function retireRunDirectory(params: {
	readonly driver: SqliteDriver;
	readonly runDir: string;
	readonly runId: string;
	/** Namespace identity used to bind the run-local database to this
	 *  canonical path.  Production callers always provide it. */
	readonly orchestratorName?: string;
}): RunRetirementOutcome {
	return retireRunDirectoryInternal(params, productionRetirementDependencies);
}

/** Internal variant of {@link retireRunDirectory} with test-only fault
 *  injection.  NEVER exposed on the public package API. */
export function retireRunDirectoryInternal(
	params: {
		readonly driver: SqliteDriver;
		readonly runDir: string;
		readonly runId: string;
		/** Namespace identity used to bind the run-local database to this
		 *  canonical path.  Production callers always provide it. */
		readonly orchestratorName?: string;
	},
	dependencies: RunRetirementInternalDependencies,
): RunRetirementOutcome {
	const { driver, runDir, runId } = params;
	// Path safety: the namespace mutex sidecar path is derived from the
	// runId — refuse malformed candidate names before touching anything.
	if (!isValidRunId(runId)) {
		return { kind: "KEPT", reason: "UNKNOWN" };
	}
	const orchestratorBaseDir = path.dirname(runDir);
	const mutexPath = resolveNamespaceMutexPath(orchestratorBaseDir, runId);
	const acquired = acquireRunNamespaceMutex({
		driver,
		mutexPath,
		busyTimeoutMs: NAMESPACE_MUTEX_BUSY_TIMEOUT_MS,
	});
	if (acquired.kind !== "ACQUIRED") {
		return {
			kind: "KEPT",
			reason:
				acquired.kind === "CONTENTION_TIMEOUT"
					? "DB_CONTENTION_TIMEOUT"
					: "NAMESPACE_MUTEX_FAILURE",
		};
	}
	let underMutex: RetireUnderMutexResult;
	try {
		underMutex = retireUnderMutex({
			driver,
			runDir,
			runId,
			...(params.orchestratorName !== undefined
				? { orchestratorName: params.orchestratorName }
				: {}),
			orchestratorBaseDir,
			dependencies,
		});
	} catch (error) {
		acquired.handle.rollbackAndRelease();
		throw error;
	}
	// Namespace mutex released BEFORE any recursive deletion — a new
	// initial can establish a new incarnation at the canonical pathname
	// while the old payload is being physically removed.
	acquired.handle.release();
	switch (underMutex.kind) {
		case "KEPT":
			return { kind: "KEPT", reason: underMutex.reason };
		case "DETACHED": {
			if (!underMutex.readyPublished) {
				// READY publication failed after a verified rename: never
				// reactivate, never rm — the UNREADY sweep re-establishes
				// READY from the intact database.
				return {
					kind: "DETACHED_PENDING_SWEEP",
					retirementToken: underMutex.retirementToken,
				};
			}
			const deletion = deleteRetiredRunDirectory(underMutex.retiredPath);
			if (deletion.kind !== "DELETED") {
				// The READY marker stays durable — the future sweep
				// completes the deletion without the payload's DB.
				return {
					kind: "DETACHED_PENDING_SWEEP",
					retirementToken: underMutex.retirementToken,
				};
			}
			removeRetirementReadyMarkerDurably({
				retiredRoot: path.join(orchestratorBaseDir, RETIRED_DIR_NAME),
				entryName: retiredDirectoryName(runId, underMutex.retirementToken),
			});
			return { kind: "DELETED" };
		}
	}
}

/** Build the production filesystem-retirement delegate for a driver. */
export function buildRunRetirement(driver: SqliteDriver): RunDirRetirement {
	return {
		retireRunDirectory: (runDir, runId, orchestratorName) =>
			retireRunDirectory({
				driver,
				runDir,
				runId,
				...(orchestratorName !== undefined ? { orchestratorName } : {}),
			}),
		sweepRetiredDirectories: (retiredRoot, orchestratorName) =>
			sweepRetiredRunDirectories({ driver, retiredRoot, orchestratorName }),
	};
}
