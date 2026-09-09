import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, test } from "node:test";
import { STATE_SCHEMA_VERSION } from "../../src/constants.js";
import { nodeSqliteDriver } from "../../src/persistence/sqlite/node-sqlite-driver.js";
import {
	type LockHandle,
	releaseOwnership,
} from "../../src/persistence/sqlite/ownership.js";
import { claimRunForRetentionDeletion } from "../../src/persistence/sqlite/retention-claim.js";
import {
	bootstrapNewRunAtomic,
	type CommittedState,
} from "../../src/persistence/sqlite/run-bootstrap.js";
import {
	bootstrapNewRunAtomicCore,
	InjectedBootstrapFailure,
} from "../../src/persistence/sqlite/run-bootstrap-core.js";
import { openRunDatabase } from "../../src/persistence/sqlite/run-database.js";
import {
	commitState,
	readAuthoritativeState,
	type StateRecord,
} from "../../src/persistence/sqlite/run-state-store.js";
import {
	readWorkflowLifecycleRow,
	WORKFLOW_STATUS_NONTERMINAL,
	WORKFLOW_STATUS_TERMINAL,
	WORKFLOW_TERMINAL_KIND_DONE,
	WORKFLOW_TERMINAL_KIND_FAIL,
} from "../../src/persistence/sqlite/workflow-lifecycle.js";
import { cleanupTempDir, makeTempDir } from "../helpers/temp-run-dir.js";
import { commitTerminalDone } from "../helpers/terminal-workflow.js";

const RUN_ID = "01HX000000000000000000000A";
const ORCHESTRATOR_NAME = "workflow-lifecycle-test";
const STARTED_AT_EPOCH_MS = 1_000_000;
const TERMINAL_AT_EPOCH_MS = 2_000_000;

interface TestState {
	readonly stage: string;
}

interface SetupResult {
	readonly directory: string;
	readonly dbPath: string;
	readonly runDb: ReturnType<typeof openRunDatabase>;
	readonly handle: LockHandle;
	readonly committed: CommittedState;
}

function initialState(
	overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
	const startedAt = new Date(STARTED_AT_EPOCH_MS).toISOString();
	return {
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
		...overrides,
	};
}

function setupRun(
	state: Record<string, unknown> = initialState(),
): SetupResult {
	const directory = makeTempDir();
	const dbPath = join(directory, "turnlock.sqlite3");
	const runDb = openRunDatabase({
		driver: nodeSqliteDriver,
		dbPath,
		busyTimeoutMs: 2_000,
	});
	const result = bootstrapNewRunAtomic({
		db: runDb.connection,
		runId: RUN_ID,
		orchestratorName: ORCHESTRATOR_NAME,
		nowEpochMs: STARTED_AT_EPOCH_MS,
		nowIso: new Date(STARTED_AT_EPOCH_MS).toISOString(),
		leaseDurationMs: 10_000_000,
		leaseClockEpochMs: () => STARTED_AT_EPOCH_MS,
		initialState: state,
		stateSchemaVersion: STATE_SCHEMA_VERSION,
		contentionDeadlineMs: 2_000,
	});
	assert.strictEqual(result.kind, "BOOTSTRAPPED");
	if (result.kind !== "BOOTSTRAPPED") throw new Error("bootstrap failed");
	return {
		directory,
		dbPath,
		runDb,
		handle: result.handle,
		committed: result.committed,
	};
}

function claim(
	setup: Pick<SetupResult, "dbPath">,
	retentionThresholdEpochMs: number,
) {
	return claimRunForRetentionDeletion({
		driver: nodeSqliteDriver,
		dbPath: setup.dbPath,
		runId: RUN_ID,
		expectedOrchestratorName: ORCHESTRATOR_NAME,
		busyTimeoutMs: 2_000,
		contentionDeadlineMs: 5_000,
		retentionThresholdEpochMs,
		leaseClockEpochMs: () => TERMINAL_AT_EPOCH_MS + 1,
	});
}

function release(setup: SetupResult): void {
	assert.strictEqual(
		releaseOwnership({ db: setup.runDb.connection, handle: setup.handle }).kind,
		"SUCCESS",
	);
}

describe("durable workflow lifecycle", () => {
	test("bootstrap is NONTERMINAL and FREE ownership is not retention eligibility", () => {
		const setup = setupRun();
		try {
			assert.strictEqual(
				readWorkflowLifecycleRow(
					setup.runDb.connection,
					setup.handle.incarnationId,
				)?.status,
				WORKFLOW_STATUS_NONTERMINAL,
			);
			release(setup);
			assert.deepStrictEqual(claim(setup, Number.MAX_SAFE_INTEGER), {
				kind: "NOT_ELIGIBLE",
				reason: "WORKFLOW_NOT_TERMINAL",
			});
		} finally {
			setup.runDb.close();
			cleanupTempDir(setup.directory);
		}
	});

	test("established authority with crossed incarnation identity fails closed", () => {
		const setup = setupRun();
		try {
			setup.runDb.connection.exec("PRAGMA foreign_keys = OFF");
			setup.runDb.connection.exec(`UPDATE run_workflow_lifecycle
				SET incarnation_id = 'crossed-incarnation' WHERE singleton = 1`);
			const result = bootstrapNewRunAtomic({
				db: setup.runDb.connection,
				runId: RUN_ID,
				orchestratorName: ORCHESTRATOR_NAME,
				nowEpochMs: STARTED_AT_EPOCH_MS,
				nowIso: new Date(STARTED_AT_EPOCH_MS).toISOString(),
				leaseDurationMs: 10_000_000,
				initialState: initialState(),
				stateSchemaVersion: STATE_SCHEMA_VERSION,
				contentionDeadlineMs: 2_000,
			});
			assert.strictEqual(result.kind, "DB_FAILURE");
			if (result.kind === "DB_FAILURE") {
				assert.match(String(result.cause), /identity is incoherent/u);
			}
		} finally {
			setup.runDb.close();
			cleanupTempDir(setup.directory);
		}
	});

	test("lifecycle bootstrap failure rolls back every run row", () => {
		const directory = makeTempDir();
		const runDb = openRunDatabase({
			driver: nodeSqliteDriver,
			dbPath: join(directory, "turnlock.sqlite3"),
			busyTimeoutMs: 2_000,
		});
		try {
			const result = bootstrapNewRunAtomicCore(
				{
					db: runDb.connection,
					runId: RUN_ID,
					orchestratorName: ORCHESTRATOR_NAME,
					nowEpochMs: STARTED_AT_EPOCH_MS,
					nowIso: new Date(STARTED_AT_EPOCH_MS).toISOString(),
					leaseDurationMs: 10_000_000,
					initialState: initialState(),
					stateSchemaVersion: STATE_SCHEMA_VERSION,
					contentionDeadlineMs: 2_000,
				},
				{
					generateId: () => "01HX000000000000000000000Z",
					onFaultPoint: (point) => {
						if (point === "AFTER_LIFECYCLE_WRITE") {
							throw new InjectedBootstrapFailure(point);
						}
					},
				},
			);
			assert.strictEqual(result.kind, "DB_FAILURE");
			for (const table of [
				"run_incarnation",
				"run_workflow_lifecycle",
				"run_ownership",
				"run_state",
			]) {
				const count = runDb.connection
					.prepare(`SELECT COUNT(*) AS count FROM ${table}`)
					.get<{ readonly count: number }>();
				assert.strictEqual(count?.count, 0, table);
			}
		} finally {
			runDb.close();
			cleanupTempDir(directory);
		}
	});

	test("DONE is terminal atomically and durable terminal time owns the retention window", () => {
		const setup = setupRun();
		try {
			commitTerminalDone(
				setup.runDb.connection,
				{
					kind: "BOOTSTRAPPED",
					handle: setup.handle,
					committed: setup.committed,
				},
				TERMINAL_AT_EPOCH_MS,
			);
			const lifecycle = readWorkflowLifecycleRow(setup.runDb.connection);
			assert.strictEqual(lifecycle?.status, WORKFLOW_STATUS_TERMINAL);
			assert.strictEqual(lifecycle?.terminalKind, WORKFLOW_TERMINAL_KIND_DONE);
			release(setup);
			assert.deepStrictEqual(claim(setup, TERMINAL_AT_EPOCH_MS - 1), {
				kind: "NOT_ELIGIBLE",
				reason: "RETENTION_WINDOW",
			});
			assert.strictEqual(claim(setup, TERMINAL_AT_EPOCH_MS).kind, "CLAIMED");
		} finally {
			setup.runDb.close();
			cleanupTempDir(setup.directory);
		}
	});

	test("FAIL terminalizes while generic errors remain outside this primitive", () => {
		const setup = setupRun();
		try {
			const terminalState = {
				...setup.committed.state,
				phasesExecuted: 1,
			} as StateRecord<TestState>;
			const result = commitState({
				db: setup.runDb.connection,
				handle: setup.handle,
				expectedRevision: setup.committed.stateRevision,
				nextState: terminalState,
				nowEpochMs: TERMINAL_AT_EPOCH_MS,
				nowIso: new Date(TERMINAL_AT_EPOCH_MS).toISOString(),
				leaseClockEpochMs: () => TERMINAL_AT_EPOCH_MS,
				terminalKind: "FAIL",
			});
			assert.strictEqual(result.kind, "COMMITTED");
			assert.strictEqual(
				readWorkflowLifecycleRow(setup.runDb.connection)?.terminalKind,
				WORKFLOW_TERMINAL_KIND_FAIL,
			);
		} finally {
			setup.runDb.close();
			cleanupTempDir(setup.directory);
		}
	});

	test("terminal lifecycle rejects later state commits without changing revision", () => {
		const setup = setupRun();
		try {
			commitTerminalDone(
				setup.runDb.connection,
				{
					kind: "BOOTSTRAPPED",
					handle: setup.handle,
					committed: setup.committed,
				},
				TERMINAL_AT_EPOCH_MS,
			);
			const before = readAuthoritativeState(setup.runDb.connection);
			const result = commitState({
				db: setup.runDb.connection,
				handle: setup.handle,
				expectedRevision: before.state?.stateRevision ?? "missing",
				nextState: before.state as StateRecord<object>,
				nowEpochMs: TERMINAL_AT_EPOCH_MS + 1,
				nowIso: new Date(TERMINAL_AT_EPOCH_MS + 1).toISOString(),
				leaseClockEpochMs: () => TERMINAL_AT_EPOCH_MS + 1,
			});
			assert.deepStrictEqual(result, { kind: "WORKFLOW_TERMINAL" });
			assert.strictEqual(
				readAuthoritativeState(setup.runDb.connection).state?.stateRevision,
				before.state?.stateRevision,
			);
		} finally {
			setup.runDb.close();
			cleanupTempDir(setup.directory);
		}
	});

	test("terminal transition failure rolls back the state commit", () => {
		const setup = setupRun();
		try {
			setup.runDb.connection.exec(`CREATE TRIGGER reject_terminal_transition
				BEFORE UPDATE OF lifecycle_status ON run_workflow_lifecycle
				BEGIN SELECT RAISE(ABORT, 'injected terminal transition failure'); END`);
			const terminalState = {
				...setup.committed.state,
				terminalResult: {
					kind: "done" as const,
					outputArtifact: {
						kind: "terminal-output" as const,
						digestAlgorithm: "sha256" as const,
						digest: `sha256:${"0".repeat(64)}` as const,
						relativePath: `artifacts/sha256/00/${"0".repeat(62)}.json`,
						mediaType: "application/json" as const,
						sizeBytes: 0,
					},
					completedAt: new Date(TERMINAL_AT_EPOCH_MS).toISOString(),
					completedAtEpochMs: TERMINAL_AT_EPOCH_MS,
				},
			} as unknown as StateRecord<object>;
			const result = commitState({
				db: setup.runDb.connection,
				handle: setup.handle,
				expectedRevision: setup.committed.stateRevision,
				nextState: terminalState,
				nowEpochMs: TERMINAL_AT_EPOCH_MS,
				nowIso: new Date(TERMINAL_AT_EPOCH_MS).toISOString(),
				leaseClockEpochMs: () => TERMINAL_AT_EPOCH_MS,
				terminalKind: "DONE",
			});
			assert.strictEqual(result.kind, "DB_FAILURE");
			assert.strictEqual(
				readAuthoritativeState(setup.runDb.connection).state?.stateRevision,
				setup.committed.stateRevision,
			);
			assert.strictEqual(
				readWorkflowLifecycleRow(setup.runDb.connection)?.status,
				WORKFLOW_STATUS_NONTERMINAL,
			);
		} finally {
			setup.runDb.close();
			cleanupTempDir(setup.directory);
		}
	});
});
