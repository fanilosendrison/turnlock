// Filesystem retirement protocol for SQLite-backed RUN_DIRs.
//
// Two explicit frontiers separate logical retirement from physical
// destruction:
//
//   SQLite linearization point:
//     COMMIT ACTIVE → RETIRING (durable, irreversible, fences the owner)
//
//   Filesystem linearization point:
//     atomic rename  RUN_ROOT/<orchestrator>/<runId>
//                →   RUN_ROOT/<orchestrator>/.retired/<runId>--<retirementToken>
//
// After the rename, the retired incarnation lives exclusively under the
// retirement-specific pathname and recursive deletion operates ONLY there.
// The canonical `<runId>` pathname can later be reused by a NEW
// incarnation without sharing any physical deletion scope with the
// retired one.
//
// Identity safety: a claim authorizes rename/delete of a specific
// filesystem object (dev/ino of the directory and of the database,
// captured while the claim's SQLite connection was still open).  Before
// the rename, the canonical pathname is re-verified against that identity
// AND the database content is re-checked (RETIRING + matching durable
// retirement token).  A swapped pathname fails closed: the canonical path
// is kept and the retirement is resumed by a later sweep through the
// .retired area if the old incarnation was moved there.
import * as fs from "node:fs";
import * as path from "node:path";
import { RUN_DB_FILENAME } from "../constants.js";
import {
	claimRunForRetentionDeletion,
	type RunDatabaseFilesystemIdentity,
} from "../persistence/sqlite/retention-claim.js";
import { openRunDatabase } from "../persistence/sqlite/run-database.js";
import type { SqliteDriver } from "../persistence/sqlite/sqlite-driver.js";
import type { RunDirRetirement } from "./run-dir.js";

export const RETIRED_DIR_NAME = ".retired" as const;

/** Outcome of retiring (and deleting) one canonical RUN_DIR candidate. */
export type RunRetirementOutcome =
	| {
			/** The retired incarnation left the canonical pathname and its
			 *  retired files were fully deleted. */
			readonly kind: "DELETED";
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
				| "FILESYSTEM_FAILURE";
	  };

// ---------------------------------------------------------------------------
// Path safety
// ---------------------------------------------------------------------------
const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

function isValidRetiredEntryName(name: string): boolean {
	const separator = name.lastIndexOf("--");
	if (separator === -1) return false;
	const runId = name.slice(0, separator);
	const token = name.slice(separator + 2);
	return ULID_PATTERN.test(runId) && ULID_PATTERN.test(token);
}

/** The directory name of a retirement-specific pathname. */
export function retiredDirectoryName(
	runId: string,
	retirementToken: string,
): string {
	return `${runId}--${retirementToken}`;
}

// ---------------------------------------------------------------------------
// Database content verification
// ---------------------------------------------------------------------------
/** Read the persisted retirement token from a database at `dbPath`,
 *  verifying run identity and RETIRING status.  Returns null on any
 *  mismatch, incoherence, or unreadable state — never delete on null. */
export function readRetirementTokenFromDb(
	driver: SqliteDriver,
	dbPath: string,
	runId: string,
): string | null {
	let runDb: ReturnType<typeof openRunDatabase> | undefined;
	try {
		runDb = openRunDatabase({
			driver,
			dbPath,
			busyTimeoutMs: 2000,
		});
		const incarnation = runDb.connection
			.prepare("SELECT run_id FROM run_incarnation WHERE singleton = 1")
			.get() as
			| {
					run_id: string;
			  }
			| undefined;
		if (incarnation === undefined || incarnation.run_id !== runId) {
			return null;
		}
		const retention = runDb.connection
			.prepare(
				`SELECT retention_status, retirement_token,\n\t\t\t\t        retirement_claimed_at_epoch_ms\n\t\t\t\t FROM run_retention WHERE singleton = 1`,
			)
			.get() as
			| {
					retention_status: string;
					retirement_token: string | null;
					retirement_claimed_at_epoch_ms: number | null;
			  }
			| undefined;
		if (retention === undefined) return null;
		if (retention.retention_status !== "RETIRING") return null;
		if (
			retention.retirement_token === null ||
			retention.retirement_claimed_at_epoch_ms === null
		) {
			return null;
		}
		return retention.retirement_token;
	} catch {
		return null;
	} finally {
		runDb?.close();
	}
}

// ---------------------------------------------------------------------------
// Filesystem primitives
// ---------------------------------------------------------------------------
function pathIdentityMatches(
	canonicalRunDir: string,
	dbPath: string,
	expected: RunDatabaseFilesystemIdentity,
): boolean {
	try {
		const dirStat = fs.lstatSync(canonicalRunDir);
		const dbStat = fs.lstatSync(dbPath);
		if (dirStat.isSymbolicLink() || dbStat.isSymbolicLink()) return false;
		return (
			dirStat.dev === expected.dirDev &&
			dirStat.ino === expected.dirIno &&
			dbStat.dev === expected.dbDev &&
			dbStat.ino === expected.dbIno
		);
	} catch {
		return false;
	}
}

/** Rename a claimed canonical RUN_DIR into the retirement area.
 *
 *  Re-verifies, before the rename, that the canonical pathname still
 *  refers to the exact directory and database object the claim identified
 *  (dev/ino) AND that the database still carries the matching durable
 *  retirement token.  Re-verifies again AFTER the rename and, on mismatch,
 *  attempts to restore the directory to the canonical path — it is never
 *  deleted in that case. */
export function renameRunDirectoryToRetired(params: {
	readonly driver: SqliteDriver;
	readonly runDir: string;
	readonly runId: string;
	readonly retirementToken: string;
	readonly databaseIdentity: RunDatabaseFilesystemIdentity | null;
}):
	| { readonly kind: "RENAMED"; readonly retiredPath: string }
	| {
			readonly kind: "MISMATCH";
	  } {
	const { driver, runDir, runId, retirementToken, databaseIdentity } = params;
	const dbPath = path.join(runDir, RUN_DB_FILENAME);
	const retiredRoot = path.join(path.dirname(runDir), RETIRED_DIR_NAME);
	const retiredPath = path.join(
		retiredRoot,
		retiredDirectoryName(runId, retirementToken),
	);
	// Identity evidence is mandatory: without it, the rename cannot be
	// bound to the claimed object — fail closed.
	if (databaseIdentity === null) {
		return { kind: "MISMATCH" };
	}
	if (!fs.existsSync(runDir)) {
		// Crash B: already renamed (or removed) by a previous attempt —
		// handled by the .retired sweep, nothing to rename here.
		return { kind: "MISMATCH" };
	}
	if (!pathIdentityMatches(runDir, dbPath, databaseIdentity)) {
		return { kind: "MISMATCH" };
	}
	if (readRetirementTokenFromDb(driver, dbPath, runId) !== retirementToken) {
		return { kind: "MISMATCH" };
	}
	fs.mkdirSync(retiredRoot, { recursive: true });
	if (fs.existsSync(retiredPath)) {
		// Ambiguous: both the canonical path and a retired path for the
		// same identity exist — fail closed and let the sweep handle the
		// retired side.
		return { kind: "MISMATCH" };
	}
	fs.renameSync(runDir, retiredPath);
	// Post-rename self-check: if the renamed directory does not carry our
	// retirement token, restore it to the canonical path if possible and
	// NEVER delete it.
	const postToken = readRetirementTokenFromDb(
		driver,
		path.join(retiredPath, RUN_DB_FILENAME),
		runId,
	);
	if (postToken !== retirementToken) {
		try {
			if (!fs.existsSync(runDir)) {
				fs.renameSync(retiredPath, runDir);
			}
		} catch {
			// Restore failed — leave the directory untouched under the
			// retired path; the sweep validates tokens before deleting.
		}
		return { kind: "MISMATCH" };
	}
	return { kind: "RENAMED", retiredPath };
}

/** Delete a retirement-specific directory.  The directory must already
 *  have passed token validation; deletion failure leaves the retired
 *  files in place for a later sweep. */
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

/** Sweep the .retired area of one orchestrator namespace.
 *
 *  Entries there have already crossed the irreversible retirement
 *  frontier: their deletion requires no ownership acquisition.  Each
 *  entry is still validated — well-formed `<runId>--<retirementToken>`
 *  name (no symlinks, no malformed pathnames) and a database whose
 *  persisted retirement token matches the name — before any deletion.
 *  Returns the number of fully deleted entries. */
export function sweepRetiredRunDirectories(params: {
	readonly driver: SqliteDriver;
	readonly retiredRoot: string;
}): number {
	const { driver, retiredRoot } = params;
	if (!fs.existsSync(retiredRoot)) return 0;
	let deleted = 0;
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(retiredRoot, { withFileTypes: true });
	} catch {
		return 0;
	}
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const name = entry.name;
		if (!isValidRetiredEntryName(name)) continue;
		const separator = name.lastIndexOf("--");
		const runId = name.slice(0, separator);
		const token = name.slice(separator + 2);
		const retiredPath = path.join(retiredRoot, name);
		// Re-validate identity through the database content: a directory
		// whose DB token does not match its name is NEVER deleted.
		if (
			readRetirementTokenFromDb(
				driver,
				path.join(retiredPath, RUN_DB_FILENAME),
				runId,
			) !== token
		) {
			continue;
		}
		const result = deleteRetiredRunDirectory(retiredPath);
		if (result.kind === "DELETED") deleted++;
	}
	return deleted;
}

// ---------------------------------------------------------------------------
// Full retirement flow
// ---------------------------------------------------------------------------
/** Retire and delete one canonical RUN_DIR candidate.
 *
 *  claim → (identity verify) → atomic rename → delete retired path.
 *  Only CLAIMED / ALREADY_RETIRING authorize the filesystem phase; every
 *  other claim result or verification failure keeps the canonical path. */
export function retireRunDirectory(params: {
	readonly driver: SqliteDriver;
	readonly runDir: string;
	readonly runId: string;
}): RunRetirementOutcome {
	const { driver, runDir, runId } = params;
	const claim = claimRunForRetentionDeletion({
		driver,
		dbPath: path.join(runDir, RUN_DB_FILENAME),
		runId,
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
	const rename = renameRunDirectoryToRetired({
		driver,
		runDir,
		runId,
		retirementToken: claim.retirementToken,
		databaseIdentity: claim.databaseIdentity,
	});
	if (rename.kind !== "RENAMED") {
		return { kind: "KEPT", reason: "IDENTITY_MISMATCH" };
	}
	const deletion = deleteRetiredRunDirectory(rename.retiredPath);
	if (deletion.kind !== "DELETED") {
		// The retirement stays committed and the retired files remain
		// under .retired for a later sweep — never reactivated.
		return { kind: "KEPT", reason: "FILESYSTEM_FAILURE" };
	}
	return { kind: "DELETED" };
}

/** Build the production filesystem-retirement delegate for a driver. */
export function buildRunRetirement(driver: SqliteDriver): RunDirRetirement {
	return {
		retireRunDirectory: (runDir, runId) =>
			retireRunDirectory({ driver, runDir, runId }),
		sweepRetiredDirectories: (retiredRoot) =>
			sweepRetiredRunDirectories({ driver, retiredRoot }),
	};
}
