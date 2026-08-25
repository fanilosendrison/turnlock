import { AbortedError } from "../errors/concrete.ts";
import { clock } from "../services/clock.ts";
import { releaseLock } from "../services/lock.ts";
import { writeProtocolBlock } from "../services/protocol.ts";
import { type DispatchContext, doExit } from "./context.ts";

export function installSignalHandlers<S extends object>(
	ctx: DispatchContext<S>,
): void {
	const makeHandler = (signal: "SIGINT" | "SIGTERM") => () => {
		const code = signal === "SIGINT" ? 130 : 143;
		try {
			ctx.abortController.abort(new AbortedError(`Received ${signal}`));
		} catch {
			// silent
		}
		try {
			ctx.logger.emit({
				eventType: "phase_error",
				runId: ctx.runId,
				phase: ctx.currentPhase ?? "unknown",
				errorKind: "aborted",
				message: `Received ${signal}`,
				timestamp: clock.nowWallIso(),
			});
			ctx.logger.emit({
				eventType: "orchestrator_end",
				runId: ctx.runId,
				orchestratorName: ctx.config.name,
				success: false,
				durationMs: ctx.accumulatedDurationMs,
				phasesExecuted: ctx.phasesExecuted,
				timestamp: clock.nowWallIso(),
			});
		} catch {
			// silent
		}
		try {
			const block = writeProtocolBlock("ABORTED", {
				runId: ctx.runId,
				orchestrator: ctx.config.name,
				signal,
				phase: ctx.currentPhase ?? null,
			});
			process.stdout.write(block);
		} catch {
			// silent
		}
		try {
			releaseLock(ctx.lockPath, ctx.handle, clock, ctx.logger, ctx.runId);
		} catch {
			// silent
		}
		doExit(code);
	};

	process.on("SIGINT", makeHandler("SIGINT"));
	process.on("SIGTERM", makeHandler("SIGTERM"));
}
