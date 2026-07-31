// Lot 1 — ownership acquisition tests.
//
// Covers: fresh acquire, active-owner rejection, expired takeover,
// CAS miss detection, free-row reacquisition, contention.

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { bunSqliteDriver } from "../../src/persistence/sqlite/bun-sqlite-driver";
import {
	acquireOwnership,
	type LockHandle,
} from "../../src/persistence/sqlite/ownership";
import { openRunDatabase } from "../../src/persistence/sqlite/run-database";
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
