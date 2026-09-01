import { OrchestratorError } from "../errors/base.js";
import { InvalidConfigError } from "../errors/concrete.js";
import { clock } from "../services/clock.js";
import { writeProtocolBlock } from "../services/protocol.js";
import { doExit } from "./context.js";
import { writeProtocolStdout } from "./protocol-stdout.js";
export function emitRunLockedError(err, config, runId, logger) {
    logger.emit({
        eventType: "phase_error",
        runId,
        phase: "preflight",
        errorKind: "run_locked",
        message: err.message.slice(0, 200),
        timestamp: clock.nowWallIso(),
    });
    const block = writeProtocolBlock("ERROR", {
        runId,
        orchestrator: config.name,
        errorKind: "run_locked",
        message: err.message.slice(0, 200),
        phase: null,
        phasesExecuted: 0,
    });
    writeProtocolStdout(block);
}
export function handleTopLevelError(err, config) {
    const orchestratorName = config && typeof config.name === "string" ? config.name : "unknown";
    if (err instanceof InvalidConfigError) {
        const block = writeProtocolBlock("ERROR", {
            runId: err.runId ?? null,
            orchestrator: err.orchestratorName ?? orchestratorName,
            errorKind: "invalid_config",
            message: err.message.slice(0, 200),
            phase: null,
            phasesExecuted: 0,
        });
        writeProtocolStdout(block);
        doExit(1);
    }
    if (err instanceof OrchestratorError) {
        const block = writeProtocolBlock("ERROR", {
            runId: err.runId ?? null,
            orchestrator: err.orchestratorName ?? orchestratorName,
            errorKind: err.kind,
            message: err.message.slice(0, 200),
            phase: err.phase ?? null,
            phasesExecuted: 0,
        });
        writeProtocolStdout(block);
        doExit(1);
    }
    const msg = err instanceof Error ? err.message : String(err);
    const block = writeProtocolBlock("ERROR", {
        runId: null,
        orchestrator: orchestratorName,
        errorKind: "phase_error",
        message: msg.slice(0, 200),
        phase: null,
        phasesExecuted: 0,
    });
    writeProtocolStdout(block);
    doExit(1);
}
//# sourceMappingURL=error-emitter.js.map