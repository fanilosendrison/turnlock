import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
// Per-run namespace mutex — unit + subprocess coverage.
//
// The sidecar SQLite namespace mutex is an EPHEMERAL mutex only: no lease,
// no owner metadata, no heartbeat, no stale-lock recovery.  A SIGKILLed
// holder must release the lock because the OS closes its file descriptors.
import { describe, test } from "node:test";
import { nodeSqliteDriver } from "../../src/persistence/sqlite/node-sqlite-driver.js";
import {
	acquireRunNamespaceMutex,
	NAMESPACE_MUTEX_FORMAT_VERSION,
	resolveNamespaceMutexPath,
} from "../../src/services/run-namespace-mutex.js";
import { spawnNode } from "../helpers/node-subprocess.js";
import { cleanupTempDir, makeTempDir } from "../helpers/temp-run-dir.js";

const RUN_ID = "01HX000000000000000000000B";

function makeMutexPath(root: string): string {
	return resolveNamespaceMutexPath(join(root, "runs", "orch"), RUN_ID);
}

function runWorker(
	workerScript: string,
	env: Readonly<Record<string, string>>,
): Promise<{ stdout: string; exitCode: number }> {
	const subprocess = spawnNode(workerScript, [], { env });
	return subprocess.exited.then(async (exitCode) => ({
		stdout: await subprocess.stdout,
		exitCode,
	}));
}

describe("run-namespace-mutex", () => {
	test("acquire → release → re-acquire (idempotent, no stale lock)", () => {
		const root = makeTempDir();
		try {
			const mutexPath = makeMutexPath(root);
			const first = acquireRunNamespaceMutex({
				driver: nodeSqliteDriver,
				mutexPath,
				busyTimeoutMs: 5000,
			});
			assert.strictEqual(first.kind, "ACQUIRED");
			if (first.kind !== "ACQUIRED") throw new Error("setup");
			// Double release is a no-op.
			first.handle.release();
			first.handle.release();
			const second = acquireRunNamespaceMutex({
				driver: nodeSqliteDriver,
				mutexPath,
				busyTimeoutMs: 5000,
			});
			assert.strictEqual(second.kind, "ACQUIRED");
			second.kind === "ACQUIRED" && second.handle.release();
		} finally {
			cleanupTempDir(root);
		}
	});

	test("rollbackAndRelease is idempotent and does not block later acquisition", () => {
		const root = makeTempDir();
		try {
			const mutexPath = makeMutexPath(root);
			const first = acquireRunNamespaceMutex({
				driver: nodeSqliteDriver,
				mutexPath,
				busyTimeoutMs: 5000,
			});
			assert.strictEqual(first.kind, "ACQUIRED");
			if (first.kind !== "ACQUIRED") throw new Error("setup");
			first.handle.rollbackAndRelease();
			first.handle.rollbackAndRelease();
			first.handle.release();
			const second = acquireRunNamespaceMutex({
				driver: nodeSqliteDriver,
				mutexPath,
				busyTimeoutMs: 5000,
			});
			assert.strictEqual(second.kind, "ACQUIRED");
			second.kind === "ACQUIRED" && second.handle.release();
		} finally {
			cleanupTempDir(root);
		}
	});

	test("concurrent acquisition: second contender times out while first holds", () => {
		const root = makeTempDir();
		try {
			const mutexPath = makeMutexPath(root);
			const first = acquireRunNamespaceMutex({
				driver: nodeSqliteDriver,
				mutexPath,
				busyTimeoutMs: 5000,
			});
			assert.strictEqual(first.kind, "ACQUIRED");
			if (first.kind !== "ACQUIRED") throw new Error("setup");
			const second = acquireRunNamespaceMutex({
				driver: nodeSqliteDriver,
				mutexPath,
				busyTimeoutMs: 300,
			});
			assert.strictEqual(
				second.kind,
				"CONTENTION_TIMEOUT",
				"second contender must not acquire while the first holds the mutex",
			);
			first.handle.release();
			const third = acquireRunNamespaceMutex({
				driver: nodeSqliteDriver,
				mutexPath,
				busyTimeoutMs: 5000,
			});
			assert.strictEqual(third.kind, "ACQUIRED");
			third.kind === "ACQUIRED" && third.handle.release();
		} finally {
			cleanupTempDir(root);
		}
	});

	test("SIGKILLed holder releases the lock — next contender acquires without lease protocol", async () => {
		const root = makeTempDir();
		try {
			const mutexPath = makeMutexPath(root);
			const workerScript = join(
				import.meta.dirname,
				"fixtures",
				"namespace-mutex-worker.js",
			);
			// Process A: acquire and hold forever.
			const holder = spawn(process.execPath, [workerScript], {
				env: {
					...process.env,
					TL_MODE: "hold",
					TL_MUTEX_PATH: mutexPath,
				},
				stdio: ["ignore", "pipe", "pipe"],
			});
			// Deterministic barrier: wait for the "LOCKED" line.
			let holderLocked = false;
			await new Promise<void>((resolve, reject) => {
				let buffer = "";
				holder.stdout.setEncoding("utf8");
				holder.stdout.on("data", (chunk: string) => {
					buffer += chunk;
					if (buffer.includes("LOCKED")) {
						holderLocked = true;
						resolve();
					}
				});
				holder.once("error", reject);
				holder.once("exit", () => {
					if (!holderLocked) {
						reject(
							new Error(
								"holder exited before reporting LOCKED — mutex acquisition failed",
							),
						);
					}
				});
			});
			assert.strictEqual(holderLocked, true);
			holder.kill("SIGKILL");
			await new Promise<void>((resolve) => {
				holder.once("exit", () => resolve());
			});
			// Process B: must acquire with NO lease-expiration protocol —
			// the OS closed A's fds and released the write lock.
			const contender = await runWorker(workerScript, {
				...process.env,
				TL_MODE: "acquire",
				TL_MUTEX_PATH: mutexPath,
				TL_BUSY_MS: "5000",
			});
			assert.strictEqual(
				JSON.parse(contender.stdout.trim()).kind,
				"ACQUIRED",
				`SIGKILLed holder must not leave a stale lock: ${contender.stdout}`,
			);
		} finally {
			cleanupTempDir(root);
		}
	});

	test("incoherent sidecar (garbage bytes) → acquisition FAILURE", () => {
		const root = makeTempDir();
		try {
			const mutexPath = makeMutexPath(root);
			mkdirSync(join(mutexPath, ".."), { recursive: true });
			writeFileSync(mutexPath, "not a sqlite database");
			const result = acquireRunNamespaceMutex({
				driver: nodeSqliteDriver,
				mutexPath,
				busyTimeoutMs: 1000,
			});
			assert.strictEqual(result.kind, "FAILURE");
		} finally {
			cleanupTempDir(root);
		}
	});

	test("incoherent sidecar (unknown format version) → acquisition FAILURE", () => {
		const root = makeTempDir();
		try {
			const mutexPath = makeMutexPath(root);
			mkdirSync(join(mutexPath, ".."), { recursive: true });
			const db = nodeSqliteDriver.open(mutexPath);
			db.exec(`
				CREATE TABLE namespace_mutex_metadata (
				    singleton      INTEGER PRIMARY KEY CHECK (singleton = 1),
				    format_version INTEGER NOT NULL
				);
				INSERT INTO namespace_mutex_metadata
				(singleton, format_version) VALUES (1, 999);
			`);
			db.close();
			const result = acquireRunNamespaceMutex({
				driver: nodeSqliteDriver,
				mutexPath,
				busyTimeoutMs: 1000,
			});
			assert.strictEqual(result.kind, "FAILURE");
			// The sidecar was left untouched by the failed acquisition.
			const probe = nodeSqliteDriver.open(mutexPath);
			try {
				const row = probe
					.prepare(
						"SELECT format_version FROM namespace_mutex_metadata WHERE singleton = 1",
					)
					.get() as { format_version: number } | undefined;
				assert.strictEqual(row?.format_version, 999);
			} finally {
				probe.close();
			}
		} finally {
			cleanupTempDir(root);
		}
	});

	test("incoherent sidecar (multiple metadata rows) → acquisition FAILURE", () => {
		const root = makeTempDir();
		try {
			const mutexPath = makeMutexPath(root);
			mkdirSync(join(mutexPath, ".."), { recursive: true });
			const db = nodeSqliteDriver.open(mutexPath);
			db.exec(`
				CREATE TABLE namespace_mutex_metadata (
				    singleton      INTEGER PRIMARY KEY,
				    format_version INTEGER NOT NULL
				);
				INSERT INTO namespace_mutex_metadata
				(singleton, format_version) VALUES (1, ${NAMESPACE_MUTEX_FORMAT_VERSION});
				INSERT INTO namespace_mutex_metadata
				(singleton, format_version) VALUES (2, ${NAMESPACE_MUTEX_FORMAT_VERSION});
			`);
			db.close();
			const result = acquireRunNamespaceMutex({
				driver: nodeSqliteDriver,
				mutexPath,
				busyTimeoutMs: 1000,
			});
			assert.strictEqual(result.kind, "FAILURE");
		} finally {
			cleanupTempDir(root);
		}
	});
});
