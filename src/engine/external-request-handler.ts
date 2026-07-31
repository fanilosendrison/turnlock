import * as path from "node:path";
import { externalRequestBinding } from "../bindings/external-request";
import { ProtocolError } from "../errors/concrete";
import { clock } from "../services/clock";
import { contentDigest } from "../services/content-digest";
import type {
	PendingExternalRequestRecord,
	StateFile,
} from "../services/state-io";
import type { PhaseResult } from "../types/phase";
import {
	type DispatchContext,
	doExit,
	isTestExitSignal,
	writeFileSyncAtomic,
} from "./context";
import { assertExternalRequest } from "./external-request-validation";
import { clearPendingYield } from "./pending-yield";
import {
	commitStateWithProjection,
	releaseOwnershipFromContext,
} from "./state-commit";
import { emitFatalError } from "./terminal-handlers";

interface PreparedPublication {
	readonly ok: true;
	readonly block: string;
}

interface FailedPublicationPreparation {
	readonly ok: false;
	readonly error: unknown;
}

export async function handleExternalRequest<S extends object>(
	ctx: DispatchContext<S>,
	state: StateFile<S>,
	result: Extract<PhaseResult<S>, { readonly kind: "external-request" }>,
	accumulatedDurationMs: number,
): Promise<never> {
	let durableState: StateFile<S> | null = null;
	try {
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
		const manifestBytes = Buffer.from(JSON.stringify(manifest), "utf-8");
		const manifestDigest = contentDigest(manifestBytes);

		const publication: PreparedPublication | FailedPublicationPreparation =
			(() => {
				try {
					return {
						ok: true,
						block: externalRequestBinding.buildProtocolBlock(
							manifest,
							manifestPath,
							ctx.config.resumeCommand(ctx.runId),
						),
					};
				} catch (error) {
					return { ok: false, error };
				}
			})();

		writeFileSyncAtomic(manifestPath, manifestBytes);

		const pendingExternalRequest: PendingExternalRequestRecord = {
			requestId: manifest.requestId,
			label: request.label,
			requestType: request.requestType,
			resumeAt,
			manifestPath,
			manifestDigest,
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
		commitStateWithProjection(ctx, newState);
		durableState = newState;

		if (!publication.ok) throw publication.error;

		ctx.logger.emit({
			eventType: "external_request_emit",
			runId: ctx.runId,
			phase: state.currentPhase,
			label: request.label,
			requestId: manifest.requestId,
			requestType: request.requestType,
			timestamp: emittedAt,
		});

		process.stdout.write(publication.block);
		releaseOwnershipFromContext(ctx);
		doExit(0);
	} catch (error) {
		if (isTestExitSignal(error)) throw error;
		await emitFatalError(ctx, durableState ?? state, state.currentPhase, error);
		return undefined as never;
	}
}
