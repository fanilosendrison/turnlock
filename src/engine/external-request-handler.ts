import * as path from "node:path";
import { externalRequestBinding } from "../bindings/external-request";
import { ProtocolError } from "../errors/concrete";
import { clock } from "../services/clock";
import { releaseLock } from "../services/lock";
import {
	type PendingExternalRequestRecord,
	type StateFile,
	writeStateAtomic,
} from "../services/state-io";
import type { PhaseResult } from "../types/phase";
import { type DispatchContext, doExit, writeFileSyncAtomic } from "./context";
import { assertExternalRequest } from "./external-request-validation";
import { clearPendingYield } from "./pending-yield";

export async function handleExternalRequest<S extends object>(
	ctx: DispatchContext<S>,
	state: StateFile<S>,
	result: Extract<PhaseResult<S>, { readonly kind: "external-request" }>,
	accumulatedDurationMs: number,
): Promise<never> {
	const { request, resumeAt } = result;
	const errorContext = {
		runId: ctx.runId,
		orchestratorName: ctx.config.name,
		phase: state.currentPhase,
	};
	assertExternalRequest(request, errorContext);

	if (!(resumeAt in ctx.config.phases)) {
		throw new ProtocolError(`unknown phase: ${resumeAt}`, errorContext);
	}
	if (state.usedLabels.includes(request.label)) {
		throw new ProtocolError("duplicate external request label", errorContext);
	}

	const emittedAtEpochMs = clock.nowEpochMs();
	const emittedAt = clock.nowWallIso();
	const manifest = externalRequestBinding.buildManifest(request, {
		runId: ctx.runId,
		orchestratorName: ctx.config.name,
		phase: state.currentPhase,
		resumeAt,
		emittedAt,
		emittedAtEpochMs,
		runDir: ctx.runDir,
	});
	const manifestPath = path.join(
		ctx.runDir,
		"external-requests",
		`${request.label}.json`,
	);
	writeFileSyncAtomic(manifestPath, JSON.stringify(manifest));

	const pendingExternalRequest: PendingExternalRequestRecord = {
		requestId: manifest.requestId,
		label: request.label,
		requestType: request.requestType,
		resumeAt,
		manifestPath,
		resultPath: manifest.resultPath,
		emittedAt,
		emittedAtEpochMs,
	};
	const newState: StateFile<S> = {
		...clearPendingYield(state),
		data: result.nextState,
		phasesExecuted: state.phasesExecuted + 1,
		lastTransitionAt: emittedAt,
		lastTransitionAtEpochMs: emittedAtEpochMs,
		accumulatedDurationMs,
		pendingExternalRequest,
		usedLabels: [...state.usedLabels, request.label],
	};
	writeStateAtomic(ctx.runDir, newState, ctx.config.stateSchema);

	ctx.logger.emit({
		eventType: "external_request_emit",
		runId: ctx.runId,
		phase: state.currentPhase,
		label: request.label,
		requestId: manifest.requestId,
		requestType: request.requestType,
		timestamp: emittedAt,
	});

	const block = externalRequestBinding.buildProtocolBlock(
		manifest,
		manifestPath,
		ctx.config.resumeCommand(ctx.runId),
	);
	process.stdout.write(block);

	releaseLock(ctx.lockPath, ctx.handle, clock, ctx.logger, ctx.runId);
	doExit(0);
}
