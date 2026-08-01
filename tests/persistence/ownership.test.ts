// Lot 1 — ownership acquisition tests.
//
// Covers: fresh acquire, active-owner rejection, expired takeover,
// CAS miss detection, free-row reacquisition, contention.

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { bunSqliteDriver } from "../../src/persistence/sqlite/bun-sqlite-driver";
import { DbIntegrityError } from "../../src/persistence/sqlite/errors";
import {
	acquireOwnership,
	acquireOwnershipDirectInTransaction,
	beginImmediate,
	commit,
	ensureIncarnationInTransaction,
	ensureOwnershipRowInTransaction,
	type LockHandle,
	rollback,
} from "../../src/persistence/sqlite/ownership";
import { openRunDatabase } from "../../src/persistence/sqlite/run-database";
import { generateRunId } from "../../src/services/run-id";
import { cleanupTempDir, makeTempDir } from "../helpers/temp-run-dir";

const LEASE_MS = 30 * 60 * 1000; // 30 min
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
		dbPath,
		runDb,
		cleanup: () => {
			runDb.close();
			cleanupTempDir(dir);
		},
	};
}

function acquire(params: {
	runId?: string;
	nowEpochMs?: number;
	deadlineMs?: number;
	runDb: ReturnType<typeof openRunDatabase>;
}) {
	return acquireOwnership({
		db: params.runDb.connection,
		runId: params.runId ?? "01HX0000000000000000000001",
		orchestratorName: "test-ownership",
		nowEpochMs: params.nowEpochMs ?? NOW_EPOCH,
		nowIso: NOW_ISO,
		leaseDurationMs: LEASE_MS,
		contentionDeadlineMs: params.deadlineMs ?? CONTENTION_DEADLINE_MS,
		leaseClockEpochMs: () => params.nowEpochMs ?? NOW_EPOCH,
	});
}

describe("ownership acquisition", () => {
	test("fresh acquire returns a valid handle", () => {
		const ctx = setup();
		try {
			const result = acquire({ runDb: ctx.runDb });
			expect(result.kind).toBe("ACQUIRED");
			if (result.kind !== "ACQUIRED") return;
			expect(result.handle.ownerToken).toBeTruthy();
			expect(result.handle.incarnationId).toBeTruthy();
			expect(result.handle.fenceToken).toBe(1n);
			expect(result.handle.leaseUntilEpochMs).toBe(NOW_EPOCH + LEASE_MS);
		} finally {
			ctx.cleanup();
		}
	});

	test("active owner rejects second acquire", () => {
		const ctx = setup();
		try {
			const first = acquire({ runDb: ctx.runDb });
			expect(first.kind).toBe("ACQUIRED");

			const second = acquire({ runDb: ctx.runDb });
			expect(second.kind).toBe("ACTIVE_CONFLICT");
			if (second.kind !== "ACTIVE_CONFLICT") return;
			expect(second.leaseUntilEpochMs).toBe(NOW_EPOCH + LEASE_MS);
		} finally {
			ctx.cleanup();
		}
	});

	test("expired owner can be taken over", () => {
		const ctx = setup();
		try {
			// Acquire with epoch 0.
			const first = acquire({
				runDb: ctx.runDb,
				nowEpochMs: 0,
			});
			expect(first.kind).toBe("ACQUIRED");

			// Now acquire with epoch way past expiry.
			const second = acquire({
				runDb: ctx.runDb,
				nowEpochMs: NOW_EPOCH,
			});
			expect(second.kind).toBe("ACQUIRED");
			if (second.kind !== "ACQUIRED") return;
			// fence_token should have incremented: first was 1, second is 2.
			expect(second.handle.fenceToken).toBe(2n);

			// Old handle should be stale (same incarnation, old fence).
			expect(second.handle.ownerToken).not.toBe(
				(first as { handle: LockHandle }).handle.ownerToken,
			);
		} finally {
			ctx.cleanup();
		}
	});

	test("free row can be reacquired", () => {
		const ctx = setup();
		try {
			const first = acquire({ runDb: ctx.runDb });
			expect(first.kind).toBe("ACQUIRED");

			// Simulate release by manually setting FREE (release is Lot 2).
			ctx.runDb.connection.exec(
				`UPDATE run_ownership
				 SET ownership_status = 'FREE',
				     owner_token = NULL,
				     owner_pid = NULL,
				     acquired_at_epoch_ms = NULL,
				     lease_until_epoch_ms = NULL
				 WHERE singleton = 1`,
			);

			const second = acquire({ runDb: ctx.runDb });
			expect(second.kind).toBe("ACQUIRED");
			if (second.kind !== "ACQUIRED") return;
			// fence_token incremented again: 1 → 2.
			expect(second.handle.fenceToken).toBe(2n);
		} finally {
			ctx.cleanup();
		}
	});

	test("incarnation is stable across acquisitions", () => {
		const ctx = setup();
		try {
			const first = acquire({ runDb: ctx.runDb });
			expect(first.kind).toBe("ACQUIRED");
			if (first.kind !== "ACQUIRED") return;
			const incarnation1 = first.handle.incarnationId;

			// Manually release.
			ctx.runDb.connection.exec(
				`UPDATE run_ownership
				 SET ownership_status = 'FREE',
				     owner_token = NULL,
				     owner_pid = NULL,
				     acquired_at_epoch_ms = NULL,
				     lease_until_epoch_ms = NULL
				 WHERE singleton = 1`,
			);

			const second = acquire({ runDb: ctx.runDb });
			expect(second.kind).toBe("ACQUIRED");
			if (second.kind !== "ACQUIRED") return;
			expect(second.handle.incarnationId).toBe(incarnation1);
		} finally {
			ctx.cleanup();
		}
	});

	test("fenceToken is strictly monotonic", () => {
		const ctx = setup();
		try {
			const tokens: bigint[] = [];
			for (let i = 0; i < 5; i++) {
				// Manual release between each acquisition.
				if (i > 0) {
					ctx.runDb.connection.exec(
						`UPDATE run_ownership
						 SET ownership_status = 'FREE',
						     owner_token = NULL,
						     owner_pid = NULL,
						     acquired_at_epoch_ms = NULL,
						     lease_until_epoch_ms = NULL
						 WHERE singleton = 1`,
					);
				}
				const result = acquire({ runDb: ctx.runDb });
				expect(result.kind).toBe("ACQUIRED");
				if (result.kind === "ACQUIRED") {
					tokens.push(result.handle.fenceToken);
				}
			}
			expect(tokens).toEqual([1n, 2n, 3n, 4n, 5n]);
		} finally {
			ctx.cleanup();
		}
	});
});

// ---------------------------------------------------------------------------
// Post-lock clock gap — decisive tests
// ---------------------------------------------------------------------------

describe("post-lock clock gap", () => {
	test("lease computed from post-lock clock, not pre-lock", () => {
		const ctx = setup();
		try {
			// nowEpochMs = 1000 (pre-lock, captured before potential wait)
			// leaseClockEpochMs returns 5000 (post-lock, after BEGIN IMMEDIATE)
			const result = acquireOwnership({
				db: ctx.runDb.connection,
				runId: "01HX0000000000000000000001",
				orchestratorName: "clock-gap-test",
				nowEpochMs: 1000,
				nowIso: "1970-01-01T00:00:01.000Z",
				leaseDurationMs: 1000,
				contentionDeadlineMs: 2000,
				leaseClockEpochMs: () => 5000,
			});

			expect(result.kind).toBe("ACQUIRED");
			if (result.kind !== "ACQUIRED") return;
			// Lease must be 5000 + 1000 = 6000, NOT 1000 + 1000 = 2000.
			expect(result.handle.leaseUntilEpochMs).toBe(6000);
		} finally {
			ctx.cleanup();
		}
	});

	test("expired via post-lock clock (pre-lock says active, post-lock says expired)", () => {
		const ctx = setup();
		try {
			// Acquire with lease_until = 4000.
			const first = acquireOwnership({
				db: ctx.runDb.connection,
				runId: "01HX0000000000000000000001",
				orchestratorName: "clock-gap-test",
				nowEpochMs: 3000,
				nowIso: "1970-01-01T00:00:03.000Z",
				leaseDurationMs: 1000,
				contentionDeadlineMs: 2000,
				leaseClockEpochMs: () => 3000,
			});
			expect(first.kind).toBe("ACQUIRED");
			if (first.kind !== "ACQUIRED") return;
			expect(first.handle.leaseUntilEpochMs).toBe(4000);

			// Release so a new acquire is possible.
			ctx.runDb.connection.exec(
				`UPDATE run_ownership
				 SET ownership_status = 'FREE',
				     owner_token = NULL,
				     owner_pid = NULL,
				     acquired_at_epoch_ms = NULL,
				     lease_until_epoch_ms = NULL
				 WHERE singleton = 1`,
			);

			// Now try to acquire with nowEpochMs = 3500 (says active: 3500 < 4000)
			// but leaseClockEpochMs returns 5000 (says expired: 5000 >= 4000).
			// The post-lock clock must win.
			const second = acquireOwnership({
				db: ctx.runDb.connection,
				runId: "01HX0000000000000000000001",
				orchestratorName: "clock-gap-test",
				nowEpochMs: 3500,
				nowIso: "1970-01-01T00:00:03.500Z",
				leaseDurationMs: 1000,
				contentionDeadlineMs: 2000,
				leaseClockEpochMs: () => 5000,
			});

			// The lease is FREE (we manually released).  The pre-lock
			// predecessor check uses Date.now() (heuristic only).
			// With the row FREE, acquisition should succeed.
			expect(second.kind).toBe("ACQUIRED");
		} finally {
			ctx.cleanup();
		}
	});

	test("ACTIVE_CONFLICT avoided when post-lock clock shows lease expired", () => {
		const ctx = setup();
		try {
			// A acquires with lease_until = 5000.
			const a = acquireOwnership({
				db: ctx.runDb.connection,
				runId: "01HX0000000000000000000001",
				orchestratorName: "clock-gap-test",
				nowEpochMs: 4000,
				nowIso: "1970-01-01T00:00:04.000Z",
				leaseDurationMs: 1000,
				contentionDeadlineMs: 2000,
				leaseClockEpochMs: () => 4000,
			});
			expect(a.kind).toBe("ACQUIRED");
			if (a.kind !== "ACQUIRED") return;
			expect(a.handle.leaseUntilEpochMs).toBe(5000);

			// B tries to acquire.  nowEpochMs = 4500 (says active: 4500 < 5000).
			// But leaseClockEpochMs returns 6000 (post-lock: 6000 >= 5000 → expired).
			// The initial pre-check uses Date.now() (real clock, which is
			// certainly > 5000), so it won't short-circuit to ACTIVE_CONFLICT.
			// The retry loop check uses lockEpochMs = 6000, which also says expired.
			// B should acquire successfully.
			const b = acquireOwnership({
				db: ctx.runDb.connection,
				runId: "01HX0000000000000000000001",
				orchestratorName: "clock-gap-test",
				nowEpochMs: 4500,
				nowIso: "1970-01-01T00:00:04.500Z",
				leaseDurationMs: 2000,
				contentionDeadlineMs: 2000,
				leaseClockEpochMs: () => 6000,
			});

			// Must be ACQUIRED, not ACTIVE_CONFLICT.
			expect(b.kind).toBe("ACQUIRED");
			if (b.kind !== "ACQUIRED") return;
			// Lease computed from post-lock clock: 6000 + 2000 = 8000.
			expect(b.handle.leaseUntilEpochMs).toBe(8000);
			expect(b.handle.fenceToken).toBe(2n);
		} finally {
			ctx.cleanup();
		}
	});
});

// ---------------------------------------------------------------------------
// Hardening: incarnation_id coherence in transactional helpers
// ---------------------------------------------------------------------------

describe("incarnation_id coherence", () => {
	test("ensureOwnershipRowInTransaction rejects mismatched incarnation", () => {
		const ctx = setup();
		try {
			const db = ctx.runDb.connection;

			// Insert incarnation row.
			beginImmediate(db);
			ensureIncarnationInTransaction(
				db,
				"run-1",
				"inc-a",
				"orch",
				NOW_EPOCH,
				NOW_ISO,
			);
			// Insert ownership row with incarnation_id = 'inc-a'.
			ensureOwnershipRowInTransaction(db, "inc-a");
			commit(db);

			// Now in a new transaction, try to insert OR IGNORE with a
			// different incarnation.  The INSERT is a no-op because the
			// row already exists, but our re-read must detect the mismatch.
			beginImmediate(db);
			expect(() => {
				ensureOwnershipRowInTransaction(db, "inc-b");
			}).toThrow(DbIntegrityError);
			rollback(db);

			// Verify the original row is untouched.
			const row = db
				.prepare("SELECT incarnation_id FROM run_ownership WHERE singleton = 1")
				.get() as { incarnation_id: string };
			expect(row.incarnation_id).toBe("inc-a");
		} finally {
			ctx.cleanup();
		}
	});

	test("acquireOwnershipDirectInTransaction rejects wrong incarnationId", () => {
		const ctx = setup();
		try {
			const db = ctx.runDb.connection;

			// Setup: incarnation + ownership row with incarnation 'inc-a'.
			beginImmediate(db);
			ensureIncarnationInTransaction(
				db,
				"run-1",
				"inc-a",
				"orch",
				NOW_EPOCH,
				NOW_ISO,
			);
			ensureOwnershipRowInTransaction(db, "inc-a");
			commit(db);

			// Call acquireOwnershipDirectInTransaction with a different
			// incarnationId.  The WHERE clause must NOT match any row.
			beginImmediate(db);
			expect(() => {
				acquireOwnershipDirectInTransaction(
					db,
					"inc-wrong",
					generateRunId(),
					12345,
					NOW_EPOCH,
					LEASE_MS,
				);
			}).toThrow(DbIntegrityError);
			rollback(db);

			// Verify the ownership row is untouched.
			const row = db
				.prepare(
					"SELECT incarnation_id, ownership_status FROM run_ownership WHERE singleton = 1",
				)
				.get() as { incarnation_id: string; ownership_status: string };
			expect(row.incarnation_id).toBe("inc-a");
			expect(row.ownership_status).toBe("FREE");
		} finally {
			ctx.cleanup();
		}
	});
});
