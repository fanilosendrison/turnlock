import assert from "node:assert/strict";
import {
	existsSync,
	mkdirSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
// Durable retirement READY journal — marker schema, atomic publication,
// idempotence, corruption handling, and the two-phase recovery sweep.
import { describe, test } from "node:test";
import { STATE_SCHEMA_VERSION } from "../../src/constants.js";
import { nodeSqliteDriver } from "../../src/persistence/sqlite/node-sqlite-driver.js";
import { claimRunForRetentionDeletion } from "../../src/persistence/sqlite/retention-claim.js";
import { bootstrapNewRunAtomic } from "../../src/persistence/sqlite/run-bootstrap.js";
import { openRunDatabase } from "../../src/persistence/sqlite/run-database.js";
import {
	captureRetiredPayloadIdentity,
	parseRetirementReadyMarker,
	publishRetirementReadyMarker,
	RETIRED_PAYLOAD_DIR_NAME,
	RETIRED_READY_DIR_NAME,
	type RetirementReadyMarkerV1,
	readRetirementReadyMarker,
	retiredDirectoryName,
	serializeRetirementReadyMarker,
	sweepReadyRetirementMarkers,
	sweepUnreadyRetiredPayloads,
} from "../../src/services/retirement-journal.js";
import { cleanupTempDir, makeTempDir } from "../helpers/temp-run-dir.js";

const RUN_ID = "01HX000000000000000000000B";
const ORCHESTRATOR_NAME = "journal-orch";
const TOKEN = "01HX000000000000000000000C";

function buildMarker(
	overrides: Partial<RetirementReadyMarkerV1> = {},
): RetirementReadyMarkerV1 {
	return {
		version: 1,
		orchestratorName: ORCHESTRATOR_NAME,
		runId: RUN_ID,
		incarnationId: "01HX000000000000000000000D",
		retirementToken: TOKEN,
		retirementClaimedAtEpochMs: 1234567890,
		retiredEntryName: retiredDirectoryName(RUN_ID, TOKEN),
		payloadIdentity: { dev: "16777220", ino: "42424242" },
		...overrides,
	};
}

/** Build a genuine retired payload: bootstrap, expire lease, claim, then
 *  move the directory into the .retired/payload structure. */
function makeRetiredPayload(root: string): {
	retiredRoot: string;
	payloadPath: string;
	entryName: string;
	dbPath: string;
} {
	const runDirRoot = join(root, "runs");
	const runDir = join(runDirRoot, ORCHESTRATOR_NAME, RUN_ID);
	mkdirSync(runDir, { recursive: true });
	const dbPath = join(runDir, "turnlock.sqlite3");
	const runDb = openRunDatabase({
		driver: nodeSqliteDriver,
		dbPath,
		busyTimeoutMs: 2000,
	});
	const now = Date.now();
	const iso = new Date(now).toISOString();
	const bootstrapped = bootstrapNewRunAtomic({
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
	assert.strictEqual(bootstrapped.kind, "BOOTSTRAPPED");
	runDb.connection.exec(
		`UPDATE run_ownership SET lease_until_epoch_ms = ${Date.now() - 1000} WHERE singleton = 1`,
	);
	runDb.close();
	const claim = claimRunForRetentionDeletion({
		driver: nodeSqliteDriver,
		dbPath,
		runId: RUN_ID,
		busyTimeoutMs: 2000,
		contentionDeadlineMs: 5000,
	});
	assert.strictEqual(claim.kind, "CLAIMED");
	if (claim.kind !== "CLAIMED") throw new Error("setup");
	const retiredRoot = join(runDirRoot, ORCHESTRATOR_NAME, ".retired");
	const payloadDir = join(retiredRoot, RETIRED_PAYLOAD_DIR_NAME);
	mkdirSync(payloadDir, { recursive: true });
	const entryName = retiredDirectoryName(RUN_ID, claim.retirementToken);
	const payloadPath = join(payloadDir, entryName);
	renameSync(runDir, payloadPath);
	return {
		retiredRoot,
		payloadPath,
		entryName,
		dbPath: join(payloadPath, "turnlock.sqlite3"),
	};
}

function markerForPayload(
	payloadPath: string,
	entryName: string,
	token: string,
	incarnationId: string,
	claimedAt: number,
	orchestratorName: string,
): RetirementReadyMarkerV1 {
	const identity = captureRetiredPayloadIdentity(payloadPath);
	assert.ok(identity, "payload identity must be capturable");
	return {
		version: 1,
		orchestratorName,
		runId: RUN_ID,
		incarnationId,
		retirementToken: token,
		retirementClaimedAtEpochMs: claimedAt,
		retiredEntryName: entryName,
		payloadIdentity: identity,
	};
}

describe("retirement READY journal — markers", () => {
	test("publish → PUBLISHED, durable file, readable back", () => {
		const root = makeTempDir();
		try {
			const retiredRoot = join(root, ".retired");
			const marker = buildMarker();
			const result = publishRetirementReadyMarker({ retiredRoot, marker });
			assert.strictEqual(result.kind, "PUBLISHED");
			const markerPath = join(
				retiredRoot,
				RETIRED_READY_DIR_NAME,
				`${marker.retiredEntryName}.json`,
			);
			assert.strictEqual(existsSync(markerPath), true);
			const read = readRetirementReadyMarker({
				retiredRoot,
				entryName: marker.retiredEntryName,
			});
			assert.deepStrictEqual(read, marker);
		} finally {
			cleanupTempDir(root);
		}
	});

	test("re-publish identical marker → ALREADY_PUBLISHED_IDENTICAL (idempotent)", () => {
		const root = makeTempDir();
		try {
			const retiredRoot = join(root, ".retired");
			const marker = buildMarker();
			assert.strictEqual(
				publishRetirementReadyMarker({ retiredRoot, marker }).kind,
				"PUBLISHED",
			);
			assert.strictEqual(
				publishRetirementReadyMarker({ retiredRoot, marker }).kind,
				"ALREADY_PUBLISHED_IDENTICAL",
			);
		} finally {
			cleanupTempDir(root);
		}
	});

	test("different marker at same path → CONFLICT (never overwrite)", () => {
		const root = makeTempDir();
		try {
			const retiredRoot = join(root, ".retired");
			const first = buildMarker();
			assert.strictEqual(
				publishRetirementReadyMarker({ retiredRoot, marker: first }).kind,
				"PUBLISHED",
			);
			const second = buildMarker({ retirementClaimedAtEpochMs: 999 });
			assert.strictEqual(
				publishRetirementReadyMarker({ retiredRoot, marker: second }).kind,
				"CONFLICT",
			);
			// The original marker is untouched.
			const read = readRetirementReadyMarker({
				retiredRoot,
				entryName: first.retiredEntryName,
			});
			assert.deepStrictEqual(read, first);
		} finally {
			cleanupTempDir(root);
		}
	});

	test("malformed marker shapes are rejected by the parser", () => {
		assert.strictEqual(parseRetirementReadyMarker("not json"), null);
		assert.strictEqual(parseRetirementReadyMarker('{"version":1}'), null);
		assert.strictEqual(
			parseRetirementReadyMarker(
				serializeRetirementReadyMarker(buildMarker({ version: 2 as 1 })),
			),
			null,
		);
		assert.strictEqual(
			parseRetirementReadyMarker(
				serializeRetirementReadyMarker(
					buildMarker({ runId: "01HX000000000000000000000E" }),
				),
			),
			null,
		);
		assert.strictEqual(
			parseRetirementReadyMarker(
				serializeRetirementReadyMarker(
					buildMarker({ retirementToken: "01HX000000000000000000000E" }),
				),
			),
			null,
		);
		assert.strictEqual(
			parseRetirementReadyMarker(
				serializeRetirementReadyMarker(
					buildMarker({
						retiredEntryName: retiredDirectoryName(
							RUN_ID,
							"01HX000000000000000000000E",
						),
					}),
				),
			),
			null,
		);
		assert.strictEqual(
			parseRetirementReadyMarker(
				serializeRetirementReadyMarker(
					buildMarker({ payloadIdentity: { dev: "x", ino: "1" } }),
				),
			),
			null,
		);
	});
});

describe("retirement READY journal — recovery sweep", () => {
	test("READY + identity match → payload deleted without opening the DB, marker removed", () => {
		const root = makeTempDir();
		try {
			const { retiredRoot, payloadPath, entryName } = makeRetiredPayload(root);
			const probe = nodeSqliteDriver.openReadOnly(
				join(payloadPath, "turnlock.sqlite3"),
			);
			const incarnationRow = probe
				.prepare(
					"SELECT incarnation_id FROM run_incarnation WHERE singleton = 1",
				)
				.get() as { incarnation_id: string } | undefined;
			const retentionRow = probe
				.prepare(
					"SELECT retirement_token, retirement_claimed_at_epoch_ms FROM run_retention WHERE singleton = 1",
				)
				.get() as
				| {
						retirement_token: string;
						retirement_claimed_at_epoch_ms: number;
				  }
				| undefined;
			probe.close();
			assert.ok(incarnationRow && retentionRow, "setup: inspectable DB");
			const marker = markerForPayload(
				payloadPath,
				entryName,
				retentionRow.retirement_token,
				incarnationRow.incarnation_id,
				retentionRow.retirement_claimed_at_epoch_ms,
				ORCHESTRATOR_NAME,
			);
			assert.strictEqual(
				publishRetirementReadyMarker({ retiredRoot, marker }).kind,
				"PUBLISHED",
			);
			const completed = sweepReadyRetirementMarkers({
				retiredRoot,
				orchestratorName: ORCHESTRATOR_NAME,
			});
			assert.strictEqual(completed, 1);
			assert.strictEqual(existsSync(payloadPath), false);
			assert.strictEqual(
				existsSync(
					join(retiredRoot, RETIRED_READY_DIR_NAME, `${entryName}.json`),
				),
				false,
			);
		} finally {
			cleanupTempDir(root);
		}
	});

	test("READY + payload absent → leftover marker removed", () => {
		const root = makeTempDir();
		try {
			const retiredRoot = join(root, ".retired");
			const marker = buildMarker();
			assert.strictEqual(
				publishRetirementReadyMarker({ retiredRoot, marker }).kind,
				"PUBLISHED",
			);
			const completed = sweepReadyRetirementMarkers({
				retiredRoot,
				orchestratorName: ORCHESTRATOR_NAME,
			});
			assert.strictEqual(completed, 1);
			assert.strictEqual(
				existsSync(
					join(
						retiredRoot,
						RETIRED_READY_DIR_NAME,
						`${marker.retiredEntryName}.json`,
					),
				),
				false,
			);
		} finally {
			cleanupTempDir(root);
		}
	});

	test("READY + payload identity mismatch → KEEP (payload and marker untouched)", () => {
		const root = makeTempDir();
		try {
			const retiredRoot = join(root, ".retired");
			const payloadDir = join(retiredRoot, RETIRED_PAYLOAD_DIR_NAME);
			mkdirSync(payloadDir, { recursive: true });
			const marker = buildMarker(); // fake identity — never matches
			// A REAL payload exists at the marker-derived path, but its
			// dev/ino cannot match the marker's fabricated identity.
			const payloadPath = join(payloadDir, marker.retiredEntryName);
			mkdirSync(payloadPath);
			assert.strictEqual(
				publishRetirementReadyMarker({ retiredRoot, marker }).kind,
				"PUBLISHED",
			);
			const completed = sweepReadyRetirementMarkers({
				retiredRoot,
				orchestratorName: ORCHESTRATOR_NAME,
			});
			assert.strictEqual(completed, 0);
			assert.strictEqual(existsSync(payloadPath), true);
			assert.strictEqual(
				existsSync(
					join(
						retiredRoot,
						RETIRED_READY_DIR_NAME,
						`${marker.retiredEntryName}.json`,
					),
				),
				true,
			);
		} finally {
			cleanupTempDir(root);
		}
	});

	test("malformed READY marker (wrong version) → KEEP", () => {
		const root = makeTempDir();
		try {
			const { retiredRoot, payloadPath, entryName } = makeRetiredPayload(root);
			const marker = markerForPayload(
				payloadPath,
				entryName,
				"01HX000000000000000000000C",
				"01HX000000000000000000000D",
				123,
				ORCHESTRATOR_NAME,
			);
			const readyDir = join(retiredRoot, RETIRED_READY_DIR_NAME);
			mkdirSync(readyDir, { recursive: true });
			const markerPath = join(readyDir, `${entryName}.json`);
			const bad = JSON.parse(serializeRetirementReadyMarker(marker)) as Record<
				string,
				unknown
			>;
			bad.version = 2;
			writeFileSync(markerPath, JSON.stringify(bad));
			const completed = sweepReadyRetirementMarkers({
				retiredRoot,
				orchestratorName: ORCHESTRATOR_NAME,
			});
			assert.strictEqual(completed, 0);
			assert.strictEqual(existsSync(payloadPath), true);
			assert.strictEqual(existsSync(markerPath), true);
		} finally {
			cleanupTempDir(root);
		}
	});

	test("READY + symlink payload → KEEP", () => {
		const root = makeTempDir();
		try {
			const retiredRoot = join(root, ".retired");
			const payloadDir = join(retiredRoot, RETIRED_PAYLOAD_DIR_NAME);
			mkdirSync(payloadDir, { recursive: true });
			const realDir = join(root, "real");
			mkdirSync(realDir);
			const entryName = retiredDirectoryName(RUN_ID, TOKEN);
			const payloadPath = join(payloadDir, entryName);
			symlinkSync(realDir, payloadPath);
			const marker = buildMarker();
			assert.strictEqual(
				publishRetirementReadyMarker({ retiredRoot, marker }).kind,
				"PUBLISHED",
			);
			const completed = sweepReadyRetirementMarkers({
				retiredRoot,
				orchestratorName: ORCHESTRATOR_NAME,
			});
			assert.strictEqual(completed, 0);
			assert.strictEqual(existsSync(realDir), true);
			assert.strictEqual(
				existsSync(
					join(retiredRoot, RETIRED_READY_DIR_NAME, `${entryName}.json`),
				),
				true,
			);
		} finally {
			cleanupTempDir(root);
		}
	});
});

describe("retirement READY journal — UNREADY recovery", () => {
	test("valid RETIRING DB without marker → READY published, payload deleted", () => {
		const root = makeTempDir();
		try {
			const { retiredRoot, payloadPath, entryName } = makeRetiredPayload(root);
			assert.strictEqual(
				existsSync(
					join(retiredRoot, RETIRED_READY_DIR_NAME, `${entryName}.json`),
				),
				false,
			);
			const completed = sweepUnreadyRetiredPayloads({
				driver: nodeSqliteDriver,
				retiredRoot,
			});
			assert.strictEqual(completed, 1);
			assert.strictEqual(existsSync(payloadPath), false);
			// The transient READY marker is removed after completion.
			assert.strictEqual(
				existsSync(
					join(retiredRoot, RETIRED_READY_DIR_NAME, `${entryName}.json`),
				),
				false,
			);
		} finally {
			cleanupTempDir(root);
		}
	});

	test("payload with missing DB → KEEP, DB not recreated", () => {
		const root = makeTempDir();
		try {
			const { retiredRoot, payloadPath, entryName, dbPath } =
				makeRetiredPayload(root);
			rmSync(dbPath);
			writeFileSync(join(payloadPath, "leftover.txt"), "leftover");
			const completed = sweepUnreadyRetiredPayloads({
				driver: nodeSqliteDriver,
				retiredRoot,
			});
			assert.strictEqual(completed, 0);
			assert.strictEqual(existsSync(payloadPath), true);
			assert.strictEqual(
				existsSync(dbPath),
				false,
				"inspection must never recreate the database",
			);
			assert.strictEqual(existsSync(join(payloadPath, "leftover.txt")), true);
			assert.strictEqual(
				existsSync(
					join(retiredRoot, RETIRED_READY_DIR_NAME, `${entryName}.json`),
				),
				false,
			);
		} finally {
			cleanupTempDir(root);
		}
	});

	test("ACTIVE (never claimed) payload DB → KEEP", () => {
		const root = makeTempDir();
		try {
			const runDirRoot = join(root, "runs");
			const runDir = join(runDirRoot, ORCHESTRATOR_NAME, RUN_ID);
			mkdirSync(runDir, { recursive: true });
			const runDb = openRunDatabase({
				driver: nodeSqliteDriver,
				dbPath: join(runDir, "turnlock.sqlite3"),
				busyTimeoutMs: 2000,
			});
			const now = Date.now();
			const iso = new Date(now).toISOString();
			const bootstrapped = bootstrapNewRunAtomic({
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
			assert.strictEqual(bootstrapped.kind, "BOOTSTRAPPED");
			runDb.close();
			const retiredRoot = join(runDirRoot, ORCHESTRATOR_NAME, ".retired");
			const payloadDir = join(retiredRoot, RETIRED_PAYLOAD_DIR_NAME);
			mkdirSync(payloadDir, { recursive: true });
			const entryName = retiredDirectoryName(RUN_ID, TOKEN);
			const payloadPath = join(payloadDir, entryName);
			renameSync(runDir, payloadPath);
			const completed = sweepUnreadyRetiredPayloads({
				driver: nodeSqliteDriver,
				retiredRoot,
			});
			assert.strictEqual(completed, 0);
			assert.strictEqual(existsSync(payloadPath), true);
		} finally {
			cleanupTempDir(root);
		}
	});
});
