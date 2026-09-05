import * as path from "node:path";
import type { DelegationManifest } from "../bindings/types.js";
import { MANIFEST_VERSION } from "../constants.js";
import { AbortedError, ProtocolError } from "../errors/concrete.js";
import { abortableSleep } from "../services/abortable-sleep.js";
import {
	prepareJsonArtifact,
	readAndVerifyArtifact,
} from "../services/artifact-store.js";
import { clock } from "../services/clock.js";
import type {
	PendingDelegationRecord,
	StateFile,
} from "../services/state-io.js";
import { installPreparedArtifactFenced } from "./artifact-commit.js";
import { type DispatchContext, doExit } from "./context.js";
import { clearPendingYield } from "./pending-yield.js";
import { writeProtocolStdout } from "./protocol-stdout.js";
import { reconstructManifest, selectBinding } from "./shared.js";
import {
	commitStateWithProjection,
	projectCanonicalArtifactFenced,
	releaseOwnershipFromContext,
} from "./state-commit.js";
export async function reemitDelegationAttempt<S extends object>(
	ctx: DispatchContext<S>,
	state: StateFile<S>,
	pd: PendingDelegationRecord,
	decision: {
		retry: true;
		delayMs: number;
		reason: string;
	},
	phase: string,
	abortMessage = "aborted during retry sleep",
): Promise<never> {
	ctx.logger.emit({
		eventType: "retry_scheduled",
		runId: ctx.runId,
		phase,
		label: pd.label,
		attempt: pd.attempt + 1,
		delayMs: decision.delayMs,
		reason: decision.reason,
		timestamp: clock.nowWallIso(),
	});
	try {
		await abortableSleep(decision.delayMs, ctx.abortController.signal);
	} catch (e) {
		throw new AbortedError(abortMessage, {
			cause: e,
			runId: ctx.runId,
			phase,
		});
	}
	// 1. Read and verify the old manifest via ArtifactRef.
	if (!pd.manifestArtifact) {
		throw new ProtocolError("pending delegation has no manifest artifact", {
			runId: ctx.runId,
			orchestratorName: ctx.config.name,
			phase,
		});
	}
	const oldManifestBytes = readAndVerifyArtifact(
		ctx.runDir,
		pd.manifestArtifact,
	);
	const oldManifest = JSON.parse(
		Buffer.from(oldManifestBytes).toString("utf-8"),
	) as DelegationManifest;
	if (oldManifest.manifestVersion !== MANIFEST_VERSION) {
		throw new ProtocolError(
			`manifestVersion mismatch: expected ${MANIFEST_VERSION}, got ${String(oldManifest.manifestVersion)}`,
			{
				runId: ctx.runId,
				orchestratorName: ctx.config.name,
				phase,
			},
		);
	}
	const newAttempt = pd.attempt + 1;
	const newEmittedAtEpochMs = clock.nowEpochMs();
	const newEmittedAt = clock.nowWallIso();
	const newDeadlineAtEpochMs = newEmittedAtEpochMs + oldManifest.timeoutMs;
	const newManifest = reconstructManifest(oldManifest, {
		attempt: newAttempt,
		emittedAt: newEmittedAt,
		emittedAtEpochMs: newEmittedAtEpochMs,
		deadlineAtEpochMs: newDeadlineAtEpochMs,
		label: pd.label,
		runDir: ctx.runDir,
	});
	// 2. Prepare and install new immutable blob.
	const prepared = prepareJsonArtifact(
		ctx.runDir,
		"delegation-manifest",
		newManifest,
	);
	installPreparedArtifactFenced(ctx, prepared);
	// 3. Build new state with updated ArtifactRef.
	const newState: StateFile<S> = {
		...clearPendingYield(state),
		pendingDelegation: {
			...pd,
			attempt: newAttempt,
			emittedAtEpochMs: newEmittedAtEpochMs,
			deadlineAtEpochMs: newDeadlineAtEpochMs,
			manifestArtifact: prepared.ref,
		},
		lastTransitionAt: newEmittedAt,
		lastTransitionAtEpochMs: newEmittedAtEpochMs,
	};
	// 4. Commit fenced.
	commitStateWithProjection(ctx, newState);
	// 5. Project canonical manifest (fenced) before announcing success.
	const canonicalManifestPath = path.join(
		ctx.runDir,
		"delegations",
		`${pd.label}-${newAttempt}.json`,
	);
	projectCanonicalArtifactFenced(
		ctx,
		{
			pointer: "/pendingDelegation/manifestArtifact",
			artifact: prepared.ref,
		},
		canonicalManifestPath,
	);
	// 6. Events + protocol only after successful commit AND projection.
	ctx.logger.emit({
		eventType: "delegation_emit",
		runId: ctx.runId,
		phase,
		label: pd.label,
		kind: pd.kind,
		jobCount: pd.jobIds?.length ?? 1,
		timestamp: newEmittedAt,
	});
	const resumeCmd = ctx.config.resumeCommand(ctx.runId);
	const binding = selectBinding(pd.kind);
	const block = binding.buildProtocolBlock(
		newManifest,
		canonicalManifestPath,
		resumeCmd,
	);
	writeProtocolStdout(block);
	releaseOwnershipFromContext(ctx);
	doExit(0);
}
