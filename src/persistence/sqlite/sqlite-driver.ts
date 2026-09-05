// Abstract SQLite interface — decouples the domain from any specific driver.
//
// Callers never import `node:sqlite` directly. The concrete driver is
// selected at the runtime boundary.
export interface SqliteStatement {
	run(...parameters: unknown[]): SqliteRunResult;
	get<T>(...parameters: unknown[]): T | undefined;
	all<T>(...parameters: unknown[]): T[];
}
export interface SqliteRunResult {
	readonly changes: number;
}
export interface SqliteConnection {
	exec(sql: string): void;
	prepare(sql: string): SqliteStatement;
	close(): void;
}
export type SqliteDriver = {
	/**
	 * Open (or create) a database at `path`.  The returned connection is
	 * owned by the caller and must be closed explicitly.
	 */
	open(path: string): SqliteConnection;
	/**
	 * Open a database at `path` strictly READ-ONLY.
	 *
	 * Contract:
	 *   - a missing file makes the open FAIL (never creates the file);
	 *   - the connection can never run schema DDL, migrations, or
	 *     pragma mutations.
	 *
	 * Used exclusively to inspect retired payload databases.
	 */
	openReadOnly(path: string): SqliteConnection;
};
