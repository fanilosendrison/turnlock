// Namespace mutex subprocess worker — spawned by run-namespace-mutex tests.
//
// Modes (env TL_MODE):
//   hold     — acquire the mutex, print a single "LOCKED" line, then park
//              forever holding the transaction (parent SIGKILLs it).
//   acquire  — acquire the mutex (busy timeout from TL_BUSY_MS), print the
//              result kind, release if acquired, exit.
import { nodeSqliteDriver } from "../../../src/persistence/sqlite/node-sqlite-driver.js";
import { acquireRunNamespaceMutex } from "../../../src/services/run-namespace-mutex.js";

const MUTEX_PATH = process.env.TL_MUTEX_PATH;
const MODE = process.env.TL_MODE ?? "acquire";
const BUSY_MS = Number(process.env.TL_BUSY_MS ?? "30000");

function report(value: unknown): void {
	process.stdout.write(`${JSON.stringify(value)}\n`);
}

function parkForever(): never {
	const sab = new Int32Array(new SharedArrayBuffer(4));
	for (;;) {
		Atomics.wait(sab, 0, 0, 60_000);
	}
}

if (!MUTEX_PATH) {
	report({ mode: MODE, kind: "BAD_ENV" });
	process.exit(99);
}

const result = acquireRunNamespaceMutex({
	driver: nodeSqliteDriver,
	mutexPath: MUTEX_PATH,
	busyTimeoutMs: BUSY_MS,
});

if (MODE === "hold") {
	if (result.kind !== "ACQUIRED") {
		report({ mode: MODE, kind: result.kind });
		process.exit(1);
	}
	process.stdout.write("LOCKED\n");
	parkForever();
}

if (result.kind === "ACQUIRED") {
	result.handle.release();
	report({ mode: MODE, kind: "ACQUIRED" });
} else {
	report({ mode: MODE, kind: result.kind });
}
