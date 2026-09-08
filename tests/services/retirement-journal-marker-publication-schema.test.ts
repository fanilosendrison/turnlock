import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import {
	parseRetirementReadyMarker,
	publishRetirementReadyMarker,
	RETIRED_READY_DIR_NAME,
	readRetirementReadyMarker,
	retiredDirectoryName,
	serializeRetirementReadyMarker,
} from "../../src/services/retirement-journal.js";
import { cleanupTempDir, makeTempDir } from "../helpers/temp-run-dir.js";
import { buildMarker, RUN_ID } from "./retirement-journal-scenario-setup.js";

// Durable marker schema, atomic publication, and idempotence.
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
