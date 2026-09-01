import { createRequire } from "node:module";
import type {
	DatabaseSync,
	StatementResultingChanges,
	StatementSync,
} from "node:sqlite";
import type {
	SqliteConnection,
	SqliteDriver,
	SqliteRunResult,
	SqliteStatement,
} from "./sqlite-driver.js";

const SQLITE_EXPERIMENTAL_WARNING =
	"SQLite is an experimental feature and might change at any time";

interface NodeSqliteStatementInvocation {
	run(...parameters: unknown[]): StatementResultingChanges;
	get(...parameters: unknown[]): Record<string, unknown> | undefined;
	all(...parameters: unknown[]): Record<string, unknown>[];
}

function loadDatabaseSync(): typeof DatabaseSync {
	const require = createRequire(import.meta.url);
	const originalEmitWarning = process.emitWarning;

	// Node 22-25 emits this warning synchronously whenever node:sqlite is loaded.
	// Turnlock reserves stderr for NDJSON events, so suppress only this exact
	// platform warning during the synchronous module load and forward everything
	// else unchanged. The original process function is restored in all cases.
	process.emitWarning = ((
		warning: string | Error,
		...arguments_: unknown[]
	) => {
		const warningMessage = warning instanceof Error ? warning.message : warning;
		const warningType = arguments_[0];
		if (
			warningMessage === SQLITE_EXPERIMENTAL_WARNING &&
			warningType === "ExperimentalWarning"
		) {
			return;
		}
		Reflect.apply(originalEmitWarning, process, [warning, ...arguments_]);
	}) as typeof process.emitWarning;

	try {
		return (require("node:sqlite") as typeof import("node:sqlite"))
			.DatabaseSync;
	} finally {
		process.emitWarning = originalEmitWarning;
	}
}

class NodeSqliteStatement implements SqliteStatement {
	private readonly invocation: NodeSqliteStatementInvocation;

	constructor(statement: StatementSync) {
		// The domain adapter intentionally accepts unknown parameters. SQLite owns
		// the final binding validation and rejects unsupported values fail-closed.
		this.invocation = statement as unknown as NodeSqliteStatementInvocation;
	}

	run(...parameters: unknown[]): SqliteRunResult {
		const result = this.invocation.run(...parameters);
		const changes = Number(result.changes);
		if (!Number.isSafeInteger(changes)) {
			throw new RangeError("SQLite changes count exceeds safe integer range");
		}
		return { changes };
	}

	get<T>(...parameters: unknown[]): T | undefined {
		return this.invocation.get(...parameters) as T | undefined;
	}

	all<T>(...parameters: unknown[]): T[] {
		return this.invocation.all(...parameters) as T[];
	}
}

class NodeSqliteConnection implements SqliteConnection {
	private readonly database: DatabaseSync;
	private closed = false;

	constructor(path: string) {
		const Database = loadDatabaseSync();
		this.database = new Database(path);
	}

	exec(sql: string): void {
		this.database.exec(sql);
	}

	prepare(sql: string): NodeSqliteStatement {
		return new NodeSqliteStatement(this.database.prepare(sql));
	}

	close(): void {
		if (this.closed) return;
		this.database.close();
		this.closed = true;
	}
}

export const nodeSqliteDriver: SqliteDriver = {
	open(path: string): SqliteConnection {
		return new NodeSqliteConnection(path);
	},
};
