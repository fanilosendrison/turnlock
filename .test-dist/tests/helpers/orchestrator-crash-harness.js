import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { nodeSqliteDriver } from "../../src/persistence/sqlite/node-sqlite-driver.js";
import { isSubprocessAlive, killAndWaitForSigkill, killSubprocessIfAlive, waitForExitWithTimeout, } from "./crash-worker-process.js";
import { spawnNode } from "./node-subprocess.js";
export const CRASH_TEST_ORCHESTRATOR_NAME = "crash-orchestrator-test";
const WORKER_PATH = join(import.meta.dirname, "..", "engine", "fixtures", "orchestrator-bootstrap-crash-worker.js");
function sqliteIntegerToString(value) {
    return typeof value === "bigint" ? value.toString() : String(value);
}
export function readPersistenceSnapshot(dbPath) {
    const db = nodeSqliteDriver.open(dbPath);
    try {
        const schema = db
            .prepare("SELECT schema_version FROM schema_metadata WHERE singleton = 1")
            .get();
        const incarnation = db
            .prepare(`SELECT incarnation_id, run_id, orchestrator_name,
				        created_at_epoch_ms, created_at_iso
				 FROM run_incarnation WHERE singleton = 1`)
            .get();
        const ownership = db
            .prepare(`SELECT incarnation_id, ownership_status, owner_token,
				        fence_token, lease_until_epoch_ms
				 FROM run_ownership WHERE singleton = 1`)
            .get();
        const state = db
            .prepare(`SELECT incarnation_id, state_revision, state_schema_version,
				        state_json, state_digest, committed_by_owner_token,
				        committed_by_fence_token, committed_at_epoch_ms,
				        committed_at_iso
				 FROM run_state WHERE singleton = 1`)
            .get();
        const counts = db
            .prepare(`SELECT
				   (SELECT COUNT(*) FROM run_incarnation) AS incarnations,
				   (SELECT COUNT(*) FROM run_ownership) AS ownership_rows,
				   (SELECT COUNT(*) FROM run_state) AS state_rows`)
            .get();
        if (schema === null ||
            incarnation === null ||
            ownership === null ||
            state === null ||
            counts === null) {
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
                committedByFenceToken: sqliteIntegerToString(state.committed_by_fence_token),
                committedAtEpochMs: state.committed_at_epoch_ms,
                committedAtIso: state.committed_at_iso,
            },
        };
    }
    finally {
        db.close();
    }
}
export function expireOnlyOwnershipLease(dbPath) {
    const db = nodeSqliteDriver.open(dbPath);
    try {
        db.prepare("UPDATE run_ownership SET lease_until_epoch_ms = ? WHERE singleton = 1").run(Date.now() - 1);
    }
    finally {
        db.close();
    }
}
async function waitForSignal(signalFile, timeoutMs = 10000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (existsSync(signalFile)) {
            try {
                return JSON.parse(readFileSync(signalFile, "utf-8"));
            }
            catch {
                // The worker publishes by rename, but retry defensively.
            }
        }
        await sleep(10);
    }
    throw new Error(`Timed out waiting for worker signal: ${signalFile}`);
}
function spawnWorker(args) {
    const env = {};
    for (const [name, value] of Object.entries(process.env)) {
        if (value !== undefined)
            env[name] = value;
    }
    env.NODE_ENV = "turnlock-crash-worker";
    env.TURNLOCK_TEST = "0";
    env.TURNLOCK_RUN_DIR_ROOT = "";
    const child = spawnNode(WORKER_PATH, args, { env });
    return {
        child,
        stdout: child.stdout,
        stderr: child.stderr,
    };
}
export async function killAndCollect(worker) {
    const exitCode = await killAndWaitForSigkill(worker.child, "orchestrator crash worker");
    const [stdout, stderr] = await Promise.all([worker.stdout, worker.stderr]);
    return { exitCode, stdout, stderr };
}
async function waitForLiveWorkerSignal(worker, signalFile) {
    return Promise.race([
        waitForSignal(signalFile),
        worker.child.exited.then(async (exitCode) => {
            const [stdout, stderr] = await Promise.all([
                worker.stdout,
                worker.stderr,
            ]);
            throw new Error(`Worker exited before signaling (exit=${exitCode}, stdout=${JSON.stringify(stdout)}, stderr=${JSON.stringify(stderr)})`);
        }),
    ]);
}
function assertWorkerIsAlive(worker) {
    if (!isSubprocessAlive(worker.child)) {
        throw new Error("Worker is not alive");
    }
}
export async function crashInitialModeAt(runDirRoot, runId, signalFile, faultPoint) {
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
    let failure;
    try {
        const signal = await waitForLiveWorkerSignal(worker, signalFile);
        assertWorkerIsAlive(worker);
        const output = await killAndCollect(worker);
        return { signal, ...output };
    }
    catch (error) {
        failure = error;
    }
    finally {
        await killSubprocessIfAlive(worker.child, "orchestrator crash worker");
    }
    const [stdout, stderr] = await Promise.all([worker.stdout, worker.stderr]);
    throw new Error(`Initial crash worker failed: ${failure instanceof Error ? failure.message : String(failure)}; stdout=${JSON.stringify(stdout)}; stderr=${JSON.stringify(stderr)}`);
}
export async function spawnPublicResumeAtPhase(runDirRoot, runId, phaseSignalFile, options = {}) {
    const args = [
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
    ];
    if (options.sentinelFile !== undefined) {
        args.push("--sentinel-file", options.sentinelFile);
    }
    const worker = spawnWorker(args);
    let handedOff = false;
    let failure;
    try {
        const signal = await waitForLiveWorkerSignal(worker, phaseSignalFile);
        assertWorkerIsAlive(worker);
        handedOff = true;
        return { worker, signal };
    }
    catch (error) {
        failure = error;
    }
    finally {
        if (!handedOff) {
            await killSubprocessIfAlive(worker.child, "orchestrator crash worker");
        }
    }
    const [stdout, stderr] = await Promise.all([worker.stdout, worker.stderr]);
    throw new Error(`Resume worker failed: ${failure instanceof Error ? failure.message : String(failure)}; stdout=${JSON.stringify(stdout)}; stderr=${JSON.stringify(stderr)}`);
}
export async function runInitialToCompletion(runDirRoot, runId, options = {}) {
    const args = [
        "--worker-mode",
        "initial",
        "--run-dir-root",
        runDirRoot,
        "--orchestrator-name",
        CRASH_TEST_ORCHESTRATOR_NAME,
        "--phase-completion",
        "done",
        "--run-id",
        runId,
    ];
    if (options.sentinelFile !== undefined) {
        args.push("--sentinel-file", options.sentinelFile);
    }
    const worker = spawnWorker(args);
    try {
        const exitCode = await waitForExitWithTimeout(worker.child, "completed initial worker");
        const [stdout, stderr] = await Promise.all([worker.stdout, worker.stderr]);
        return { exitCode, stdout, stderr };
    }
    finally {
        await killSubprocessIfAlive(worker.child, "completed initial worker");
    }
}
export async function runPublicResumeToCompletion(runDirRoot, runId, options = {}) {
    const args = [
        "--worker-mode",
        "resume",
        "--run-dir-root",
        runDirRoot,
        "--orchestrator-name",
        CRASH_TEST_ORCHESTRATOR_NAME,
        "--phase-completion",
        "done",
        "--resume",
        "--run-id",
        runId,
    ];
    if (options.sentinelFile !== undefined) {
        args.push("--sentinel-file", options.sentinelFile);
    }
    const worker = spawnWorker(args);
    try {
        const exitCode = await waitForExitWithTimeout(worker.child, "completed public resume worker");
        const [stdout, stderr] = await Promise.all([worker.stdout, worker.stderr]);
        return { exitCode, stdout, stderr };
    }
    finally {
        await killSubprocessIfAlive(worker.child, "completed public resume worker");
    }
}
//# sourceMappingURL=orchestrator-crash-harness.js.map