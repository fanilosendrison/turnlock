import { OrchestratorError } from "../errors/base";
import { InvalidConfigError, type RunLockedError } from "../errors/concrete";
import { clock } from "../services/clock";
import type { InternalLogger } from "../services/logger";
import { writeProtocolBlock } from "../services/protocol";
import type { OrchestratorConfig } from "../types/config";
import { doExit } from "./context";

export function emitRunLockedError<S extends object>(
	err: RunLockedError,
	config: OrchestratorConfig<S>,
	runId: string,
	logger: InternalLogger,
): void {
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
	process.stdout.write(block);
}

export function handleTopLevelError<S extends object>(
	err: unknown,
	config: OrchestratorConfig<S> | undefined,
): never {
	const orchestratorName =
		config && typeof config.name === "string" ? config.name : "unknown";

	if (err instanceof InvalidConfigError) {
		const block = writeProtocolBlock("ERROR", {
			runId: err.runId ?? null,
			orchestrator: err.orchestratorName ?? orchestratorName,
			errorKind: "invalid_config",
			message: err.message.slice(0, 200),
			phase: null,
			phasesExecuted: 0,
		});
		process.stdout.write(block);
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
		process.stdout.write(block);
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
	process.stdout.write(block);
	doExit(1);
}
