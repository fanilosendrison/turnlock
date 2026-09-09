import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, test } from "node:test";
import {
	PENDING_INITIAL_DISPATCH_STATE_FIELD,
	PENDING_INITIAL_DISPATCH_VERSION,
	PENDING_INITIAL_DISPATCH_VERSION_STATE_FIELD,
	STATE_SCHEMA_VERSION,
} from "../../src/constants.js";
import { nodeSqliteDriver } from "../../src/persistence/sqlite/node-sqlite-driver.js";
import { releaseOwnership } from "../../src/persistence/sqlite/ownership.js";
import { claimRunForRetentionDeletion } from "../../src/persistence/sqlite/retention-claim.js";
import { inspectRetiredRunAuthority } from "../../src/persistence/sqlite/retired-run-inspection.js";
import {
	type BootstrapNewRunResult,
	bootstrapNewRunAtomic,
	migrateLegacyRunAtomic,
} from "../../src/persistence/sqlite/run-bootstrap.js";
import { openRunDatabase } from "../../src/persistence/sqlite/run-database.js";
import { computeStateDigest } from "../../src/persistence/sqlite/run-state-codec.js";
import {
	readWorkflowLifecycleRow,
	WORKFLOW_STATUS_NONTERMINAL,
	WORKFLOW_STATUS_TERMINAL,
	WORKFLOW_TERMINAL_KIND_DONE,
	WORKFLOW_TERMINAL_KIND_LEGACY_RETENTION_CLAIM,
} from "../../src/persistence/sqlite/workflow-lifecycle.js";
import { cleanupTempDir, makeTempDir } from "../helpers/temp-run-dir.js";
import { commitTerminalDone } from "../helpers/terminal-workflow.js";

const RUN_ID = "01HX000000000000000000000A";
const ORCHESTRATOR_NAME = "workflow-lifecycle-migration";
const STARTED_AT_EPOCH_MS = 1_000_000;
const TERMINAL_AT_EPOCH_MS = 2_000_000;

type BootstrappedRun = Extract<
	BootstrapNewRunResult,
	{ readonly kind: "BOOTSTRAPPED" }
>;

interface SetupResult {
	readonly directory: string;
	readonly dbPath: string;
	readonly runDb: ReturnType<typeof openRunDatabase>;
	readonly bootstrap: BootstrappedRun;
}

function setupRun(): SetupResult {
	const directory = makeTempDir();
	const dbPath = join(directory, "turnlock.sqlite3");
	const runDb = openRunDatabase({
		driver: nodeSqliteDriver,
		dbPath,
		busyTimeoutMs: 2_000,
	});
	const startedAt = new Date(STARTED_AT_EPOCH_MS).toISOString();
	const bootstrap = bootstrapNewRunAtomic({
		db: runDb.connection,
		runId: RUN_ID,
		orchestratorName: ORCHESTRATOR_NAME,
		nowEpochMs: STARTED_AT_EPOCH_MS,
		nowIso: startedAt,
		leaseDurationMs: 10_000_000,
		leaseClockEpochMs: () => STARTED_AT_EPOCH_MS,
		initialState: {
			schemaVersion: STATE_SCHEMA_VERSION,
			runId: RUN_ID,
			orchestratorName: ORCHESTRATOR_NAME,
			startedAt,
			startedAtEpochMs: STARTED_AT_EPOCH_MS,
			lastTransitionAt: startedAt,
			lastTransitionAtEpochMs: STARTED_AT_EPOCH_MS,
			currentPhase: "start",
			phasesExecuted: 0,
			accumulatedDurationMs: 0,
			data: { stage: "active" },
			usedLabels: [],
		},
		stateSchemaVersion: STATE_SCHEMA_VERSION,
		contentionDeadlineMs: 2_000,
	});
	assert.strictEqual(bootstrap.kind, "BOOTSTRAPPED");
	if (bootstrap.kind !== "BOOTSTRAPPED") throw new Error("bootstrap failed");
	return { directory, dbPath, runDb, bootstrap };
}

function release(setup: SetupResult): void {
	assert.strictEqual(
		releaseOwnership({
			db: setup.runDb.connection,
			handle: setup.bootstrap.handle,
		}).kind,
		"SUCCESS",
	);
}

function claim(setup: SetupResult) {
	return claimRunForRetentionDeletion({
		driver: nodeSqliteDriver,
		dbPath: setup.dbPath,
		runId: RUN_ID,
		expectedOrchestratorName: ORCHESTRATOR_NAME,
		busyTimeoutMs: 2_000,
		contentionDeadlineMs: 5_000,
		retentionThresholdEpochMs: TERMINAL_AT_EPOCH_MS,
		leaseClockEpochMs: () => TERMINAL_AT_EPOCH_MS + 1,
	});
}

function addInitialDispatchMarkerToTerminalState(setup: SetupResult): void {
	const row = setup.runDb.connection
		.prepare("SELECT state_json FROM run_state WHERE singleton = 1")
		.get<{ readonly state_json: string }>();
	if (row === undefined) throw new Error("state row missing");
	const parsed = JSON.parse(row.state_json) as Record<string, unknown>;
	parsed[PENDING_INITIAL_DISPATCH_STATE_FIELD] = true;
	parsed[PENDING_INITIAL_DISPATCH_VERSION_STATE_FIELD] =
		PENDING_INITIAL_DISPATCH_VERSION;
	const stateJson = JSON.stringify(parsed);
	setup.runDb.connection
		.prepare(`UPDATE run_state SET state_json = ?, state_digest = ?
			 WHERE singleton = 1`)
		.run(stateJson, computeStateDigest(stateJson));
}

function downgradeAuthorityToSchemaV2(setup: SetupResult): void {
	setup.runDb.close();
	const database = nodeSqliteDriver.open(setup.dbPath);
	try {
		database.exec("DROP TABLE run_workflow_lifecycle");
		database.exec(
			"UPDATE schema_metadata SET schema_version = 2 WHERE singleton = 1",
		);
	} finally {
		database.close();
	}
}

describe("workflow lifecycle schema-v2 migration", () => {
	test("only unambiguous terminal state migrates to DONE", () => {
		for (const scenario of ["nonterminal", "done", "ambiguous-done"] as const) {
			const setup = setupRun();
			try {
				if (scenario !== "nonterminal") {
					commitTerminalDone(
						setup.runDb.connection,
						setup.bootstrap,
						TERMINAL_AT_EPOCH_MS,
					);
				}
				if (scenario === "ambiguous-done") {
					addInitialDispatchMarkerToTerminalState(setup);
				}
				downgradeAuthorityToSchemaV2(setup);
				const migrated = openRunDatabase({
					driver: nodeSqliteDriver,
					dbPath: setup.dbPath,
					busyTimeoutMs: 2_000,
				});
				try {
					const lifecycle = readWorkflowLifecycleRow(migrated.connection);
					const expectedTerminal = scenario === "done";
					assert.strictEqual(
						lifecycle?.status,
						expectedTerminal
							? WORKFLOW_STATUS_TERMINAL
							: WORKFLOW_STATUS_NONTERMINAL,
					);
					assert.strictEqual(
						lifecycle?.terminalKind,
						expectedTerminal ? WORKFLOW_TERMINAL_KIND_DONE : null,
					);
				} finally {
					migrated.close();
				}
			} finally {
				cleanupTempDir(setup.directory);
			}
		}
	});

	test("partial authority with pre-existing state is never reported established", () => {
		const setup = setupRun();
		try {
			release(setup);
			setup.runDb.connection.exec(
				"DELETE FROM run_workflow_lifecycle WHERE singleton = 1",
			);
			const stateBefore = setup.runDb.connection
				.prepare("SELECT state_json FROM run_state WHERE singleton = 1")
				.get<{ readonly state_json: string }>()?.state_json;
			const result = migrateLegacyRunAtomic({
				db: setup.runDb.connection,
				runId: RUN_ID,
				orchestratorName: ORCHESTRATOR_NAME,
				nowEpochMs: STARTED_AT_EPOCH_MS + 1,
				nowIso: new Date(STARTED_AT_EPOCH_MS + 1).toISOString(),
				leaseDurationMs: 10_000_000,
				leaseClockEpochMs: () => STARTED_AT_EPOCH_MS + 1,
				legacyState: setup.bootstrap.committed.state,
				legacyStartedAtEpochMs: STARTED_AT_EPOCH_MS,
				legacyStartedAt: new Date(STARTED_AT_EPOCH_MS).toISOString(),
				legacyLastTransitionAtEpochMs: STARTED_AT_EPOCH_MS,
				legacyLastTransitionAt: new Date(STARTED_AT_EPOCH_MS).toISOString(),
				stateSchemaVersion: STATE_SCHEMA_VERSION,
				contentionDeadlineMs: 2_000,
			});
			assert.strictEqual(result.kind, "INCOMPLETE_EXISTING_BOOTSTRAP");
			const lifecycle = setup.runDb.connection
				.prepare("SELECT 1 FROM run_workflow_lifecycle WHERE singleton = 1")
				.get();
			assert.strictEqual(lifecycle, undefined);
			const stateAfter = setup.runDb.connection
				.prepare("SELECT state_json FROM run_state WHERE singleton = 1")
				.get<{ readonly state_json: string }>()?.state_json;
			assert.strictEqual(stateAfter, stateBefore);
			const ownership = setup.runDb.connection
				.prepare(`SELECT ownership_status, owner_token
					 FROM run_ownership WHERE singleton = 1`)
				.get<{
					readonly ownership_status: string;
					readonly owner_token: string | null;
				}>();
			assert.strictEqual(ownership?.ownership_status, "FREE");
			assert.strictEqual(ownership?.owner_token, null);
		} finally {
			setup.runDb.close();
			cleanupTempDir(setup.directory);
		}
	});

	test("an existing v2 RETIRING claim resumes with legacy provenance", () => {
		const setup = setupRun();
		try {
			commitTerminalDone(
				setup.runDb.connection,
				setup.bootstrap,
				TERMINAL_AT_EPOCH_MS,
			);
			release(setup);
			const originalClaim = claim(setup);
			assert.strictEqual(originalClaim.kind, "CLAIMED");
			if (originalClaim.kind !== "CLAIMED") throw new Error("claim failed");
			downgradeAuthorityToSchemaV2(setup);

			assert.strictEqual(
				inspectRetiredRunAuthority({
					driver: nodeSqliteDriver,
					dbPath: setup.dbPath,
					expectedRunId: RUN_ID,
					expectedOrchestratorName: ORCHESTRATOR_NAME,
					expectedRetirementToken: originalClaim.retirementToken,
				}).kind,
				"VALID_RETIRING",
			);
			const migrated = openRunDatabase({
				driver: nodeSqliteDriver,
				dbPath: setup.dbPath,
				busyTimeoutMs: 2_000,
			});
			try {
				assert.strictEqual(
					readWorkflowLifecycleRow(migrated.connection)?.terminalKind,
					WORKFLOW_TERMINAL_KIND_LEGACY_RETENTION_CLAIM,
				);
			} finally {
				migrated.close();
			}
			assert.strictEqual(claim(setup).kind, "ALREADY_RETIRING");
		} finally {
			cleanupTempDir(setup.directory);
		}
	});

	test("schema v1 can never grandfather a RETIRING claim", () => {
		const setup = setupRun();
		try {
			commitTerminalDone(
				setup.runDb.connection,
				setup.bootstrap,
				TERMINAL_AT_EPOCH_MS,
			);
			release(setup);
			assert.strictEqual(claim(setup).kind, "CLAIMED");
			downgradeAuthorityToSchemaV2(setup);
			const database = nodeSqliteDriver.open(setup.dbPath);
			try {
				database.exec(
					"UPDATE schema_metadata SET schema_version = 1 WHERE singleton = 1",
				);
			} finally {
				database.close();
			}

			assert.throws(
				() =>
					openRunDatabase({
						driver: nodeSqliteDriver,
						dbPath: setup.dbPath,
						busyTimeoutMs: 2_000,
					}),
				/schema-v1 authority cannot carry a RETIRING claim/,
			);
			const rolledBack = nodeSqliteDriver.open(setup.dbPath);
			try {
				assert.strictEqual(
					rolledBack
						.prepare(
							"SELECT schema_version FROM schema_metadata WHERE singleton = 1",
						)
						.get<{ readonly schema_version: number }>()?.schema_version,
					1,
				);
			} finally {
				rolledBack.close();
			}
		} finally {
			cleanupTempDir(setup.directory);
		}
	});

	test("an incoherent v2 RETIRING claim fails closed", () => {
		const setup = setupRun();
		try {
			commitTerminalDone(
				setup.runDb.connection,
				setup.bootstrap,
				TERMINAL_AT_EPOCH_MS,
			);
			release(setup);
			const originalClaim = claim(setup);
			assert.strictEqual(originalClaim.kind, "CLAIMED");
			if (originalClaim.kind !== "CLAIMED") throw new Error("claim failed");
			downgradeAuthorityToSchemaV2(setup);
			const database = nodeSqliteDriver.open(setup.dbPath);
			try {
				database
					.prepare(`UPDATE run_ownership
					 SET ownership_status = 'HELD', owner_token = 'corrupt-owner',
					     owner_pid = 1, acquired_at_epoch_ms = ?,
					     lease_until_epoch_ms = ?
					 WHERE singleton = 1`)
					.run(TERMINAL_AT_EPOCH_MS, TERMINAL_AT_EPOCH_MS + 10_000);
			} finally {
				database.close();
			}

			assert.strictEqual(
				inspectRetiredRunAuthority({
					driver: nodeSqliteDriver,
					dbPath: setup.dbPath,
					expectedRunId: RUN_ID,
					expectedOrchestratorName: ORCHESTRATOR_NAME,
					expectedRetirementToken: originalClaim.retirementToken,
				}).kind,
				"INVALID",
			);
			assert.throws(
				() =>
					openRunDatabase({
						driver: nodeSqliteDriver,
						dbPath: setup.dbPath,
						busyTimeoutMs: 2_000,
					}),
				/RETIRING authority lacks coherent released ownership and state/,
			);
		} finally {
			cleanupTempDir(setup.directory);
		}
	});
});
