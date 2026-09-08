import type { SqliteConnection } from "./sqlite-driver.js";

export function beginImmediate(db: SqliteConnection): void {
	db.exec("BEGIN IMMEDIATE");
}

export function commit(db: SqliteConnection): void {
	db.exec("COMMIT");
}

export function rollback(db: SqliteConnection): void {
	try {
		db.exec("ROLLBACK");
	} catch {
		// Best-effort — the transaction may already be closed.
	}
}

function isBusy(error: unknown): boolean {
	const msg = String(error);
	return msg.includes("SQLITE_BUSY") || msg.includes("database is locked");
}

/** Shared SQLite busy-error classifier for retry loops. */
export function isSqliteBusyError(error: unknown): boolean {
	return isBusy(error);
}
