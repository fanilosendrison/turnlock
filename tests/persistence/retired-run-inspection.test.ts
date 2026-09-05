import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
// Strict read-only retired payload inspection.
//
// The retired/recovery phase never opens a retired payload database
// through the normal creating/migrating path.  Inspection is strictly
// read-only: missing databases stay missing, no file is created, no
// schema DDL, no migration, no pragma mutation ever runs.
import { describe, test } from "node:test";
import { STATE_SCHEMA_VERSION } from "../../src/constants.js";
import { nodeSqliteDriver } from "../../src/persistence/sqlite/node-sqlite-driver.js";
import { claimRunForRetentionDeletion } from "../../src/persistence/sqlite/retention-claim.js";
import { inspectRetiredRunAuthority } from "../../src/persistence/sqlite/retired-run-inspection.js";
import { bootstrapNewRunAtomic } from "../../src/persistence/sqlite/run-bootstrap.js";
import { openRunDatabase } from "../../src/persistence/sqlite/run-database.js";
import { cleanupTempDir, makeTempDir } from "../helpers/temp-run-dir.js";

const RUN_ID = "01HX000000000000000000000B";
const ORCHESTRATOR_NAME = "inspection-orch";

function bootstrap(runDir: string) {
	mkdirSync(runDir, { recursive: true });
	const dbPath = join(runDir, "turnlock.sqlite3");
	const runDb = openRunDatabase({
		driver: nodeSqliteDriver,
		dbPath,
		busyTimeoutMs: 2000,
	});
	const now = Date.now();
	const iso = new Date(now).toISOString();
	const result = bootstrapNewRunAtomic({
		db: runDb.connection,
		runId: RUN_ID,
		orchestratorName: ORCHESTRATOR_NAME,
		nowEpochMs: now,
		nowIso: iso,
		leaseDurationMs: 30 * 60 * 1000,
		initialState: {
			schemaVersion: STATE_SCHEMA_VERSION,
			runId: RUN_ID,
			orchestratorName: ORCHESTRATOR_NAME,
			startedAt: iso,
			startedAtEpochMs: now,
			lastTransitionAt: iso,
			lastTransitionAtEpochMs: now,
			currentPhase: "start",
			phasesExecuted: 0,
			accumulatedDurationMs: 0,
			data: {},
			usedLabels: [],
		},
		stateSchemaVersion: STATE_SCHEMA_VERSION,
		contentionDeadlineMs: 5000,
	});
	runDb.close();
	assert.strictEqual(result.kind, "BOOTSTRAPPED");
	return dbPath;
}

function claim(runDir: string) {
	return claimRunForRetentionDeletion({
		driver: nodeSqliteDriver,
		dbPath: join(runDir, "turnlock.sqlite3"),
		runId: RUN_ID,
		busyTimeoutMs: 2000,
		contentionDeadlineMs: 5000,
	});
}

describe("inspectRetiredRunAuthority", () => {
	test("RETIRING + matching token + released ownership → VALID_RETIRING", () => {
		const dir = makeTempDir();
		try {
			const dbPath = bootstrap(dir);
			// Expire the lease so the claim succeeds.
			const db = nodeSqliteDriver.open(dbPath);
			db.exec(
				`UPDATE run_ownership SET lease_until_epoch_ms = ${Date.now() - 1000} WHERE singleton = 1`,
			);
			db.close();
			const claimResult = claim(dir);
			assert.strictEqual(claimResult.kind, "CLAIMED");
			if (claimResult.kind !== "CLAIMED") throw new Error("setup");
			const inspection = inspectRetiredRunAuthority({
				driver: nodeSqliteDriver,
				dbPath,
				expectedRunId: RUN_ID,
				expectedRetirementToken: claimResult.retirementToken,
				expectedIncarnationId: claimResult.incarnationId,
			});
			assert.strictEqual(inspection.kind, "VALID_RETIRING");
			if (inspection.kind === "VALID_RETIRING") {
				assert.strictEqual(inspection.runId, RUN_ID);
				assert.strictEqual(inspection.orchestratorName, ORCHESTRATOR_NAME);
				assert.strictEqual(inspection.incarnationId, claimResult.incarnationId);
				assert.strictEqual(
					inspection.retirementToken,
					claimResult.retirementToken,
				);
				assert.ok(inspection.retirementClaimedAtEpochMs > 0);
			}
		} finally {
			cleanupTempDir(dir);
		}
	});

	test("ACTIVE retention (unclaimed) → INVALID", () => {
		const dir = makeTempDir();
		try {
			const dbPath = bootstrap(dir);
			const inspection = inspectRetiredRunAuthority({
				driver: nodeSqliteDriver,
				dbPath,
				expectedRunId: RUN_ID,
				expectedRetirementToken: "01HX0000000000000000000000",
			});
			assert.strictEqual(inspection.kind, "INVALID");
		} finally {
			cleanupTempDir(dir);
		}
	});

	test("runId mismatch → INVALID", () => {
		const dir = makeTempDir();
		try {
			const dbPath = bootstrap(dir);
			const claimResult = claim(dir);
			assert.strictEqual(claimResult.kind, "LIVE_OWNER");
			const inspection = inspectRetiredRunAuthority({
				driver: nodeSqliteDriver,
				dbPath,
				expectedRunId: "01HX000000000000000000000C",
				expectedRetirementToken: "01HX0000000000000000000000",
			});
			assert.strictEqual(inspection.kind, "INVALID");
			if (inspection.kind === "INVALID") {
				assert.match(inspection.reason, /identity mismatch/);
			}
		} finally {
			cleanupTempDir(dir);
		}
	});

	test("token mismatch → INVALID", () => {
		const dir = makeTempDir();
		try {
			const dbPath = bootstrap(dir);
			const db = nodeSqliteDriver.open(dbPath);
			db.exec(
				`UPDATE run_ownership SET lease_until_epoch_ms = ${Date.now() - 1000} WHERE singleton = 1`,
			);
			db.close();
			const claimResult = claim(dir);
			assert.strictEqual(claimResult.kind, "CLAIMED");
			const inspection = inspectRetiredRunAuthority({
				driver: nodeSqliteDriver,
				dbPath,
				expectedRunId: RUN_ID,
				expectedRetirementToken: "01HX0000000000000000000000",
			});
			assert.strictEqual(inspection.kind, "INVALID");
		} finally {
			cleanupTempDir(dir);
		}
	});

	test("orchestrator mismatch → INVALID", () => {
		const dir = makeTempDir();
		try {
			const dbPath = bootstrap(dir);
			const db = nodeSqliteDriver.open(dbPath);
			db.exec(
				`UPDATE run_ownership SET lease_until_epoch_ms = ${Date.now() - 1000} WHERE singleton = 1`,
			);
			db.close();
			const claimResult = claim(dir);
			assert.strictEqual(claimResult.kind, "CLAIMED");
			if (claimResult.kind !== "CLAIMED") throw new Error("setup");
			const inspection = inspectRetiredRunAuthority({
				driver: nodeSqliteDriver,
				dbPath,
				expectedRunId: RUN_ID,
				expectedOrchestratorName: "foreign-orchestrator",
				expectedRetirementToken: claimResult.retirementToken,
			});
			assert.strictEqual(inspection.kind, "INVALID");
			if (inspection.kind === "INVALID") {
				assert.match(inspection.reason, /orchestrator mismatch/);
			}
		} finally {
			cleanupTempDir(dir);
		}
	});

	test("incarnation mismatch → INVALID", () => {
		const dir = makeTempDir();
		try {
			const dbPath = bootstrap(dir);
			const db = nodeSqliteDriver.open(dbPath);
			db.exec(
				`UPDATE run_ownership SET lease_until_epoch_ms = ${Date.now() - 1000} WHERE singleton = 1`,
			);
			db.close();
			const claimResult = claim(dir);
			assert.strictEqual(claimResult.kind, "CLAIMED");
			if (claimResult.kind !== "CLAIMED") throw new Error("setup");
			const inspection = inspectRetiredRunAuthority({
				driver: nodeSqliteDriver,
				dbPath,
				expectedRunId: RUN_ID,
				expectedRetirementToken: claimResult.retirementToken,
				expectedIncarnationId: "01HX0000000000000000000000",
			});
			assert.strictEqual(inspection.kind, "INVALID");
		} finally {
			cleanupTempDir(dir);
		}
	});

	test("RETIRING with ownership bound to another incarnation → INVALID", () => {
		const dir = makeTempDir();
		try {
			const dbPath = bootstrap(dir);
			const db = nodeSqliteDriver.open(dbPath);
			db.exec(
				`UPDATE run_ownership SET lease_until_epoch_ms = ${Date.now() - 1000} WHERE singleton = 1`,
			);
			db.close();
			const claimResult = claim(dir);
			assert.strictEqual(claimResult.kind, "CLAIMED");
			if (claimResult.kind !== "CLAIMED") throw new Error("setup");
			// Deliberately corrupt the relationship while foreign-key checks
			// are disabled on this adversarial connection.
			const mutate = nodeSqliteDriver.open(dbPath);
			mutate.exec("PRAGMA foreign_keys = OFF");
			mutate.exec(
				`UPDATE run_ownership SET incarnation_id = 'foreign-incarnation' WHERE singleton = 1`,
			);
			mutate.close();
			const inspection = inspectRetiredRunAuthority({
				driver: nodeSqliteDriver,
				dbPath,
				expectedRunId: RUN_ID,
				expectedRetirementToken: claimResult.retirementToken,
			});
			assert.strictEqual(inspection.kind, "INVALID");
		} finally {
			cleanupTempDir(dir);
		}
	});

	test("RETIRING but ownership still HELD → INVALID", () => {
		const dir = makeTempDir();
		try {
			const dbPath = bootstrap(dir);
			const db = nodeSqliteDriver.open(dbPath);
			db.exec(
				`UPDATE run_ownership SET lease_until_epoch_ms = ${Date.now() - 1000} WHERE singleton = 1`,
			);
			db.close();
			const claimResult = claim(dir);
			assert.strictEqual(claimResult.kind, "CLAIMED");
			if (claimResult.kind !== "CLAIMED") throw new Error("setup");
			// Adversarially resurrect a HELD live owner — incoherent state.
			const mutate = nodeSqliteDriver.open(dbPath);
			mutate.exec(
				`UPDATE run_ownership SET ownership_status = 'HELD', owner_token = 'ghost', owner_pid = 1, acquired_at_epoch_ms = ${Date.now()}, lease_until_epoch_ms = ${Date.now() + 3600000} WHERE singleton = 1`,
			);
			mutate.close();
			const inspection = inspectRetiredRunAuthority({
				driver: nodeSqliteDriver,
				dbPath,
				expectedRunId: RUN_ID,
				expectedRetirementToken: claimResult.retirementToken,
			});
			assert.strictEqual(inspection.kind, "INVALID");
		} finally {
			cleanupTempDir(dir);
		}
	});

	test("schema version mismatch → INVALID", () => {
		const dir = makeTempDir();
		try {
			const dbPath = bootstrap(dir);
			const db = nodeSqliteDriver.open(dbPath);
			db.exec(
				"UPDATE schema_metadata SET schema_version = 999 WHERE singleton = 1",
			);
			db.close();
			const inspection = inspectRetiredRunAuthority({
				driver: nodeSqliteDriver,
				dbPath,
				expectedRunId: RUN_ID,
				expectedRetirementToken: "01HX0000000000000000000000",
			});
			assert.strictEqual(inspection.kind, "INVALID");
		} finally {
			cleanupTempDir(dir);
		}
	});

	test("missing DB → UNREADABLE, filesystem unchanged, DB still absent", () => {
		const dir = makeTempDir();
		try {
			const dbPath = join(dir, "turnlock.sqlite3");
			const before = existsSync(dbPath);
			assert.strictEqual(before, false);
			const inspection = inspectRetiredRunAuthority({
				driver: nodeSqliteDriver,
				dbPath,
				expectedRunId: RUN_ID,
				expectedRetirementToken: "01HX0000000000000000000000",
			});
			assert.strictEqual(inspection.kind, "UNREADABLE");
			// NO new SQLite file created by the inspection.
			assert.strictEqual(
				existsSync(dbPath),
				false,
				"inspection must never create the database file",
			);
		} finally {
			cleanupTempDir(dir);
		}
	});

	test("corrupt DB → UNREADABLE", () => {
		const dir = makeTempDir();
		try {
			const dbPath = join(dir, "turnlock.sqlite3");
			writeFileSync(dbPath, "not a sqlite database");
			const inspection = inspectRetiredRunAuthority({
				driver: nodeSqliteDriver,
				dbPath,
				expectedRunId: RUN_ID,
				expectedRetirementToken: "01HX0000000000000000000000",
			});
			assert.strictEqual(inspection.kind, "UNREADABLE");
		} finally {
			cleanupTempDir(dir);
		}
	});
});
