// Bun SQLite driver — adapts `bun:sqlite` to the abstract SqliteDriver
// interface.
//
// When Node becomes a supported production runtime (TL-F-008), a
// corresponding `node:sqlite` adapter should be added.

import type { SQLQueryBindings } from "bun:sqlite";
import { Database } from "bun:sqlite";
import type {
	SqliteConnection,
	SqliteDriver,
	SqliteRunResult,
	SqliteStatement,
} from "./sqlite-driver";

class BunSqliteStatement implements SqliteStatement {
	constructor(private readonly stmt: ReturnType<Database["prepare"]>) {}

	run(...parameters: unknown[]): SqliteRunResult {
		const result = this.stmt.run(...(parameters as SQLQueryBindings[])) as {
			changes: number;
		};
		return { changes: result.changes };
	}

	get<T>(...parameters: unknown[]): T | undefined {
		// bun:sqlite returns `null` for no rows, not `undefined`.
		const row = this.stmt.get(
			...(parameters as SQLQueryBindings[]),
		) as T | null;
		return row === null ? undefined : row;
	}

	all<T>(...parameters: unknown[]): T[] {
		return this.stmt.all(...(parameters as SQLQueryBindings[])) as T[];
	}
}

class BunSqliteConnection implements SqliteConnection {
	private readonly db: Database;

	constructor(path: string) {
		this.db = new Database(path, { create: true });
	}

	exec(sql: string): void {
		this.db.run(sql);
	}

	prepare(sql: string): BunSqliteStatement {
		return new BunSqliteStatement(this.db.prepare(sql));
	}

	close(): void {
		this.db.close();
	}
}

export const bunSqliteDriver: SqliteDriver = {
	open(path: string): SqliteConnection {
		return new BunSqliteConnection(path);
	},
};
