import assert from "node:assert/strict";
import { existsSync, mkdirSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { STATE_SCHEMA_VERSION } from "../../src/constants.js";
import { validateConfig } from "../../src/engine/preflight.js";
import { InvalidConfigError } from "../../src/errors/concrete.js";
import { nodeSqliteDriver } from "../../src/persistence/sqlite/node-sqlite-driver.js";
import { bootstrapNewRunAtomic } from "../../src/persistence/sqlite/run-bootstrap.js";
import { openRunDatabase } from "../../src/persistence/sqlite/run-database.js";
import type { OrchestratorConfig } from "../../src/types/config.js";
import {
	buildEntrypointSource,
	createE2EWorkspace,
	parseSingleProtocolBlock,
} from "../helpers/e2e-process.js";

const INVALID_PHASE_VALUES: ReadonlyArray<{
	readonly label: string;
	readonly value: unknown;
}> = [
	{ label: "null", value: null },
	{ label: "string", value: "str" },
	{ label: "number", value: 42 },
];

function configWithPhaseValue(value: unknown): OrchestratorConfig<object> {
	return {
		name: "invalid-phase-value",
		initial: "p1",
		initialState: {},
		resumeCommand: (runId: string) =>
			`node runner.mjs --run-id ${runId} --resume`,
		phases: { p1: value },
	} as unknown as OrchestratorConfig<object>;
}

function configWithRetentionDays(value: unknown): OrchestratorConfig<object> {
	return {
		name: "retention-days-config",
		initial: "p1",
		initialState: {},
		resumeCommand: (runId: string) =>
			`node runner.mjs --run-id ${runId} --resume`,
		retentionDays: value,
		phases: { p1: async () => ({ kind: "done" }) },
	} as unknown as OrchestratorConfig<object>;
}

describe("preflight retentionDays validation", () => {
	const INVALID_RETENTION_DAYS: ReadonlyArray<{
		readonly label: string;
		readonly value: unknown;
	}> = [
		{ label: "-1", value: -1 },
		{ label: "NaN", value: Number.NaN },
		{ label: "Infinity", value: Number.POSITIVE_INFINITY },
		{ label: "1.5", value: 1.5 },
		{ label: "string", value: "7" },
	];

	for (const { label, value } of INVALID_RETENTION_DAYS) {
		test(`rejects retentionDays = ${label}`, () => {
			assert.throws(
				() => validateConfig(configWithRetentionDays(value)),
				(error: unknown) =>
					error instanceof InvalidConfigError &&
					error.message ===
						`config.retentionDays must be a finite non-negative integer (got ${String(value)})`,
			);
		});
	}

	test("accepts retentionDays = 0 (no retention delay)", () => {
		assert.doesNotThrow(() => validateConfig(configWithRetentionDays(0)));
	});

	test("accepts a positive integer retentionDays", () => {
		assert.doesNotThrow(() => validateConfig(configWithRetentionDays(7)));
	});

	test("accepts an omitted retentionDays", () => {
		const config = configWithRetentionDays(7);
		const { retentionDays: _omitted, ...withoutRetention } = config;
		assert.doesNotThrow(() => validateConfig(withoutRetention));
	});

	test("rejects invalid retentionDays before any run-directory I/O", async () => {
		const workspace = createE2EWorkspace("turnlock-retention-preflight-");
		const entrypoint = workspace.writeEntrypoint(
			"invalid-retention.ts",
			buildEntrypointSource(`
await runOrchestrator({
	name: "invalid-retention",
	initial: "p1",
	initialState: {},
	resumeCommand: (runId) => "node runner.mjs --run-id " + runId + " --resume",
	retentionDays: -1,
	phases: { p1: async (_s, io) => io.done({}) },
});
`),
		);
		// A pre-existing foreign RUN_DIR in the SAME orchestrator namespace
		// must survive the rejected preflight: an invalid retention policy must
		// never trigger destructive cleanup effects.  The decoy is a genuine
		// retention-deletable candidate (real SQLite authority with an
		// expired HELD lease) aged far beyond any retention threshold, so a
		// cleanup executed in spite of the invalid config would really
		// claim and delete it.
		const decoyRunDir = join(
			workspace.runDirRoot,
			"invalid-retention",
			"01HX0000000000000000000001",
		);
		mkdirSync(decoyRunDir, { recursive: true });
		const decoyDb = openRunDatabase({
			driver: nodeSqliteDriver,
			dbPath: join(decoyRunDir, "turnlock.sqlite3"),
			busyTimeoutMs: 2000,
		});
		const decoyNow = Date.now();
		const decoyIso = new Date(decoyNow).toISOString();
		const decoyBootstrap = bootstrapNewRunAtomic({
			db: decoyDb.connection,
			runId: "01HX0000000000000000000001",
			orchestratorName: "invalid-retention",
			nowEpochMs: decoyNow,
			nowIso: decoyIso,
			leaseDurationMs: 30 * 60 * 1000,
			initialState: {
				schemaVersion: STATE_SCHEMA_VERSION,
				runId: "01HX0000000000000000000001",
				orchestratorName: "invalid-retention",
				startedAt: decoyIso,
				startedAtEpochMs: decoyNow,
				lastTransitionAt: decoyIso,
				lastTransitionAtEpochMs: decoyNow,
				currentPhase: "p1",
				phasesExecuted: 0,
				accumulatedDurationMs: 0,
				data: {},
				usedLabels: [],
			},
			stateSchemaVersion: STATE_SCHEMA_VERSION,
			contentionDeadlineMs: 5000,
		});
		decoyDb.connection.exec(
			`UPDATE run_ownership SET lease_until_epoch_ms = ${Date.now() - 1000} WHERE singleton = 1`,
		);
		decoyDb.close();
		assert.strictEqual(decoyBootstrap.kind, "BOOTSTRAPPED");
		const old = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000);
		utimesSync(decoyRunDir, old, old);
		try {
			const result = await workspace.runEntrypoint(entrypoint, [
				"--run-id",
				"01HX0000000000000000000030",
			]);
			assert.strictEqual(result.exitCode, 1);
			assert.strictEqual(result.stderr, "");
			assert.deepStrictEqual(parseSingleProtocolBlock(result.stdout), {
				version: 3,
				runId: null,
				orchestrator: "invalid-retention",
				action: "ERROR",
				fields: {
					errorKind: "invalid_config",
					message:
						"config.retentionDays must be a finite non-negative integer (got -1)",
					phase: null,
					phasesExecuted: 0,
				},
			});
			assert.strictEqual(
				existsSync(decoyRunDir),
				true,
				"invalid retentionDays must not delete RUN_DIRs of its own orchestrator namespace",
			);
		} finally {
			workspace.cleanup();
		}
	});
});

describe("preflight phase validation", () => {
	for (const { label, value } of INVALID_PHASE_VALUES) {
		test(`rejects a ${label} phase value`, () => {
			assert.throws(
				() => validateConfig(configWithPhaseValue(value)),
				(error: unknown) =>
					error instanceof InvalidConfigError &&
					error.message === 'phase "p1" must be a function',
			);
		});
	}

	test("rejects invalid phase values before creating a run directory", async () => {
		const workspace = createE2EWorkspace("turnlock-preflight-");
		const entrypoint = workspace.writeEntrypoint(
			"invalid-phase-value.ts",
			buildEntrypointSource(`
await runOrchestrator({
	name: "invalid-phase-value",
	initial: "p1",
	initialState: {},
	resumeCommand: (runId) => "node runner.mjs --run-id " + runId + " --resume",
	phases: { p1: "str" },
});
`),
		);
		try {
			const result = await workspace.runEntrypoint(entrypoint, [
				"--run-id",
				"01HX0000000000000000000030",
			]);
			assert.strictEqual(result.exitCode, 1);
			assert.strictEqual(result.stderr, "");
			assert.deepStrictEqual(parseSingleProtocolBlock(result.stdout), {
				version: 3,
				runId: null,
				orchestrator: "invalid-phase-value",
				action: "ERROR",
				fields: {
					errorKind: "invalid_config",
					message: 'phase "p1" must be a function',
					phase: null,
					phasesExecuted: 0,
				},
			});
			assert.strictEqual(
				existsSync(workspace.runDirRoot),
				false,
				"preflight rejection must happen before run-directory I/O",
			);
		} finally {
			workspace.cleanup();
		}
	});
});
