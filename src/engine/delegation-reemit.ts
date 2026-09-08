import * as path from "node:path";
import { resolveManifestTarget } from "../bindings/target.js";
import type { DelegationManifest } from "../bindings/types.js";
import { AbortedError, ProtocolError } from "../errors/concrete.js";
import { abortableSleep } from "../services/abortable-sleep.js";
import {
	installPreparedArtifact,
	prepareJsonArtifact,
	readAndVerifyArtifact,
} from "../services/artifact-store.js";
import { clock } from "../services/clock.js";
import type {
	PendingDelegationRecord,
	StateFile,
} from "../services/state-io.js";
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
	// Establish that the immutable source can produce an executable retry
	// before announcing or delaying it. Deterministic artifact, JSON, version,
	// and target failures are permanent and must not emit retry_scheduled.
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
	const rawManifest = JSON.parse(
		Buffer.from(oldManifestBytes).toString("utf-8"),
	) as Record<string, unknown>;
	const resolvedTarget = resolveManifestTarget(rawManifest, pd.label, {
		runId: ctx.runId,
		orchestratorName: ctx.config.name,
		phase,
	});
	const oldManifest = rawManifest as unknown as DelegationManifest;

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
		target: resolvedTarget.target,
		...(resolvedTarget.targetCompatibility === undefined
			? {}
			: { targetCompatibility: resolvedTarget.targetCompatibility }),
	});
	// 2. Prepare and install new immutable blob.
	const prepared = prepareJsonArtifact(
		ctx.runDir,
		"delegation-manifest",
		newManifest,
	);
	installPreparedArtifact(ctx.runDir, prepared);
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
		target: resolvedTarget.target,
		attempt: newAttempt,
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
