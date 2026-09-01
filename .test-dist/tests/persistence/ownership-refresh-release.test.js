import assert from "node:assert/strict";
import { join } from "node:path";
// Lot 2 — ownership refresh and release tests.
//
// Covers: valid refresh, stale handle rejection, expired handle,
// valid release, double release, fenceToken preservation.
import { describe, test } from "node:test";
import { nodeSqliteDriver } from "../../src/persistence/sqlite/node-sqlite-driver.js";
import { acquireOwnership, refreshOwnership, releaseOwnership, } from "../../src/persistence/sqlite/ownership.js";
import { openRunDatabase } from "../../src/persistence/sqlite/run-database.js";
import { cleanupTempDir, makeTempDir } from "../helpers/temp-run-dir.js";
const LEASE_MS = 30 * 60 * 1000;
const CONTENTION_DEADLINE_MS = 2000;
const NOW_EPOCH = 1000000000000;
const NOW_ISO = "2001-09-09T01:46:40.000Z";
function setup() {
    const dir = makeTempDir();
    const dbPath = join(dir, "turnlock.sqlite3");
    const runDb = openRunDatabase({
        driver: nodeSqliteDriver,
        dbPath,
        busyTimeoutMs: 500,
    });
    return {
        dir,
        runDb,
        cleanup: () => {
            runDb.close();
            cleanupTempDir(dir);
        },
    };
}
function acquire(runDb, nowEpoch = NOW_EPOCH) {
    return acquireOwnership({
        db: runDb.connection,
        runId: "01HX0000000000000000000001",
        orchestratorName: "test-refresh-release",
        nowEpochMs: nowEpoch,
        nowIso: NOW_ISO,
        leaseDurationMs: LEASE_MS,
        contentionDeadlineMs: CONTENTION_DEADLINE_MS,
        leaseClockEpochMs: () => nowEpoch,
    });
}
describe("ownership refresh", () => {
    test("valid refresh extends the lease", () => {
        const ctx = setup();
        try {
            const result = acquire(ctx.runDb);
            assert.strictEqual(result.kind, "ACQUIRED");
            if (result.kind !== "ACQUIRED")
                return;
            const handle = result.handle;
            const refreshResult = refreshOwnership({
                db: ctx.runDb.connection,
                handle,
                nowEpochMs: NOW_EPOCH + 10000,
                leaseClockEpochMs: () => NOW_EPOCH + 10000,
                leaseDurationMs: LEASE_MS,
            });
            assert.strictEqual(refreshResult.kind, "SUCCESS");
            if (refreshResult.kind !== "SUCCESS")
                return;
            assert.strictEqual(refreshResult.handle.leaseUntilEpochMs, NOW_EPOCH + 10000 + LEASE_MS);
            assert.strictEqual(refreshResult.handle.fenceToken, handle.fenceToken);
            assert.strictEqual(refreshResult.handle.ownerToken, handle.ownerToken);
        }
        finally {
            ctx.cleanup();
        }
    });
    test("stale handle is rejected", () => {
        const ctx = setup();
        try {
            const result = acquire(ctx.runDb);
            assert.strictEqual(result.kind, "ACQUIRED");
            if (result.kind !== "ACQUIRED")
                return;
            // Manually release (so the handle is stale).
            ctx.runDb.connection.exec(`UPDATE run_ownership
				 SET ownership_status = 'FREE',
				     owner_token = NULL,
				     owner_pid = NULL,
				     acquired_at_epoch_ms = NULL,
				     lease_until_epoch_ms = NULL
				 WHERE singleton = 1`);
            const refreshResult = refreshOwnership({
                db: ctx.runDb.connection,
                handle: result.handle,
                nowEpochMs: NOW_EPOCH,
                leaseClockEpochMs: () => NOW_EPOCH,
                leaseDurationMs: LEASE_MS,
            });
            assert.strictEqual(refreshResult.kind, "STALE_HANDLE");
        }
        finally {
            ctx.cleanup();
        }
    });
    test("expired handle is rejected", () => {
        const ctx = setup();
        try {
            const result = acquire(ctx.runDb, 0); // acquired at epoch 0
            assert.strictEqual(result.kind, "ACQUIRED");
            if (result.kind !== "ACQUIRED")
                return;
            // Try to refresh long after expiry.
            const refreshResult = refreshOwnership({
                db: ctx.runDb.connection,
                handle: result.handle,
                nowEpochMs: NOW_EPOCH,
                leaseClockEpochMs: () => NOW_EPOCH,
                leaseDurationMs: LEASE_MS,
            });
            assert.strictEqual(refreshResult.kind, "EXPIRED_HANDLE");
        }
        finally {
            ctx.cleanup();
        }
    });
});
describe("ownership release", () => {
    test("valid release sets FREE and preserves fenceToken", () => {
        const ctx = setup();
        try {
            const result = acquire(ctx.runDb);
            assert.strictEqual(result.kind, "ACQUIRED");
            if (result.kind !== "ACQUIRED")
                return;
            const fenceBefore = result.handle.fenceToken;
            const releaseResult = releaseOwnership({
                db: ctx.runDb.connection,
                handle: result.handle,
            });
            assert.strictEqual(releaseResult.kind, "SUCCESS");
            // Verify row is FREE but fenceToken unchanged.
            const row = ctx.runDb.connection
                .prepare("SELECT ownership_status, fence_token, owner_token FROM run_ownership WHERE singleton = 1")
                .get();
            assert.strictEqual(row.ownership_status, "FREE");
            assert.strictEqual(row.owner_token, null);
            assert.strictEqual(BigInt(row.fence_token), fenceBefore);
        }
        finally {
            ctx.cleanup();
        }
    });
    test("stale handle release is rejected", () => {
        const ctx = setup();
        try {
            const result = acquire(ctx.runDb);
            assert.strictEqual(result.kind, "ACQUIRED");
            if (result.kind !== "ACQUIRED")
                return;
            // Manually release first.
            ctx.runDb.connection.exec(`UPDATE run_ownership
				 SET ownership_status = 'FREE',
				     owner_token = NULL,
				     owner_pid = NULL,
				     acquired_at_epoch_ms = NULL,
				     lease_until_epoch_ms = NULL
				 WHERE singleton = 1`);
            const releaseResult = releaseOwnership({
                db: ctx.runDb.connection,
                handle: result.handle,
            });
            assert.strictEqual(releaseResult.kind, "STALE_HANDLE");
        }
        finally {
            ctx.cleanup();
        }
    });
    test("double release is rejected", () => {
        const ctx = setup();
        try {
            const result = acquire(ctx.runDb);
            assert.strictEqual(result.kind, "ACQUIRED");
            if (result.kind !== "ACQUIRED")
                return;
            const first = releaseOwnership({
                db: ctx.runDb.connection,
                handle: result.handle,
            });
            assert.strictEqual(first.kind, "SUCCESS");
            const second = releaseOwnership({
                db: ctx.runDb.connection,
                handle: result.handle,
            });
            assert.strictEqual(second.kind, "STALE_HANDLE");
        }
        finally {
            ctx.cleanup();
        }
    });
});
//# sourceMappingURL=ownership-refresh-release.test.js.map