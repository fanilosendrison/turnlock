// Run-level SQLite database — one per RUN_DIR.
//
// Owns the lifecycle of the concrete SqliteConnection and provides the
// authoritative persistence operations that replace the file-based lock and
// state.json direct writes (once TL-F-001 is fully implemented).
import { CURRENT_SCHEMA_VERSION, SCHEMA_DDL } from "./schema.js";
function configurePragmas(db, busyTimeoutMs) {
    // journal_mode may need an exclusive lock while another process is opening
    // the same run DB. Install the busy handler first so that startup races are
    // bounded retries rather than immediate SQLITE_BUSY failures.
    db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
    db.exec(`PRAGMA journal_mode = WAL`);
    db.exec(`PRAGMA synchronous = FULL`);
    db.exec(`PRAGMA foreign_keys = ON`);
}
function initializeSchema(db) {
    db.exec(SCHEMA_DDL);
    const existing = db
        .prepare("SELECT schema_version FROM schema_metadata WHERE singleton = 1")
        .get();
    if (existing === undefined) {
        db.prepare("INSERT INTO schema_metadata (singleton, schema_version) VALUES (1, ?)").run(CURRENT_SCHEMA_VERSION);
    }
    else if (existing.schema_version !== CURRENT_SCHEMA_VERSION) {
        throw new Error(`SQLite schema version mismatch: expected ${CURRENT_SCHEMA_VERSION}, got ${existing.schema_version}`);
    }
}
export function openRunDatabase(config) {
    const db = config.driver.open(config.dbPath);
    try {
        configurePragmas(db, config.busyTimeoutMs);
        initializeSchema(db);
    }
    catch (error) {
        db.close();
        throw error;
    }
    return {
        connection: db,
        close: () => db.close(),
    };
}
//# sourceMappingURL=run-database.js.map