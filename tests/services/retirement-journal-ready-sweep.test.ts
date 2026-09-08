import assert from "node:assert/strict";
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { nodeSqliteDriver } from "../../src/persistence/sqlite/node-sqlite-driver.js";
import {
	publishRetirementReadyMarker,
	RETIRED_PAYLOAD_DIR_NAME,
	RETIRED_READY_DIR_NAME,
	retiredDirectoryName,
	serializeRetirementReadyMarker,
	sweepReadyRetirementMarkers,
} from "../../src/services/retirement-journal.js";
import { cleanupTempDir, makeTempDir } from "../helpers/temp-run-dir.js";
import {
	buildMarker,
	makeRetiredPayload,
	markerForPayload,
	ORCHESTRATOR_NAME,
	RUN_ID,
	TOKEN,
} from "./retirement-journal-scenario-setup.js";

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
