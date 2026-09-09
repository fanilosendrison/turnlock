import {
	AuthorityLostError,
	PersistenceFailureError,
	ProtocolError,
	StateRevisionConflictError,
} from "../errors/concrete.js";
import type {
	CommittedState,
	StateRecord,
} from "../persistence/sqlite/run-state-store.js";
import {
	projectAuthoritativeStateFenced,
	claimInitialDispatchUnderFence as sqliteClaimInitialDispatchUnderFence,
	commitState as sqliteCommitState,
} from "../persistence/sqlite/run-state-store.js";
import type { WorkflowCompletionKind } from "../persistence/sqlite/workflow-lifecycle.js";
import { clock as defaultClock } from "../services/clock.js";
import type { StateFile } from "../services/state-io.js";
import {
	assertAuthoritativeResultHandled,
	stateOperationErrorOptions,
} from "./authoritative-operation-errors.js";
import type { StateTransitionContext } from "./state-commit-contracts.js";

/** Commit a state transition through the authoritative SQLite store,
 *  then project state.json under fence. Updates ctx.stateRevision on success.
 *
 *  Throws AuthorityLostError on stale/expired ownership,
 *  StateRevisionConflictError on revision conflict, and
 *  PersistenceFailureError on database failure. */
export function commitStateWithProjection<S extends object>(
	ctx: StateTransitionContext,
	nextState: StateFile<S>,
	terminalKind?: WorkflowCompletionKind,
): CommittedState<object> {
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
		...(nextState.terminalResult !== undefined
			? { terminalResult: nextState.terminalResult }
			: {}),
	};
	const result = sqliteCommitState({
		db: ctx.runDb.connection,
		handle: ctx.handle,
		expectedRevision: ctx.stateRevision,
		nextState: stateRecord,
		nowEpochMs: defaultClock.nowEpochMs(),
		nowIso: defaultClock.nowWallIso(),
		leaseClockEpochMs: () => defaultClock.nowEpochMs(),
		...(terminalKind !== undefined ? { terminalKind } : {}),
	});
	switch (result.kind) {
		case "COMMITTED": {
			ctx.stateRevision = result.committed.state.stateRevision;
			projectAuthoritativeStateFenced(
				ctx.runDb.connection,
				ctx.handle,
				ctx.runDir,
				result.committed.state.stateRevision,
				result.committed.stateDigest,
			);
			return result.committed;
		}
		case "STALE_HANDLE":
			throw new AuthorityLostError(
				"State commit rejected because the ownership handle is stale",
				{
					operation: "state_commit",
					reason: "STALE_HANDLE",
					...stateOperationErrorOptions(ctx),
				},
			);
		case "EXPIRED_HANDLE":
			throw new AuthorityLostError(
				"State commit rejected because the ownership lease expired",
				{
					operation: "state_commit",
					reason: "EXPIRED_HANDLE",
					...stateOperationErrorOptions(ctx),
				},
			);
		case "REVISION_CONFLICT":
			throw new StateRevisionConflictError(
				`State revision conflict: expected ${ctx.stateRevision}`,
				stateOperationErrorOptions(ctx),
			);
		case "WORKFLOW_TERMINAL":
			throw new ProtocolError(
				"State commit rejected because the workflow is already terminal",
				stateOperationErrorOptions(ctx),
			);
		case "DB_FAILURE":
			throw new PersistenceFailureError("SQLite state commit failed", {
				operation: "state_commit",
				cause: result.cause,
				...stateOperationErrorOptions(ctx),
			});
		default:
			return assertAuthoritativeResultHandled(result);
	}
}

/** Consume the one-time initial-dispatch authorization durably, then project
 *  the claimed authority before a phase can execute. */
export function claimInitialDispatchWithProjection(
	ctx: StateTransitionContext,
): CommittedState<object> {
	const result = sqliteClaimInitialDispatchUnderFence({
		db: ctx.runDb.connection,
		handle: ctx.handle,
		leaseClockEpochMs: () => defaultClock.nowEpochMs(),
	});
	switch (result.kind) {
		case "CLAIMED":
			ctx.stateRevision = result.committed.state.stateRevision;
			projectAuthoritativeStateFenced(
				ctx.runDb.connection,
				ctx.handle,
				ctx.runDir,
				result.committed.state.stateRevision,
				result.committed.stateDigest,
			);
			return result.committed;
		case "INITIAL_DISPATCH_NOT_PENDING":
			throw new ProtocolError(
				"Initial dispatch claim rejected: no claimable initial dispatch marker",
				stateOperationErrorOptions(ctx),
			);
		case "STALE_HANDLE":
			throw new AuthorityLostError(
				"Initial dispatch claim rejected because the ownership handle is stale",
				{
					operation: "state_commit",
					reason: "STALE_HANDLE",
					...stateOperationErrorOptions(ctx),
				},
			);
		case "EXPIRED_HANDLE":
			throw new AuthorityLostError(
				"Initial dispatch claim rejected because the ownership lease expired",
				{
					operation: "state_commit",
					reason: "EXPIRED_HANDLE",
					...stateOperationErrorOptions(ctx),
				},
			);
		case "REVISION_CONFLICT":
			throw new StateRevisionConflictError(
				"Initial dispatch claim requires authoritative state revision 0",
				stateOperationErrorOptions(ctx),
			);
		case "DB_FAILURE":
			throw new PersistenceFailureError(
				"SQLite initial dispatch claim failed",
				{
					operation: "state_commit",
					cause: result.cause,
					...stateOperationErrorOptions(ctx),
				},
			);
		default:
			return assertAuthoritativeResultHandled(result);
	}
}
