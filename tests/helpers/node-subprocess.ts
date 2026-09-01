import {
	type ChildProcessWithoutNullStreams,
	type SpawnOptionsWithoutStdio,
	spawn,
} from "node:child_process";
import { constants as osConstants } from "node:os";
import type { CrashWorkerSubprocess } from "./crash-worker-process.js";

export interface CapturedNodeSubprocess extends CrashWorkerSubprocess {
	readonly stdout: Promise<string>;
	readonly stderr: Promise<string>;
}

function streamText(
	stream: ChildProcessWithoutNullStreams["stdout"],
): Promise<string> {
	stream.setEncoding("utf8");
	let text = "";
	stream.on("data", (chunk: string) => {
		text += chunk;
	});
	return new Promise((resolve, reject) => {
		stream.on("end", () => resolve(text));
		stream.on("error", reject);
	});
}

function normalizedExitCode(
	code: number | null,
	signal: NodeJS.Signals | null,
): number {
	if (code !== null) return code;
	if (signal === null) return 1;
	return 128 + osConstants.signals[signal];
}

export function spawnNode(
	modulePath: string,
	arguments_: readonly string[] = [],
	options: SpawnOptionsWithoutStdio = {},
): CapturedNodeSubprocess {
	const child = spawn(process.execPath, [modulePath, ...arguments_], {
		...options,
		stdio: ["ignore", "pipe", "pipe"],
	});
	const stdout = streamText(child.stdout);
	const stderr = streamText(child.stderr);
	const exited = new Promise<number>((resolve, reject) => {
		child.once("error", reject);
		child.once("exit", (code, signal) => {
			resolve(normalizedExitCode(code, signal));
		});
	});

	return {
		get pid() {
			return child.pid;
		},
		get signalCode() {
			return child.signalCode;
		},
		exited,
		stdout,
		stderr,
		kill(signal?: number | NodeJS.Signals): void {
			child.kill(signal);
		},
	};
}
