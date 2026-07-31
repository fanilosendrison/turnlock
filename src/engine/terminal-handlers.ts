import * as path from "node:path";
import { STATE_SCHEMA_VERSION } from "../constants";
import { enrich, OrchestratorError } from "../errors/base";
import { PhaseError } from "../errors/concrete";
import {
	installPreparedArtifact,
	prepareJsonArtifact,
} from "../services/artifact-store";
import { clock } from "../services/clock";
import { writeProtocolBlock } from "../services/protocol";
import type { StateFile } from "../services/state-io";
import type { TerminalDoneRecord } from "../types/artifacts";
import { type DispatchContext, doExit } from "./context";
import { clearPendingYield } from "./pending-yield";
import {
	commitStateWithProjection,
	projectCanonicalArtifactFenced,
	releaseOwnershipBestEffort,
	releaseOwnershipFromContext,
} from "./state-commit";

export async function emitFatalError<S extends object>(
	ctx: DispatchContext<S>,
	state: StateFile<S>,
	currentPhase: string,
	err: unknown,
): Promise<never> {
	let wrapped: OrchestratorError;
	if (err instanceof OrchestratorError) {
		wrapped = err;
	} else if (err instanceof Error) {
		wrapped = new PhaseError(err.message.slice(0, 200), { cause: err });
	} else {
		wrapped = new PhaseError(String(err).slice(0, 200));
	}
	enrich(wrapped, {
		runId: ctx.runId,
		orchestratorName: ctx.config.name,
		phase: currentPhase,
	});

	const nowIso = clock.nowWallIso();
	ctx.logger.emit({
		eventType: "phase_error",
		runId: ctx.runId,
		phase: currentPhase,
		errorKind: wrapped.kind,
		message: wrapped.message.slice(0, 200),
		timestamp: nowIso,
	});
	ctx.logger.emit({
		eventType: "orchestrator_end",
		runId: ctx.runId,
		orchestratorName: ctx.config.name,
		success: false,
		durationMs: state.accumulatedDurationMs,
		phasesExecuted: state.phasesExecuted,
		timestamp: nowIso,
	});

	const block = writeProtocolBlock("ERROR", {
		runId: ctx.runId,
		orchestrator: ctx.config.name,
		errorKind: wrapped.kind,
		message: wrapped.message.slice(0, 200),
		phase: currentPhase,
		phasesExecuted: state.phasesExecuted,
	});
	process.stdout.write(block);

	releaseOwnershipBestEffort(ctx);
	doExit(1);
}

export async function handleDone<S extends object>(
	ctx: DispatchContext<S>,
	state: StateFile<S>,
	result: { kind: "done"; output: unknown },
	accumulatedDurationMs: number,
): Promise<never> {
	// 1. Serialize output and prepare immutable artifact.
	let preparedOutput: ReturnType<typeof prepareJsonArtifact>;
	try {
		preparedOutput = prepareJsonArtifact(
			ctx.runDir,
			"terminal-output",
			result.output,
		);
	} catch (err) {
		throw new PhaseError(
			`failed to serialize done.output: ${err instanceof Error ? err.message : String(err)}`,
			{
				cause: err,
				runId: ctx.runId,
				orchestratorName: ctx.config.name,
				phase: state.currentPhase,
			},
		);
	}

	// 2. Install immutable blob (may be orphaned if commit fails — acceptable).
	installPreparedArtifact(ctx.runDir, preparedOutput);

	// 3. Build state with ArtifactRef, commit fenced.
	const nowEpochMs = clock.nowEpochMs();
	const nowIso = clock.nowWallIso();

	const terminalResult: TerminalDoneRecord = {
		kind: "done",
		outputArtifact: preparedOutput.ref,
		completedAt: nowIso,
		completedAtEpochMs: nowEpochMs,
	};

	const newState: StateFile<S> = {
		...clearPendingYield(state),
		schemaVersion: STATE_SCHEMA_VERSION,
		phasesExecuted: state.phasesExecuted + 1,
		accumulatedDurationMs,
		terminalResult,
	};
	commitStateWithProjection(ctx, newState);

	// 4. Project canonical output.json (fenced) — must happen before
	//    announcing success, so a crash after commit but before projection
	//    does not emit a misleading success event.
	const outputPath = path.join(ctx.runDir, "output.json");
	projectCanonicalArtifactFenced(
		ctx,
		{
			pointer: "/terminalResult/outputArtifact",
			artifact: preparedOutput.ref,
		},
		outputPath,
	);

	// 5. Events only after both commit AND projection succeeded.
	const endedAt = clock.nowWallIso();
	ctx.logger.emit({
		eventType: "orchestrator_end",
		runId: ctx.runId,
		orchestratorName: ctx.config.name,
		success: true,
		durationMs: accumulatedDurationMs,
		phasesExecuted: newState.phasesExecuted,
		timestamp: endedAt,
	});

	// 6. Emit protocol block.  The canonical outputPath is guaranteed to
	//    exist because the fenced projection succeeded above.
	const block = writeProtocolBlock("DONE", {
		runId: ctx.runId,
		orchestrator: ctx.config.name,
		output: outputPath,
		success: true,
		phasesExecuted: newState.phasesExecuted,
		durationMs: accumulatedDurationMs,
	});
	process.stdout.write(block);

	releaseOwnershipFromContext(ctx);
	doExit(0);
}

export async function handleFail<S extends object>(
	ctx: DispatchContext<S>,
	state: StateFile<S>,
	result: { kind: "fail"; error: Error },
	accumulatedDurationMs: number,
): Promise<never> {
	const errorKind =
		result.error instanceof OrchestratorError
			? result.error.kind
			: "phase_error";

	const newState: StateFile<S> = {
		...clearPendingYield(state),
		schemaVersion: STATE_SCHEMA_VERSION,
		phasesExecuted: state.phasesExecuted + 1,
		accumulatedDurationMs,
	};
	commitStateWithProjection(ctx, newState);

	const nowIso = clock.nowWallIso();
	ctx.logger.emit({
		eventType: "phase_error",
		runId: ctx.runId,
		phase: state.currentPhase,
		errorKind,
		message: result.error.message.slice(0, 200),
		timestamp: nowIso,
	});
	ctx.logger.emit({
		eventType: "orchestrator_end",
		runId: ctx.runId,
		orchestratorName: ctx.config.name,
		success: false,
		durationMs: accumulatedDurationMs,
		phasesExecuted: newState.phasesExecuted,
		timestamp: nowIso,
	});

	const block = writeProtocolBlock("ERROR", {
		runId: ctx.runId,
		orchestrator: ctx.config.name,
		errorKind,
		message: result.error.message.slice(0, 200),
		phase: state.currentPhase,
		phasesExecuted: newState.phasesExecuted,
	});
	process.stdout.write(block);

	releaseOwnershipFromContext(ctx);
	doExit(1);
}
