import {
	type ParsedProtocolBlock,
	parseProtocolBlock,
} from "../../src/services/protocol.js";
import type { OrchestratorEvent } from "../../src/types/events.js";
export interface MockStdio {
	readonly stdout: string;
	readonly stderr: string;
	writeStdout(chunk: string): void;
	writeStderr(chunk: string): void;
	clear(): void;
	getProtocolBlocks(): ParsedProtocolBlock[];
	getEvents(): OrchestratorEvent[];
}
export function createMockStdio(): MockStdio {
	let stdout = "";
	let stderr = "";
	return {
		get stdout() {
			return stdout;
		},
		get stderr() {
			return stderr;
		},
		writeStdout(chunk: string): void {
			stdout += chunk;
		},
		writeStderr(chunk: string): void {
			stderr += chunk;
		},
		clear(): void {
			stdout = "";
			stderr = "";
		},
		getProtocolBlocks(): ParsedProtocolBlock[] {
			const blocks: ParsedProtocolBlock[] = [];
			let remaining = stdout;
			while (remaining.includes("@@TURNLOCK@@")) {
				try {
					const parsed = parseProtocolBlock(remaining);
					if (parsed === null) break;
					blocks.push(parsed);
				} catch {
					break;
				}
				const idx = remaining.indexOf("@@END@@");
				if (idx === -1) break;
				remaining = remaining.slice(idx + "@@END@@".length);
			}
			return blocks;
		},
		getEvents(): OrchestratorEvent[] {
			const out: OrchestratorEvent[] = [];
			const lines = stderr.split(/\r?\n/).filter((l) => l.length > 0);
			for (const line of lines) {
				try {
					out.push(JSON.parse(line) as OrchestratorEvent);
				} catch {
					// skip non-json lines
				}
			}
			return out;
		},
	};
}
