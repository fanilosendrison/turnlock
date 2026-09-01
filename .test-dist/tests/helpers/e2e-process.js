import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync, } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseProtocolBlock } from "../../src/services/protocol.js";
import { spawnNode } from "./node-subprocess.js";
const COMPILED_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const REPO_ROOT = resolve(COMPILED_ROOT, "..");
const TURNLOCK_SOURCE_MODULE = pathToFileURL(join(COMPILED_ROOT, "src", "index.js")).href;
const NODE_SQLITE_DRIVER_MODULE = pathToFileURL(join(COMPILED_ROOT, "src", "persistence", "sqlite", "node-sqlite-driver.js")).href;
const ZOD_MODULE = import.meta.resolve("zod");
function childEnv(runDirRoot, extraEnv) {
    const env = {};
    for (const [key, value] of Object.entries(process.env)) {
        if (value !== undefined)
            env[key] = value;
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
function timeoutAfter(ms) {
    return new Promise((resolveTimeout) => {
        setTimeout(() => resolveTimeout("timeout"), ms);
    });
}
function startProcess(entrypointPath, runDirRoot, args, options) {
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
            throw new Error(`E2E subprocess timed out after ${timeoutMs}ms: ${entrypointPath}`);
        }
        const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
        return { exitCode: exitOrTimeout, stdout, stderr };
    }
    return {
        pid: subprocess.pid,
        signal(signal) {
            subprocess.kill(signal);
        },
        wait,
    };
}
export function buildEntrypointSource(body) {
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
export function createE2EWorkspace(prefix = "turnlock-e2e-") {
    const root = mkdtempSync(join(tmpdir(), prefix));
    const runDirRoot = join(root, "runs");
    const entrypointsDir = join(root, "entrypoints");
    mkdirSync(entrypointsDir, { recursive: true });
    return {
        root,
        runDirRoot,
        writeEntrypoint(name, body) {
            const entrypointPath = join(entrypointsDir, name);
            writeFileSync(entrypointPath, body, { encoding: "utf-8" });
            return entrypointPath;
        },
        runEntrypoint(entrypointPath, args = [], options) {
            return startProcess(entrypointPath, runDirRoot, args, options).wait(options?.timeoutMs);
        },
        spawnEntrypoint(entrypointPath, args = [], options) {
            return startProcess(entrypointPath, runDirRoot, args, options);
        },
        runDir(orchestratorName, runId) {
            return join(runDirRoot, orchestratorName, runId);
        },
        cleanup() {
            rmSync(root, { recursive: true, force: true });
        },
    };
}
export function countProtocolBlocks(stdout) {
    return stdout.match(/@@TURNLOCK@@/g)?.length ?? 0;
}
export function parseSingleProtocolBlock(stdout) {
    const parsed = parseProtocolBlock(stdout);
    if (parsed === null) {
        throw new Error(`stdout did not contain a valid protocol block:\n${stdout}`);
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
export function readJsonFile(filePath) {
    return JSON.parse(readFileSync(filePath, "utf-8"));
}
export function readStateFile(runDir) {
    return readJsonFile(join(runDir, "state.json"));
}
export function readManifestFile(manifestPath) {
    return readJsonFile(manifestPath);
}
export function readExternalRequestManifest(manifestPath) {
    return readJsonFile(manifestPath);
}
export function readEvents(runDir) {
    const eventsPath = join(runDir, "events.ndjson");
    if (!existsSync(eventsPath))
        return [];
    const raw = readFileSync(eventsPath, "utf-8").trim();
    if (raw === "")
        return [];
    return raw.split("\n").map((line) => JSON.parse(line));
}
export function writePromptResult(runDir, label, attempt, value) {
    const resultPath = join(runDir, "results", `${label}-${attempt}.json`);
    mkdirSync(dirname(resultPath), { recursive: true });
    writeFileSync(resultPath, JSON.stringify(value), { encoding: "utf-8" });
    return resultPath;
}
export function writeExternalResolution(runDir, label, value) {
    const resultPath = join(runDir, "external-results", `${label}.json`);
    const temporaryPath = `${resultPath}.tmp`;
    mkdirSync(dirname(resultPath), { recursive: true });
    writeFileSync(temporaryPath, JSON.stringify(value), { encoding: "utf-8" });
    renameSync(temporaryPath, resultPath);
    return resultPath;
}
export function writeMalformedExternalResolution(runDir, label, raw) {
    const resultPath = join(runDir, "external-results", `${label}.json`);
    mkdirSync(dirname(resultPath), { recursive: true });
    writeFileSync(resultPath, raw, { encoding: "utf-8" });
    return resultPath;
}
export function writeMalformedPromptResult(runDir, label, attempt, raw) {
    const resultPath = join(runDir, "results", `${label}-${attempt}.json`);
    mkdirSync(dirname(resultPath), { recursive: true });
    writeFileSync(resultPath, raw, { encoding: "utf-8" });
    return resultPath;
}
export function writeBatchResults(runDir, label, attempt, resultsByJobId) {
    const resultDir = join(runDir, "results", `${label}-${attempt}`);
    mkdirSync(resultDir, { recursive: true });
    for (const [jobId, value] of Object.entries(resultsByJobId)) {
        writeFileSync(join(resultDir, `${jobId}.json`), JSON.stringify(value), {
            encoding: "utf-8",
        });
    }
}
export async function waitForPath(filePath, timeoutMs = 2000) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
        if (existsSync(filePath))
            return;
        await sleep(10);
    }
    throw new Error(`timed out waiting for path: ${filePath}`);
}
//# sourceMappingURL=e2e-process.js.map