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
	 * Open an existing database in read-only mode.  MUST NOT create the
	 * file and MUST NOT perform write-side-effect pragmas.  Drivers without
	 * read-only support omit this method; inspection callers then fail
	 * closed (treat the state as unknown).
	 */
	openReadOnly?(path: string): SqliteConnection;
};
