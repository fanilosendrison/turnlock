import * as fs from "node:fs";
import type { LockHandle } from "../services/lock";
import type { InternalLogger } from "../services/logger";
import type { OrchestratorConfig } from "../types/config";

export interface DispatchContext<S extends object> {
	readonly config: OrchestratorConfig<S>;
	readonly runId: string;
	readonly runDir: string;
	readonly lockPath: string;
	readonly handle: LockHandle;
	readonly logger: InternalLogger;
	readonly abortController: AbortController;
	currentPhase: string | null;
	phasesExecuted: number;
	accumulatedDurationMs: number;
}

export interface LoadedResults {
	readonly label: string;
	readonly kind: "skill" | "agent" | "agent-batch";
	readonly data: unknown | readonly unknown[];
}

export class TestExitSignal {
	readonly __ccOrchExit = true;
	constructor(public readonly code: number) {}
}

const IS_TEST = (() => {
	const argv0 = process.argv[0] ?? "";
	const argv1 = process.argv[1] ?? "";
	if (
		argv1 === "test" &&
		(argv0.endsWith("/bun") || argv0.endsWith("/bun-debug") || argv0 === "bun")
	)
		return true;
	if (process.env.NODE_ENV === "test") return true;
	if (process.env.CC_ORCH_TEST === "1") return true;
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
		(err as { __ccOrchExit?: boolean }).__ccOrchExit === true
	);
}

export function writeFileSyncAtomic(targetPath: string, content: string): void {
	const tmpPath = `${targetPath}.tmp`;
	fs.writeFileSync(tmpPath, content, { encoding: "utf-8" });
	fs.renameSync(tmpPath, targetPath);
}
