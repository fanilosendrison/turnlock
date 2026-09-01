// Centralized ownership-storage compatibility guard.
//
// Every entry path that may open, create, or acquire SQLite ownership over a
// RUN_DIR must pass through this guard BEFORE any authoritative mutation
// (DB creation, ownership acquisition, fence token increment, state
// projection, or phase execution).
//
// The guard implements the matrix defined in the exclusive-upgrade contract
// (see docs/sqlite-ownership-migration.md):
//
//   SQLite    | .lock   | Result
//   ----------|---------|------------------------------------------
//   absent    | absent  | legacy migration potentially allowed
//   absent    | present | LegacyLockMigrationBlockedError
//   present   | absent  | normal SQLite protocol
//   present   | present | MixedOwnershipProtocolError → fail-closed
//
// existsSync(".lock") is a defensive best-effort check, NOT an atomic
// inter-version lock.  Turnlock does not support a legacy process starting
// concurrently with migration.  The deployment is responsible for the
// exclusive upgrade window (see the upgrade guide).
import * as fs from "node:fs";
import * as path from "node:path";
import { LegacyLockMigrationBlockedError, MixedOwnershipProtocolError, } from "../errors/concrete.js";
/**
 * Assert that the RUN_DIR does not contain an incompatible mix of legacy
 * file-lock and SQLite ownership artifacts.
 *
 * Throws:
 *  - `LegacyLockMigrationBlockedError` when no SQLite DB exists but `.lock`
 *    is present (migration blocked until the operator removes `.lock`).
 *  - `MixedOwnershipProtocolError` when both SQLite DB and `.lock` coexist
 *    (deployment or downgrade contract violated).
 *
 * Does NOT:
 *  - remove, rewrite, expire, or reinterpret `.lock`
 *  - guarantee that no legacy process is running concurrently
 */
export function assertOwnershipStorageCompatibility(input) {
    const lockPath = path.join(input.runDir, ".lock");
    const lockExists = fs.existsSync(lockPath);
    if (!input.sqliteDatabaseExists && lockExists) {
        throw new LegacyLockMigrationBlockedError("Legacy ownership lock (.lock) exists; exclusive migration to SQLite cannot be established.", {
            runId: input.runId,
            orchestratorName: input.orchestratorName,
        });
    }
    if (input.sqliteDatabaseExists && lockExists) {
        throw new MixedOwnershipProtocolError("SQLite ownership storage (turnlock.sqlite3) and legacy lock (.lock) coexist — deployment or downgrade contract violated. No new authority granted.", {
            runId: input.runId,
            orchestratorName: input.orchestratorName,
        });
    }
    // sqliteDbExists && !lockExists  → normal SQLite protocol
    // !sqliteDbExists && !lockExists → legacy migration potentially allowed
    //
    // In both cases, no error is thrown.  The absence of `.lock` is NOT proof
    // that the upgrade window is exclusive — that remains an operational
    // precondition (see docs/sqlite-ownership-migration.md).
}
//# sourceMappingURL=ownership-storage-compatibility.js.map