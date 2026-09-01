#!/usr/bin/env node
import { appendFileSync, renameSync, writeFileSync } from "node:fs";
import { runOrchestratorInternal, } from "../../../src/engine/run-orchestrator.js";
import { runOrchestrator } from "../../../src/index.js";
function parseArgs(argv) {
    const args = {};
    for (let index = 0; index < argv.length; index++) {
        const argument = argv[index];
        if (argument === undefined || !argument.startsWith("--"))
            continue;
        const value = argv[index + 1];
        if (value === undefined || value.startsWith("--")) {
            args[argument.slice(2)] = "true";
            continue;
        }
        args[argument.slice(2)] = value;
        index++;
    }
    return args;
}
const blocker = new Int32Array(new SharedArrayBuffer(4));
function signalAndBlock(signalFile, signal) {
    const temporarySignalFile = `${signalFile}.${process.pid}.tmp`;
    writeFileSync(temporarySignalFile, JSON.stringify(signal), {
        encoding: "utf-8",
    });
    renameSync(temporarySignalFile, signalFile);
    Atomics.wait(blocker, 0, 0);
    throw new Error("Fault-point blocker unexpectedly resumed");
}
function requiredArg(args, name) {
    const value = args[name];
    if (value === undefined || value === "") {
        throw new Error(`Missing required argument --${name}`);
    }
    return value;
}
async function main() {
    const args = parseArgs(process.argv.slice(2));
    const workerMode = requiredArg(args, "worker-mode");
    const runDirRoot = requiredArg(args, "run-dir-root");
    const runId = requiredArg(args, "run-id");
    const orchestratorName = requiredArg(args, "orchestrator-name");
    const phaseSignalFile = args["phase-signal-file"];
    const sentinelFile = args["sentinel-file"];
    const phaseCompletion = args["phase-completion"];
    const initialMode = workerMode === "initial";
    const config = {
        name: orchestratorName,
        initial: initialMode ? "start" : "decoy",
        initialState: initialMode
            ? { source: "sqlite-authority", marker: runId }
            : { source: "resume-config-decoy", marker: "must-not-run" },
        resumeCommand: (id) => `node worker --resume --run-id ${id}`,
        runDirRoot,
        phases: {
            start: async (state, io) => {
                if (sentinelFile !== undefined) {
                    appendFileSync(sentinelFile, "start\n", { encoding: "utf-8" });
                }
                if (phaseSignalFile !== undefined) {
                    signalAndBlock(phaseSignalFile, {
                        type: "PHASE_ENTERED",
                        phase: "start",
                        runId: io.runId,
                        runDir: io.runDir,
                        state,
                    });
                }
                if (phaseCompletion === "done") {
                    return io.done({ source: "crash-worker" });
                }
                throw new Error("start phase needs --phase-signal-file or --phase-completion done");
            },
            decoy: async (state, io) => {
                if (phaseSignalFile !== undefined) {
                    signalAndBlock(phaseSignalFile, {
                        type: "PHASE_ENTERED",
                        phase: "decoy",
                        runId: io.runId,
                        runDir: io.runDir,
                        state,
                    });
                }
                if (phaseCompletion === "done") {
                    return io.done({ source: "crash-worker" });
                }
                throw new Error("decoy phase needs --phase-signal-file or --phase-completion done");
            },
        },
    };
    if (workerMode === "resume") {
        await runOrchestrator(config);
        return;
    }
    if (!initialMode) {
        throw new Error(`Unknown --worker-mode: ${workerMode}`);
    }
    const faultPointArgument = args["fault-point"];
    if (faultPointArgument === undefined) {
        await runOrchestratorInternal(config, { resume: false, runId, rest: [] }, {});
        return;
    }
    const signalFile = requiredArg(args, "signal-file");
    const faultPoint = faultPointArgument;
    const observedPoints = [];
    function reach(point) {
        observedPoints.push(point);
        if (point === faultPoint) {
            signalAndBlock(signalFile, {
                type: "FAULT_POINT_REACHED",
                point,
                observedPoints,
            });
        }
    }
    const dependencies = {
        hooks: {
            afterBootstrapResult: () => reach("AFTER_BOOTSTRAP_RESULT"),
            beforeInitialProjection: () => reach("BEFORE_INITIAL_PROJECTION"),
            afterInitialProjection: () => reach("AFTER_INITIAL_PROJECTION"),
            beforeInitialDispatchClaim: () => reach("BEFORE_INITIAL_DISPATCH_CLAIM"),
            afterInitialDispatchClaim: () => reach("AFTER_INITIAL_DISPATCH_CLAIM"),
        },
        projectionDependencies: {
            onFaultPoint: reach,
        },
    };
    await runOrchestratorInternal(config, { resume: false, runId, rest: [] }, dependencies);
    throw new Error(`Fault point was not reached: ${faultPoint}`);
}
main().catch((error) => {
    process.stderr.write(`orchestrator crash worker failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
});
//# sourceMappingURL=orchestrator-bootstrap-crash-worker.js.map