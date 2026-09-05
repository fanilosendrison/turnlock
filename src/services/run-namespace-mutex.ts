// Per-run cross-process namespace mutex.
//
// This sidecar SQLite database is an EPHEMERAL MUTEX ONLY — it is NOT a
// business authority.  It carries no run state, no ownership, no lease,
// no fence token, no generation, no retirement state.  Its single
// purpose: serialize, across protocol-compatible Turnlock processes,
// every operation that can create, detach, or establish the canonical
// RUN_DIR pathname of one runId:
//
//   INITIAL  : mkdir canonical + bootstrap the run-local authority
//   CLEANUP  : claim → verify → atomic rename → durable READY journal
//
// Protocol (no lease, no heartbeat, no stale-lock recovery):
//
//   open sidecar SQLite
//   PRAGMA busy_timeout = ...
//   BEGIN IMMEDIATE          ← namespace mutex held
//   [short synchronous critical section]
//   COMMIT / ROLLBACK
//   close
//
// A SIGKILLed holder dies with its SQLite file descriptors closed by the
// OS, which releases the write lock — the next contender acquires without
// any lease-expiration protocol.
//
// NORMATIVE LOCK ORDERING: the namespace mutex MUST be acquired BEFORE
// any run-local SQLite BEGIN IMMEDIATE on the same runId.  Never the
// reverse — a run-DB write transaction must never wait for a namespace
// mutex, or two processes could deadlock.
//
// The sidecar is not part of the package's public API surface.
import * as fs from "node:fs";
import * as path from "node:path";
import { isSqliteBusyError } from "../persistence/sqlite/ownership.js";
import type {
	SqliteConnection,
	SqliteDriver,
} from "../persistence/sqlite/sqlite-driver.js";
import { ensureDirectoryPathWithoutSymlinks } from "./durable-fs.js";

/** Directory name, under one orchestrator namespace, that holds the
 *  per-run namespace mutex sidecars.  Never a run candidate. */
export const RUN_NAMESPACE_DIR_NAME = ".namespace" as const;

/** Format version of the namespace mutex sidecar metadata. */
export const NAMESPACE_MUTEX_FORMAT_VERSION = 1;

/** Default wait applied to BEGIN IMMEDIATE on a contended sidecar.
 *  Critical sections are short (milliseconds); this bound only needs to
 *  cover the other process's rename/fsync/READY work plus test barriers. */
export const NAMESPACE_MUTEX_BUSY_TIMEOUT_MS = 30_000;

export interface AcquireRunNamespaceMutexParams {
	readonly driver: SqliteDriver;
	readonly mutexPath: string;
	readonly busyTimeoutMs: number;
}

export type AcquireRunNamespaceMutexResult =
	| {
			readonly kind: "ACQUIRED";
			readonly handle: RunNamespaceMutexHandle;
	  }
	| {
			readonly kind: "CONTENTION_TIMEOUT";
	  }
	| {
			readonly kind: "FAILURE";
			readonly cause: unknown;
	  };

/** Handle to a held namespace mutex.
 *
 *  - `release()`            → COMMIT + close (successful critical section)
 *  - `rollbackAndRelease()` → best-effort ROLLBACK + close (error path)
 *
 *  Both are idempotent: a second call is a no-op. */
export interface RunNamespaceMutexHandle {
	release(): void;
	rollbackAndRelease(): void;
}

/** Derive the sidecar path for one runId under one orchestrator base
 *  directory (RUN_ROOT/<orchestrator>). */
export function resolveNamespaceMutexPath(
	orchestratorBaseDir: string,
	runId: string,
): string {
	return path.join(
		orchestratorBaseDir,
		RUN_NAMESPACE_DIR_NAME,
		`${runId}.sqlite3`,
	);
}

const NAMESPACE_MUTEX_DDL = `
CREATE TABLE IF NOT EXISTS namespace_mutex_metadata (
    singleton      INTEGER PRIMARY KEY CHECK (singleton = 1),
    format_version INTEGER NOT NULL
);
`;

class NamespaceMutexHandleImpl implements RunNamespaceMutexHandle {
	private released = false;
	constructor(private readonly connection: SqliteConnection) {}

	release(): void {
		if (this.released) return;
		this.released = true;
		try {
			this.connection.exec("COMMIT");
		} catch {
			// best-effort — closing rolls back an uncommitted transaction
		}
		try {
			this.connection.close();
		} catch {
			// already closed
		}
	}

	rollbackAndRelease(): void {
		if (this.released) return;
		this.released = true;
		try {
			this.connection.exec("ROLLBACK");
		} catch {
			// best-effort — the transaction may already be closed
		}
		try {
			this.connection.close();
		} catch {
			// already closed
		}
	}
}

/** Acquire the per-run namespace mutex for one runId.
 *
 *  Creates the `.namespace` directory and the sidecar database if absent,
 *  installs/validates the singleton metadata row inside the SAME
 *  BEGIN IMMEDIATE transaction, and leaves the transaction OPEN — the
 *  returned handle owns the critical section until `release()` (COMMIT) or
 *  `rollbackAndRelease()` (ROLLBACK).
 *
 *  An incoherent sidecar (missing/multiple metadata rows, unknown format
 *  version, unreadable file) is an acquisition FAILURE: initial bootstrap
 *  fails closed and destructive cleanup keeps the candidate. */
export function acquireRunNamespaceMutex(
	params: AcquireRunNamespaceMutexParams,
): AcquireRunNamespaceMutexResult {
	try {
		const namespaceDirectory = path.dirname(params.mutexPath);
		ensureDirectoryPathWithoutSymlinks(
			namespaceDirectory,
			path.dirname(namespaceDirectory),
		);
	} catch (error) {
		return { kind: "FAILURE", cause: error };
	}
	// A sidecar path itself must not be a symlink to another database.
	// Otherwise the namespace lock could be acquired on an unrelated file
	// while the canonical RUN_DIR remains unsynchronized.
	try {
		const stat = fs.lstatSync(params.mutexPath);
		if (stat.isSymbolicLink() || !stat.isFile()) {
			return {
				kind: "FAILURE",
				cause: new Error("namespace mutex path is not a regular file"),
			};
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			return { kind: "FAILURE", cause: error };
		}
	}
	let connection: SqliteConnection;
	try {
		connection = params.driver.open(params.mutexPath);
	} catch (error) {
		return { kind: "FAILURE", cause: error };
	}
	try {
		connection.exec(`PRAGMA busy_timeout = ${params.busyTimeoutMs}`);
		try {
			connection.exec("BEGIN IMMEDIATE");
		} catch (error) {
			try {
				connection.close();
			} catch {
				// best-effort
			}
			if (isSqliteBusyError(error)) {
				return { kind: "CONTENTION_TIMEOUT" };
			}
			return { kind: "FAILURE", cause: error };
		}
		// Sidecar metadata — created and validated inside the same
		// transaction.  No workflow state may ever live here.
		connection.exec(NAMESPACE_MUTEX_DDL);
		connection.exec(
			`INSERT OR IGNORE INTO namespace_mutex_metadata
			 (singleton, format_version)
			 VALUES (1, ${NAMESPACE_MUTEX_FORMAT_VERSION})`,
		);
		const rows = connection
			.prepare("SELECT singleton, format_version FROM namespace_mutex_metadata")
			.all() as ReadonlyArray<{
			singleton: number;
			format_version: number;
		}>;
		if (
			rows.length !== 1 ||
			rows[0]?.singleton !== 1 ||
			rows[0]?.format_version !== NAMESPACE_MUTEX_FORMAT_VERSION
		) {
			try {
				connection.exec("ROLLBACK");
			} catch {
				// best-effort
			}
			connection.close();
			return {
				kind: "FAILURE",
				cause: new Error(
					`incoherent namespace mutex sidecar: expected exactly one metadata row with format_version ${NAMESPACE_MUTEX_FORMAT_VERSION}`,
				),
			};
		}
		return {
			kind: "ACQUIRED",
			handle: new NamespaceMutexHandleImpl(connection),
		};
	} catch (error) {
		try {
			connection.exec("ROLLBACK");
		} catch {
			// best-effort
		}
		try {
			connection.close();
		} catch {
			// already closed
		}
		return { kind: "FAILURE", cause: error };
	}
}
