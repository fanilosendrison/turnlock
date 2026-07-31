// Engine-level state commit helpers — thin wrappers around the SQLite
// persistence layer.  Handlers use these instead of importing from
// persistence/ or services/state-io directly.

import {
	type LockHandle,
	refreshOwnership,
	releaseOwnership,
} from "../persistence/sqlite/ownership";
import type { RunDatabase } from "../persistence/sqlite/run-database";
import {
	type CommitStateResult,
	projectStateJson,
	type StateRecord,
	commitState as sqliteCommitState,
} from "../persistence/sqlite/run-state-store";
import { clock as defaultClock } from "../services/clock";
import type { StateFile } from "../services/state-io";

export type { LockHandle } from "../persistence/sqlite/ownership";

/** Commit a state transition through the authoritative SQLite store,
 *  then project state.json.  Updates ctx.stateRevision on success. */
export function commitStateWithProjection<S extends object>(
	ctx: {
		readonly runDb: RunDatabase;
		readonly handle: LockHandle;
		readonly runDir: string;
		stateRevision: string;
	},
	nextState: StateFile<S>,
): CommitStateResult {
	const stateRecord: StateRecord<S> = {
		schemaVersion: nextState.schemaVersion,
		runId: nextState.runId,
		orchestratorName: nextState.orchestratorName,
		startedAt: nextState.startedAt,
		startedAtEpochMs: nextState.startedAtEpochMs,
		lastTransitionAt: nextState.lastTransitionAt,
		lastTransitionAtEpochMs: nextState.lastTransitionAtEpochMs,
		currentPhase: nextState.currentPhase,
		phasesExecuted: nextState.phasesExecuted,
		accumulatedDurationMs: nextState.accumulatedDurationMs,
		data: nextState.data,
		pendingDelegation: nextState.pendingDelegation,
		pendingExternalRequest: nextState.pendingExternalRequest,
		usedLabels: nextState.usedLabels,
		runIncarnationId: ctx.handle.incarnationId,
		stateRevision: ctx.stateRevision,
		committedFenceToken: "0",
	};

	const result = sqliteCommitState({
		db: ctx.runDb.connection,
		handle: ctx.handle,
		expectedRevision: ctx.stateRevision,
		nextState: stateRecord,
		nowEpochMs: defaultClock.nowEpochMs(),
		nowIso: defaultClock.nowWallIso(),
	});

	if (result.kind === "COMMITTED") {
		ctx.stateRevision = result.committed.state.stateRevision;
		projectStateJson(
			ctx.runDir,
			result.committed.state,
			result.committed.stateDigest,
		);
	}

	return result;
}

/** Release ownership through the SQLite store. */
export function releaseOwnershipFromContext(ctx: {
	readonly runDb: RunDatabase;
	readonly handle: LockHandle;
}): void {
	releaseOwnership({
		db: ctx.runDb.connection,
		handle: ctx.handle,
	});
}

/** Refresh the ownership lease. */
export function refreshOwnershipFromContext(ctx: {
	readonly runDb: RunDatabase;
	readonly handle: LockHandle;
}): void {
	const now = defaultClock.nowEpochMs();
	refreshOwnership({
		db: ctx.runDb.connection,
		handle: ctx.handle,
		nowEpochMs: now,
		leaseDurationMs: 30 * 60 * 1000, // DEFAULT_IDLE_LEASE_MS
	});
}
