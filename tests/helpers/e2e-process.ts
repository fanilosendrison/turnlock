import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ExternalRequestManifest } from "../../src/bindings/external-request.js";
import type { DelegationManifest } from "../../src/bindings/types.js";
import { parseProtocolBlock } from "../../src/services/protocol.js";
import type { StateFile } from "../../src/services/state-io.js";
import type { OrchestratorEvent } from "../../src/types/events.js";
import { spawnNode } from "./node-subprocess.js";

const COMPILED_ROOT = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
);
const REPO_ROOT = resolve(COMPILED_ROOT, "..");
const TURNLOCK_SOURCE_MODULE = pathToFileURL(
	join(COMPILED_ROOT, "src", "index.js"),
).href;
const NODE_SQLITE_DRIVER_MODULE = pathToFileURL(
	join(COMPILED_ROOT, "src", "persistence", "sqlite", "node-sqlite-driver.js"),
).href;
const ZOD_MODULE = import.meta.resolve("zod");
export interface E2EWorkspace {
	readonly root: string;
	readonly runDirRoot: string;
	writeEntrypoint(name: string, body: string): string;
	runEntrypoint(
		entrypointPath: string,
		args?: readonly string[],
		options?: E2ERunOptions,
	): Promise<E2EProcessResult>;
	spawnEntrypoint(
		entrypointPath: string,
		args?: readonly string[],
		options?: E2ERunOptions,
	): RunningE2EProcess;
	runDir(orchestratorName: string, runId: string): string;
	cleanup(): void;
}
export interface E2ERunOptions {
	readonly env?: Readonly<Record<string, string>>;
	readonly timeoutMs?: number;
}
export interface E2EProcessResult {
	readonly exitCode: number;
	readonly stdout: string;
	readonly stderr: string;
}
export interface RunningE2EProcess {
	readonly pid: number | undefined;
	signal(signal: NodeJS.Signals): void;
	wait(timeoutMs?: number): Promise<E2EProcessResult>;
}
function childEnv(
	runDirRoot: string,
	extraEnv: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined) env[key] = value;
	}
	env.TURNLOCK_RUN_DIR_ROOT = runDirRoot;
	env.NODE_ENV = "turnlock-e2e";
	env.TURNLOCK_TEST = "0";
	if (extraEnv !== undefined) {
		for (const [key, value] of Object.entries(extraEnv)) {
			env[key] = value;
		}
	}
	return env;
}
function timeoutAfter(ms: number): Promise<"timeout"> {
	return new Promise((resolveTimeout) => {
		setTimeout(() => resolveTimeout("timeout"), ms);
	});
}
function startProcess(
	entrypointPath: string,
	runDirRoot: string,
	args: readonly string[],
	options: E2ERunOptions | undefined,
): RunningE2EProcess {
	const subprocess = spawnNode(entrypointPath, args, {
		cwd: REPO_ROOT,
		env: childEnv(runDirRoot, options?.env),
	});
	const stdoutPromise = subprocess.stdout;
	const stderrPromise = subprocess.stderr;
	async function wait(timeoutMs = options?.timeoutMs ?? 5000) {
		const exitOrTimeout = await Promise.race([
			subprocess.exited,
			timeoutAfter(timeoutMs),
		]);
		if (exitOrTimeout === "timeout") {
			subprocess.kill("SIGKILL");
			await subprocess.exited.catch(() => undefined);
			throw new Error(
				`E2E subprocess timed out after ${timeoutMs}ms: ${entrypointPath}`,
			);
		}
		const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
		return { exitCode: exitOrTimeout, stdout, stderr };
	}
	return {
		pid: subprocess.pid,
		signal(signal: NodeJS.Signals): void {
			subprocess.kill(signal);
		},
		wait,
	};
}
export function buildEntrypointSource(body: string): string {
	return [
		`import { definePhase, runOrchestrator } from ${JSON.stringify(TURNLOCK_SOURCE_MODULE)};`,
		`import { nodeSqliteDriver } from ${JSON.stringify(NODE_SQLITE_DRIVER_MODULE)};`,
		`import { z } from ${JSON.stringify(ZOD_MODULE)};`,
		'import { readFile, writeFile } from "node:fs/promises";',
		"",
		body.trim(),
		"",
	].join("\n");
}
export function createE2EWorkspace(prefix = "turnlock-e2e-"): E2EWorkspace {
	const root = mkdtempSync(join(tmpdir(), prefix));
	const runDirRoot = join(root, "runs");
	const entrypointsDir = join(root, "entrypoints");
	mkdirSync(entrypointsDir, { recursive: true });
	return {
		root,
		runDirRoot,
		writeEntrypoint(name: string, body: string): string {
			const entrypointPath = join(entrypointsDir, name);
			writeFileSync(entrypointPath, body, { encoding: "utf-8" });
			return entrypointPath;
		},
		runEntrypoint(
			entrypointPath: string,
			args: readonly string[] = [],
			options?: E2ERunOptions,
		): Promise<E2EProcessResult> {
			return startProcess(entrypointPath, runDirRoot, args, options).wait(
				options?.timeoutMs,
			);
		},
		spawnEntrypoint(
			entrypointPath: string,
			args: readonly string[] = [],
			options?: E2ERunOptions,
		): RunningE2EProcess {
			return startProcess(entrypointPath, runDirRoot, args, options);
		},
		runDir(orchestratorName: string, runId: string): string {
			return join(runDirRoot, orchestratorName, runId);
		},
		cleanup(): void {
			rmSync(root, { recursive: true, force: true });
		},
	};
}
export function countProtocolBlocks(stdout: string): number {
	return stdout.match(/@@TURNLOCK@@/g)?.length ?? 0;
}
export function parseSingleProtocolBlock(stdout: string) {
	const parsed = parseProtocolBlock(stdout);
	if (parsed === null) {
		throw new Error(
			`stdout did not contain a valid protocol block:\n${stdout}`,
		);
	}
	if (countProtocolBlocks(stdout) !== 1) {
		throw new Error(`expected one protocol block, got:\n${stdout}`);
	}
	const outsideBlock = stdout
		.replace(/\n?@@TURNLOCK@@[\s\S]*?@@END@@\n?/u, "")
		.trim();
	if (outsideBlock !== "") {
		throw new Error(`stdout contained non-protocol text:\n${outsideBlock}`);
	}
	return parsed;
}
export function readJsonFile<T>(filePath: string): T {
	return JSON.parse(readFileSync(filePath, "utf-8")) as T;
}
export function readStateFile<S extends object>(runDir: string): StateFile<S> {
	return readJsonFile<StateFile<S>>(join(runDir, "state.json"));
}
export function readManifestFile(manifestPath: string): DelegationManifest {
	return readJsonFile<DelegationManifest>(manifestPath);
}
export function readExternalRequestManifest(
	manifestPath: string,
): ExternalRequestManifest {
	return readJsonFile<ExternalRequestManifest>(manifestPath);
}
export function readEvents(runDir: string): OrchestratorEvent[] {
	const eventsPath = join(runDir, "events.ndjson");
	if (!existsSync(eventsPath)) return [];
	const raw = readFileSync(eventsPath, "utf-8").trim();
	if (raw === "") return [];
	return raw.split("\n").map((line) => JSON.parse(line) as OrchestratorEvent);
}
export function writePromptResult(
	runDir: string,
	label: string,
	attempt: number,
	value: unknown,
): string {
	const resultPath = join(runDir, "results", `${label}-${attempt}.json`);
	mkdirSync(dirname(resultPath), { recursive: true });
	writeFileSync(resultPath, JSON.stringify(value), { encoding: "utf-8" });
	return resultPath;
}
export function writeExternalResolution(
	runDir: string,
	label: string,
	value: unknown,
): string {
	const resultPath = join(runDir, "external-results", `${label}.json`);
	const temporaryPath = `${resultPath}.tmp`;
	mkdirSync(dirname(resultPath), { recursive: true });
	writeFileSync(temporaryPath, JSON.stringify(value), { encoding: "utf-8" });
	renameSync(temporaryPath, resultPath);
	return resultPath;
}
export function writeMalformedExternalResolution(
	runDir: string,
	label: string,
	raw: string,
): string {
	const resultPath = join(runDir, "external-results", `${label}.json`);
	mkdirSync(dirname(resultPath), { recursive: true });
	writeFileSync(resultPath, raw, { encoding: "utf-8" });
	return resultPath;
}
export function writeMalformedPromptResult(
	runDir: string,
	label: string,
	attempt: number,
	raw: string,
): string {
	const resultPath = join(runDir, "results", `${label}-${attempt}.json`);
	mkdirSync(dirname(resultPath), { recursive: true });
	writeFileSync(resultPath, raw, { encoding: "utf-8" });
	return resultPath;
}
export function writeBatchResults(
	runDir: string,
	label: string,
	attempt: number,
	resultsByJobId: Readonly<Record<string, unknown>>,
): void {
	const resultDir = join(runDir, "results", `${label}-${attempt}`);
	mkdirSync(resultDir, { recursive: true });
	for (const [jobId, value] of Object.entries(resultsByJobId)) {
		writeFileSync(join(resultDir, `${jobId}.json`), JSON.stringify(value), {
			encoding: "utf-8",
		});
	}
}
export async function waitForPath(
	filePath: string,
	timeoutMs = 2000,
): Promise<void> {
	const startedAt = Date.now();
	while (Date.now() - startedAt < timeoutMs) {
		if (existsSync(filePath)) return;
		await sleep(10);
	}
	throw new Error(`timed out waiting for path: ${filePath}`);
}
