import * as fs from "node:fs";
import * as path from "node:path";
import type { DelegationManifest } from "../bindings/types";
import { MANIFEST_VERSION } from "../constants";
import { AbortedError, ProtocolError } from "../errors/concrete";
import { abortableSleep } from "../services/abortable-sleep";
import { clock } from "../services/clock";
import { releaseLock } from "../services/lock";
import {
	type PendingDelegationRecord,
	type StateFile,
	writeStateAtomic,
} from "../services/state-io";
import { type DispatchContext, doExit, writeFileSyncAtomic } from "./context";
import { clearPendingYield } from "./pending-yield";
import { reconstructManifest, selectBinding } from "./shared";

export async function reemitDelegationAttempt<S extends object>(
	ctx: DispatchContext<S>,
	state: StateFile<S>,
	pd: PendingDelegationRecord,
	decision: { retry: true; delayMs: number; reason: string },
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

	const oldManifest = JSON.parse(
		fs.readFileSync(pd.manifestPath, "utf-8"),
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
	const newManifestPath = path.join(
		ctx.runDir,
		"delegations",
		`${pd.label}-${newAttempt}.json`,
	);
	const newManifest = reconstructManifest(oldManifest, {
		attempt: newAttempt,
		emittedAt: newEmittedAt,
		emittedAtEpochMs: newEmittedAtEpochMs,
		deadlineAtEpochMs: newDeadlineAtEpochMs,
		label: pd.label,
		runDir: ctx.runDir,
	});

	writeFileSyncAtomic(newManifestPath, JSON.stringify(newManifest));

	const newState: StateFile<S> = {
		...clearPendingYield(state),
		pendingDelegation: {
			...pd,
			attempt: newAttempt,
			emittedAtEpochMs: newEmittedAtEpochMs,
			deadlineAtEpochMs: newDeadlineAtEpochMs,
			manifestPath: newManifestPath,
		},
		lastTransitionAt: newEmittedAt,
		lastTransitionAtEpochMs: newEmittedAtEpochMs,
	};
	writeStateAtomic(ctx.runDir, newState, ctx.config.stateSchema);

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
		newManifestPath,
		resumeCmd,
	);
	process.stdout.write(block);

	releaseLock(ctx.lockPath, ctx.handle, clock, ctx.logger, ctx.runId);
	doExit(0);
}
