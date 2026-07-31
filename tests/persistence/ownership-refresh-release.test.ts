// Lot 2 — ownership refresh and release tests.
//
// Covers: valid refresh, stale handle rejection, expired handle,
// valid release, double release, fenceToken preservation.

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { bunSqliteDriver } from "../../src/persistence/sqlite/bun-sqlite-driver";
import {
	acquireOwnership,
	refreshOwnership,
	releaseOwnership,
} from "../../src/persistence/sqlite/ownership";
import { openRunDatabase } from "../../src/persistence/sqlite/run-database";
import { cleanupTempDir, makeTempDir } from "../helpers/temp-run-dir";

const LEASE_MS = 30 * 60 * 1000;
const CONTENTION_DEADLINE_MS = 2_000;
const NOW_EPOCH = 1_000_000_000_000;
const NOW_ISO = "2001-09-09T01:46:40.000Z";

function setup() {
	const dir = makeTempDir();
	const dbPath = join(dir, "turnlock.sqlite3");
	const runDb = openRunDatabase({
		driver: bunSqliteDriver,
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

function acquire(
	runDb: ReturnType<typeof openRunDatabase>,
	nowEpoch = NOW_EPOCH,
) {
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
			expect(result.kind).toBe("ACQUIRED");
			if (result.kind !== "ACQUIRED") return;
			const handle = result.handle;

			const refreshResult = refreshOwnership({
				db: ctx.runDb.connection,
				handle,
				nowEpochMs: NOW_EPOCH + 10_000,
				leaseClockEpochMs: () => NOW_EPOCH + 10_000,
				leaseDurationMs: LEASE_MS,
			});
			expect(refreshResult.kind).toBe("SUCCESS");
			if (refreshResult.kind !== "SUCCESS") return;
			expect(refreshResult.handle.leaseUntilEpochMs).toBe(
				NOW_EPOCH + 10_000 + LEASE_MS,
			);
			expect(refreshResult.handle.fenceToken).toBe(handle.fenceToken);
			expect(refreshResult.handle.ownerToken).toBe(handle.ownerToken);
		} finally {
			ctx.cleanup();
		}
	});

	test("stale handle is rejected", () => {
		const ctx = setup();
		try {
			const result = acquire(ctx.runDb);
			expect(result.kind).toBe("ACQUIRED");
			if (result.kind !== "ACQUIRED") return;

			// Manually release (so the handle is stale).
			ctx.runDb.connection.exec(
				`UPDATE run_ownership
				 SET ownership_status = 'FREE',
				     owner_token = NULL,
				     owner_pid = NULL,
				     acquired_at_epoch_ms = NULL,
				     lease_until_epoch_ms = NULL
				 WHERE singleton = 1`,
			);

			const refreshResult = refreshOwnership({
				db: ctx.runDb.connection,
				handle: result.handle,
				nowEpochMs: NOW_EPOCH,
				leaseClockEpochMs: () => NOW_EPOCH,
				leaseDurationMs: LEASE_MS,
			});
			expect(refreshResult.kind).toBe("STALE_HANDLE");
		} finally {
			ctx.cleanup();
		}
	});

	test("expired handle is rejected", () => {
		const ctx = setup();
		try {
			const result = acquire(ctx.runDb, 0); // acquired at epoch 0
			expect(result.kind).toBe("ACQUIRED");
			if (result.kind !== "ACQUIRED") return;

			// Try to refresh long after expiry.
			const refreshResult = refreshOwnership({
				db: ctx.runDb.connection,
				handle: result.handle,
				nowEpochMs: NOW_EPOCH,
				leaseClockEpochMs: () => NOW_EPOCH,
				leaseDurationMs: LEASE_MS,
			});
			expect(refreshResult.kind).toBe("EXPIRED_HANDLE");
		} finally {
			ctx.cleanup();
		}
	});
});

describe("ownership release", () => {
	test("valid release sets FREE and preserves fenceToken", () => {
		const ctx = setup();
		try {
			const result = acquire(ctx.runDb);
			expect(result.kind).toBe("ACQUIRED");
			if (result.kind !== "ACQUIRED") return;

			const fenceBefore = result.handle.fenceToken;

			const releaseResult = releaseOwnership({
				db: ctx.runDb.connection,
				handle: result.handle,
			});
			expect(releaseResult.kind).toBe("SUCCESS");

			// Verify row is FREE but fenceToken unchanged.
			const row = ctx.runDb.connection
				.prepare(
					"SELECT ownership_status, fence_token, owner_token FROM run_ownership WHERE singleton = 1",
				)
				.get() as {
				ownership_status: string;
				fence_token: number;
				owner_token: string | null;
			};
			expect(row.ownership_status).toBe("FREE");
			expect(row.owner_token).toBeNull();
			expect(BigInt(row.fence_token)).toBe(fenceBefore);
		} finally {
			ctx.cleanup();
		}
	});

	test("stale handle release is rejected", () => {
		const ctx = setup();
		try {
			const result = acquire(ctx.runDb);
			expect(result.kind).toBe("ACQUIRED");
			if (result.kind !== "ACQUIRED") return;

			// Manually release first.
			ctx.runDb.connection.exec(
				`UPDATE run_ownership
				 SET ownership_status = 'FREE',
				     owner_token = NULL,
				     owner_pid = NULL,
				     acquired_at_epoch_ms = NULL,
				     lease_until_epoch_ms = NULL
				 WHERE singleton = 1`,
			);

			const releaseResult = releaseOwnership({
				db: ctx.runDb.connection,
				handle: result.handle,
			});
			expect(releaseResult.kind).toBe("STALE_HANDLE");
		} finally {
			ctx.cleanup();
		}
	});

	test("double release is rejected", () => {
		const ctx = setup();
		try {
			const result = acquire(ctx.runDb);
			expect(result.kind).toBe("ACQUIRED");
			if (result.kind !== "ACQUIRED") return;

			const first = releaseOwnership({
				db: ctx.runDb.connection,
				handle: result.handle,
			});
			expect(first.kind).toBe("SUCCESS");

			const second = releaseOwnership({
				db: ctx.runDb.connection,
				handle: result.handle,
			});
			expect(second.kind).toBe("STALE_HANDLE");
		} finally {
			ctx.cleanup();
		}
	});
});
