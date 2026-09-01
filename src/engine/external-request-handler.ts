import * as path from "node:path";
import { externalRequestBinding } from "../bindings/external-request.js";
import { ProtocolError } from "../errors/concrete.js";
import {
	installPreparedArtifact,
	prepareJsonArtifact,
} from "../services/artifact-store.js";
import { clock } from "../services/clock.js";
import type {
	PendingExternalRequestRecord,
	StateFile,
} from "../services/state-io.js";
import type { PhaseResult } from "../types/phase.js";
import { type DispatchContext, doExit, isTestExitSignal } from "./context.js";
import { assertExternalRequest } from "./external-request-validation.js";
import { clearPendingYield } from "./pending-yield.js";
import { writeProtocolStdout } from "./protocol-stdout.js";
import {
	commitStateWithProjection,
	projectCanonicalArtifactFenced,
	releaseOwnershipFromContext,
} from "./state-commit.js";
import { emitFatalError } from "./terminal-handlers.js";

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
	result: Extract<
		PhaseResult<S>,
		{
			readonly kind: "external-request";
		}
	>,
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
		// 1. Prepare immutable artifact.
		const prepared = prepareJsonArtifact(
			ctx.runDir,
			"external-request-manifest",
			manifest,
		);
		// 2. Install immutable blob.
		installPreparedArtifact(ctx.runDir, prepared);
		// 3. Build the protocol block in memory (not emitted yet).
		const canonicalManifestPath = path.join(
			ctx.runDir,
			"external-requests",
			`${request.label}.json`,
		);
		const publication: PreparedPublication | FailedPublicationPreparation =
			(() => {
				try {
					return {
						ok: true,
						block: externalRequestBinding.buildProtocolBlock(
							manifest,
							canonicalManifestPath,
							ctx.config.resumeCommand(ctx.runId),
						),
					};
				} catch (error) {
					return { ok: false, error };
				}
			})();
		// 4. Build state with ArtifactRef.
		const pendingExternalRequest: PendingExternalRequestRecord = {
			requestId: manifest.requestId,
			label: request.label,
			requestType: request.requestType,
			resumeAt,
			manifestArtifact: prepared.ref,
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
		// 5. Commit fenced.
		commitStateWithProjection(ctx, newState);
		durableState = newState;
		if (!publication.ok) throw publication.error;
		// 6. Project canonical manifest (fenced) before events.
		projectCanonicalArtifactFenced(
			ctx,
			{
				pointer: "/pendingExternalRequest/manifestArtifact",
				artifact: prepared.ref,
			},
			canonicalManifestPath,
		);
		// 7. Events only after successful commit AND projection.
		ctx.logger.emit({
			eventType: "external_request_emit",
			runId: ctx.runId,
			phase: state.currentPhase,
			label: request.label,
			requestId: manifest.requestId,
			requestType: request.requestType,
			timestamp: emittedAt,
		});
		// 8. Emit protocol block after commit + projection.
		writeProtocolStdout(publication.block);
		releaseOwnershipFromContext(ctx);
		doExit(0);
	} catch (error) {
		if (isTestExitSignal(error)) throw error;
		await emitFatalError(ctx, durableState ?? state, state.currentPhase, error);
		return undefined as never;
	}
}
