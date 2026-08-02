import { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	isSubprocessAlive,
	killAndWaitForSigkill,
	killSubprocessIfAlive,
} from "./crash-worker-process";

export const CRASH_TEST_ORCHESTRATOR_NAME = "crash-orchestrator-test";

const WORKER_PATH = join(
	import.meta.dir,
	"..",
	"engine",
	"fixtures",
	"orchestrator-bootstrap-crash-worker.ts",
);

export interface WorkerSignal {
	readonly type: "FAULT_POINT_REACHED" | "PHASE_ENTERED";
	readonly point?: string;
	readonly observedPoints?: readonly string[];
	readonly phase?: string;
	readonly runId?: string;
	readonly runDir?: string;
	readonly state?: {
		readonly source: string;
		readonly marker: string;
	};
}

export interface PersistenceSnapshot {
	readonly schemaVersion: number;
	readonly incarnation: {
		readonly count: number;
		readonly id: string;
		readonly runId: string;
		readonly orchestratorName: string;
		readonly createdAtEpochMs: number;
		readonly createdAtIso: string;
	};
	readonly ownership: {
		readonly count: number;
		readonly incarnationId: string;
		readonly status: string;
		readonly ownerToken: string | null;
		readonly fenceToken: string;
		readonly leaseUntilEpochMs: number | null;
	};
	readonly state: {
		readonly count: number;
		readonly incarnationId: string;
		readonly revision: string;
		readonly schemaVersion: number;
		readonly json: string;
		readonly digest: string;
		readonly committedByOwnerToken: string;
		readonly committedByFenceToken: string;
		readonly committedAtEpochMs: number;
		readonly committedAtIso: string;
	};
}

export interface WorkerOutput {
	readonly exitCode: number;
	readonly stdout: string;
	readonly stderr: string;
}

function sqliteIntegerToString(value: number | bigint): string {
	return typeof value === "bigint" ? value.toString() : String(value);
}

export function readPersistenceSnapshot(dbPath: string): PersistenceSnapshot {
	const db = new Database(dbPath, { readonly: true });
	try {
		const schema = db
			.query("SELECT schema_version FROM schema_metadata WHERE singleton = 1")
			.get() as { schema_version: number } | null;
		const incarnation = db
			.query(
				`SELECT incarnation_id, run_id, orchestrator_name,
				        created_at_epoch_ms, created_at_iso
				 FROM run_incarnation WHERE singleton = 1`,
			)
			.get() as {
			incarnation_id: string;
			run_id: string;
			orchestrator_name: string;
			created_at_epoch_ms: number;
			created_at_iso: string;
		} | null;
		const ownership = db
			.query(
				`SELECT incarnation_id, ownership_status, owner_token,
				        fence_token, lease_until_epoch_ms
				 FROM run_ownership WHERE singleton = 1`,
			)
			.get() as {
			incarnation_id: string;
			ownership_status: string;
			owner_token: string | null;
			fence_token: number | bigint;
			lease_until_epoch_ms: number | null;
		} | null;
		const state = db
			.query(
				`SELECT incarnation_id, state_revision, state_schema_version,
				        state_json, state_digest, committed_by_owner_token,
				        committed_by_fence_token, committed_at_epoch_ms,
				        committed_at_iso
				 FROM run_state WHERE singleton = 1`,
			)
			.get() as {
			incarnation_id: string;
			state_revision: number | bigint;
			state_schema_version: number;
			state_json: string;
			state_digest: string;
			committed_by_owner_token: string;
			committed_by_fence_token: number | bigint;
			committed_at_epoch_ms: number;
			committed_at_iso: string;
		} | null;
		const counts = db
			.query(
				`SELECT
				   (SELECT COUNT(*) FROM run_incarnation) AS incarnations,
				   (SELECT COUNT(*) FROM run_ownership) AS ownership_rows,
				   (SELECT COUNT(*) FROM run_state) AS state_rows`,
			)
			.get() as {
			incarnations: number;
			ownership_rows: number;
			state_rows: number;
		} | null;

		if (
			schema === null ||
			incarnation === null ||
			ownership === null ||
			state === null ||
			counts === null
		) {
			throw new Error("SQLite bootstrap snapshot is incomplete");
		}

		return {
			schemaVersion: schema.schema_version,
			incarnation: {
				count: counts.incarnations,
				id: incarnation.incarnation_id,
				runId: incarnation.run_id,
				orchestratorName: incarnation.orchestrator_name,
				createdAtEpochMs: incarnation.created_at_epoch_ms,
				createdAtIso: incarnation.created_at_iso,
			},
			ownership: {
				count: counts.ownership_rows,
				incarnationId: ownership.incarnation_id,
				status: ownership.ownership_status,
				ownerToken: ownership.owner_token,
				fenceToken: sqliteIntegerToString(ownership.fence_token),
				leaseUntilEpochMs: ownership.lease_until_epoch_ms,
			},
			state: {
				count: counts.state_rows,
				incarnationId: state.incarnation_id,
				revision: sqliteIntegerToString(state.state_revision),
				schemaVersion: state.state_schema_version,
				json: state.state_json,
				digest: state.state_digest,
				committedByOwnerToken: state.committed_by_owner_token,
				committedByFenceToken: sqliteIntegerToString(
					state.committed_by_fence_token,
				),
				committedAtEpochMs: state.committed_at_epoch_ms,
				committedAtIso: state.committed_at_iso,
			},
		};
	} finally {
		db.close();
	}
}

export function expireOnlyOwnershipLease(dbPath: string): void {
	const db = new Database(dbPath);
	try {
		db.run(
			"UPDATE run_ownership SET lease_until_epoch_ms = ? WHERE singleton = 1",
			[Date.now() - 1],
		);
	} finally {
		db.close();
	}
}

async function waitForSignal(
	signalFile: string,
	timeoutMs = 10_000,
): Promise<WorkerSignal> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (existsSync(signalFile)) {
			try {
				return JSON.parse(readFileSync(signalFile, "utf-8")) as WorkerSignal;
			} catch {
				// The worker publishes by rename, but retry defensively.
			}
		}
		await Bun.sleep(10);
	}
	throw new Error(`Timed out waiting for worker signal: ${signalFile}`);
}

function spawnWorker(args: readonly string[]) {
	const env: Record<string, string> = {};
	for (const [name, value] of Object.entries(process.env)) {
		if (value !== undefined) env[name] = value;
	}
	env.NODE_ENV = "turnlock-crash-worker";
	env.TURNLOCK_TEST = "0";
	env.TURNLOCK_RUN_DIR_ROOT = "";

	const child = Bun.spawn({
		cmd: ["bun", "run", WORKER_PATH, ...args],
		env,
		stdout: "pipe",
		stderr: "pipe",
	});
	return {
		child,
		stdout: new Response(child.stdout).text(),
		stderr: new Response(child.stderr).text(),
	};
}

export type RunningCrashWorker = ReturnType<typeof spawnWorker>;

export async function killAndCollect(
	worker: RunningCrashWorker,
): Promise<WorkerOutput> {
	const exitCode = await killAndWaitForSigkill(
		worker.child,
		"orchestrator crash worker",
	);
	const [stdout, stderr] = await Promise.all([worker.stdout, worker.stderr]);
	return { exitCode, stdout, stderr };
}

async function waitForLiveWorkerSignal(
	worker: RunningCrashWorker,
	signalFile: string,
): Promise<WorkerSignal> {
	return Promise.race([
		waitForSignal(signalFile),
		worker.child.exited.then(async (exitCode) => {
			const [stdout, stderr] = await Promise.all([
				worker.stdout,
				worker.stderr,
			]);
			throw new Error(
				`Worker exited before signaling (exit=${exitCode}, stdout=${JSON.stringify(stdout)}, stderr=${JSON.stringify(stderr)})`,
			);
		}),
	]);
}

function assertWorkerIsAlive(worker: RunningCrashWorker): void {
	if (!isSubprocessAlive(worker.child)) {
		throw new Error("Worker is not alive");
	}
}

export async function crashInitialModeAt(
	runDirRoot: string,
	runId: string,
	signalFile: string,
	faultPoint: string,
): Promise<{ signal: WorkerSignal } & WorkerOutput> {
	const worker = spawnWorker([
		"--worker-mode",
		"initial",
		"--run-dir-root",
		runDirRoot,
		"--orchestrator-name",
		CRASH_TEST_ORCHESTRATOR_NAME,
		"--run-id",
		runId,
		"--signal-file",
		signalFile,
		"--fault-point",
		faultPoint,
	]);
	let failure: unknown;

	try {
		const signal = await waitForLiveWorkerSignal(worker, signalFile);
		assertWorkerIsAlive(worker);
		const output = await killAndCollect(worker);
		return { signal, ...output };
	} catch (error) {
		failure = error;
	} finally {
		await killSubprocessIfAlive(worker.child, "orchestrator crash worker");
	}

	const [stdout, stderr] = await Promise.all([worker.stdout, worker.stderr]);
	throw new Error(
		`Initial crash worker failed: ${failure instanceof Error ? failure.message : String(failure)}; stdout=${JSON.stringify(stdout)}; stderr=${JSON.stringify(stderr)}`,
	);
}

export async function spawnPublicResumeAtPhase(
	runDirRoot: string,
	runId: string,
	phaseSignalFile: string,
): Promise<{ worker: RunningCrashWorker; signal: WorkerSignal }> {
	const worker = spawnWorker([
		"--worker-mode",
		"resume",
		"--run-dir-root",
		runDirRoot,
		"--orchestrator-name",
		CRASH_TEST_ORCHESTRATOR_NAME,
		"--phase-signal-file",
		phaseSignalFile,
		"--resume",
		"--run-id",
		runId,
	]);
	let handedOff = false;
	let failure: unknown;

	try {
		const signal = await waitForLiveWorkerSignal(worker, phaseSignalFile);
		assertWorkerIsAlive(worker);
		handedOff = true;
		return { worker, signal };
	} catch (error) {
		failure = error;
	} finally {
		if (!handedOff) {
			await killSubprocessIfAlive(worker.child, "orchestrator crash worker");
		}
	}

	const [stdout, stderr] = await Promise.all([worker.stdout, worker.stderr]);
	throw new Error(
		`Resume worker failed: ${failure instanceof Error ? failure.message : String(failure)}; stdout=${JSON.stringify(stdout)}; stderr=${JSON.stringify(stderr)}`,
	);
}
