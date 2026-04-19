import * as fs from "node:fs";
import type { OrchestratorEvent, OrchestratorLogger } from "../types/events";
import type { LoggingPolicy } from "../types/policies";

export interface InternalLogger extends OrchestratorLogger {
	enableDiskEmit(eventsNdjsonPath: string): void;
	disableDiskEmit(): void;
}

export type { LoggingPolicy, OrchestratorEvent, OrchestratorLogger };

export function createLogger(
	policy: LoggingPolicy | undefined,
): InternalLogger {
	if (policy?.enabled === false) {
		return {
			emit: () => {},
			enableDiskEmit: () => {},
			disableDiskEmit: () => {},
		};
	}

	const custom = policy?.logger;
	const stderrEmit: (ev: OrchestratorEvent) => void = custom
		? (ev) => custom.emit(ev)
		: (ev) => {
				process.stderr.write(`${JSON.stringify(ev)}\n`);
			};

	const persistEnabled = policy?.persistEventLog !== false;
	let diskPath: string | null = null;

	function emit(ev: OrchestratorEvent): void {
		try {
			stderrEmit(ev);
		} catch {
			// silent
		}
		if (diskPath !== null) {
			try {
				fs.appendFileSync(diskPath, `${JSON.stringify(ev)}\n`, {
					encoding: "utf-8",
				});
			} catch {
				// silent
			}
		}
	}

	function enableDiskEmit(eventsNdjsonPath: string): void {
		if (!persistEnabled) return;
		diskPath = eventsNdjsonPath;
	}

	function disableDiskEmit(): void {
		diskPath = null;
	}

	return { emit, enableDiskEmit, disableDiskEmit };
}
