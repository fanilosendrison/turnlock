import { createRequire } from "node:module";
const SQLITE_EXPERIMENTAL_WARNING = "SQLite is an experimental feature and might change at any time";
function loadDatabaseSync() {
    const require = createRequire(import.meta.url);
    const originalEmitWarning = process.emitWarning;
    // Node 22-25 emits this warning synchronously whenever node:sqlite is loaded.
    // Turnlock reserves stderr for NDJSON events, so suppress only this exact
    // platform warning during the synchronous module load and forward everything
    // else unchanged. The original process function is restored in all cases.
    process.emitWarning = ((warning, ...arguments_) => {
        const warningMessage = warning instanceof Error ? warning.message : warning;
        const warningType = arguments_[0];
        if (warningMessage === SQLITE_EXPERIMENTAL_WARNING &&
            warningType === "ExperimentalWarning") {
            return;
        }
        Reflect.apply(originalEmitWarning, process, [warning, ...arguments_]);
    });
    try {
        return require("node:sqlite")
            .DatabaseSync;
    }
    finally {
        process.emitWarning = originalEmitWarning;
    }
}
class NodeSqliteStatement {
    invocation;
    constructor(statement) {
        // The domain adapter intentionally accepts unknown parameters. SQLite owns
        // the final binding validation and rejects unsupported values fail-closed.
        this.invocation = statement;
    }
    run(...parameters) {
        const result = this.invocation.run(...parameters);
        const changes = Number(result.changes);
        if (!Number.isSafeInteger(changes)) {
            throw new RangeError("SQLite changes count exceeds safe integer range");
        }
        return { changes };
    }
    get(...parameters) {
        return this.invocation.get(...parameters);
    }
    all(...parameters) {
        return this.invocation.all(...parameters);
    }
}
class NodeSqliteConnection {
    database;
    closed = false;
    constructor(path) {
        const Database = loadDatabaseSync();
        this.database = new Database(path);
    }
    exec(sql) {
        this.database.exec(sql);
    }
    prepare(sql) {
        return new NodeSqliteStatement(this.database.prepare(sql));
    }
    close() {
        if (this.closed)
            return;
        this.database.close();
        this.closed = true;
    }
}
export const nodeSqliteDriver = {
    open(path) {
        return new NodeSqliteConnection(path);
    },
};
//# sourceMappingURL=node-sqlite-driver.js.map