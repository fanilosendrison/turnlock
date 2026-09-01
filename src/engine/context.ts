import * as fs from "node:fs";
import type { LockHandle } from "../persistence/sqlite/ownership.js";
import type { RunDatabase } from "../persistence/sqlite/run-database.js";
import type { InternalLogger } from "../services/logger.js";
import type { OrchestratorConfig } from "../types/config.js";
export interface DispatchContext<S extends object> {
	readonly config: OrchestratorConfig<S>;
	readonly runId: string;
	readonly runDir: string;
	readonly runDb: RunDatabase;
	handle: LockHandle;
	readonly logger: InternalLogger;
	readonly abortController: AbortController;
	currentPhase: string | null;
	phasesExecuted: number;
	accumulatedDurationMs: number;
	stateRevision: string;
}
export interface LoadedResults {
	readonly label: string;
	readonly kind: "prompt" | "batch" | "external-request";
	readonly data: unknown | readonly unknown[];
}
export class TestExitSignal {
	readonly __turnlockExit = true;
	constructor(public readonly code: number) {}
}
const IS_TEST = (() => {
	if (process.env.TURNLOCK_TEST === "0") return false;
	if (process.env.TURNLOCK_TEST === "1") return true;
	if (process.env.NODE_TEST_CONTEXT !== undefined) return true;
	if (process.env.NODE_ENV === "test") return true;
	return false;
})();
export function doExit(code: number): never {
	if (IS_TEST) {
		throw new TestExitSignal(code);
	}
	process.exit(code);
}
export function isTestExitSignal(err: unknown): err is TestExitSignal {
	return (
		typeof err === "object" &&
		err !== null &&
		(
			err as {
				__turnlockExit?: boolean;
			}
		).__turnlockExit === true
	);
}
export function writeFileSyncAtomic(
	targetPath: string,
	content: string | Uint8Array,
): void {
	const tmpPath = `${targetPath}.tmp`;
	fs.writeFileSync(tmpPath, content);
	fs.renameSync(tmpPath, targetPath);
}
