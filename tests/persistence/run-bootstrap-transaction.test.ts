import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { executeBootstrapTransaction } from "../../src/persistence/sqlite/run-bootstrap-transaction.js";
import type { SqliteConnection } from "../../src/persistence/sqlite/sqlite-driver.js";

function connectionBusyFor(beginFailures: number): {
	readonly connection: SqliteConnection;
	readonly beginAttempts: () => number;
} {
	let attempts = 0;
	const connection: SqliteConnection = {
		exec(sql: string): void {
			if (sql === "BEGIN IMMEDIATE") {
				attempts++;
				if (attempts <= beginFailures) throw new Error("SQLITE_BUSY");
			}
		},
		prepare: () => {
			throw new Error("prepare is not used by this test");
		},
		close: () => undefined,
	};
	return { connection, beginAttempts: () => attempts };
}

describe("shared bootstrap transaction", () => {
	test("retries SQLITE_BUSY until the contention deadline, not an attempt cap", () => {
		const fake = connectionBusyFor(12);
		const result = executeBootstrapTransaction(
			{
				db: fake.connection,
				contentionDeadlineMs: 1_000,
				leaseClockEpochMs: () => 1_000,
				dependencies: { generateId: () => "unused" },
			},
			() => "committed",
		);
		assert.deepStrictEqual(result, {
			kind: "COMMITTED",
			value: "committed",
		});
		assert.strictEqual(fake.beginAttempts(), 13);
	});
});
