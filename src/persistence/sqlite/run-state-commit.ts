import { DbIntegrityError } from "./errors.js";
import { beginImmediate, commit, rollback } from "./ownership-transactions.js";
import { bigintFromStateRow, computeStateDigest } from "./run-state-codec.js";
import type {
	CommitStateParams,
	CommitStateResult,
	StateRecord,
} from "./run-state-contracts.js";
import { COMMIT_STATE_SQL } from "./run-state-sql.js";
import {
	readWorkflowLifecycleRow,
	transitionWorkflowToTerminalInTransaction,
	WORKFLOW_STATUS_TERMINAL,
} from "./workflow-lifecycle.js";

function assertTerminalTransitionMatchesState(
	state: StateRecord<object>,
	terminalKind: CommitStateParams<object>["terminalKind"],
): void {
	const hasPendingContinuation =
		state.pendingDelegation !== undefined ||
		state.pendingExternalRequest !== undefined;
	if (terminalKind === undefined) {
		if (state.terminalResult !== undefined) {
			throw new DbIntegrityError(
				"terminalResult requires an explicit terminal workflow transition",
			);
		}
		return;
	}
	if (hasPendingContinuation) {
		throw new DbIntegrityError(
			"terminal workflow transition cannot retain a continuation",
		);
	}
	if (terminalKind === "DONE" && state.terminalResult === undefined) {
		throw new DbIntegrityError("DONE transition requires terminalResult");
	}
	if (terminalKind === "FAIL" && state.terminalResult !== undefined) {
		throw new DbIntegrityError("FAIL transition cannot carry terminalResult");
	}
}

/** Commit a state revision under the current ownership fence. */
export function commitState<S extends object>(
	params: CommitStateParams<S>,
): CommitStateResult {
	const {
		db,
		handle,
		expectedRevision,
		nextState,
		nowEpochMs: _nowEpochMs,
		nowIso: _nowIso,
	} = params;
	const expectedRevisionBigInt = BigInt(expectedRevision);
	const jsonStr = JSON.stringify(nextState);
	const digest = computeStateDigest(jsonStr);
	try {
		beginImmediate(db);
	} catch (error) {
		return { kind: "DB_FAILURE", cause: error };
	}
	const lockEpochMs = (params.leaseClockEpochMs ?? Date.now)();
	const lockIso = new Date(lockEpochMs).toISOString();
	try {
		const row = db.prepare(COMMIT_STATE_SQL).get({
			":schema_version": nextState.schemaVersion,
			":state_json": jsonStr,
			":state_digest": digest,
			":owner_token": handle.ownerToken,
			":fence_token": handle.fenceToken,
			":now_epoch": lockEpochMs,
			":now_iso": lockIso,
			":incarnation_id": handle.incarnationId,
			":expected_revision": expectedRevisionBigInt,
		}) as
			| {
					state_revision: number | bigint;
					state_json: string;
					state_digest: string;
					committed_by_fence_token: number | bigint;
			  }
			| undefined;
		if (row === undefined) {
			rollback(db);
			const ownershipRow = db
				.prepare(`SELECT ownership_status, owner_token, fence_token,
					        lease_until_epoch_ms
					 FROM run_ownership WHERE singleton = 1`)
				.get() as
				| {
						ownership_status: string;
						owner_token: string;
						fence_token: number | bigint;
						lease_until_epoch_ms: number;
				  }
				| undefined;
			if (ownershipRow === undefined) {
				return {
					kind: "DB_FAILURE",
					cause: new DbIntegrityError("ownership row missing during commit"),
				};
			}
			if (ownershipRow.ownership_status !== "HELD") {
				return { kind: "STALE_HANDLE" };
			}
			if (ownershipRow.owner_token !== handle.ownerToken) {
				return { kind: "STALE_HANDLE" };
			}
			if (bigintFromStateRow(ownershipRow.fence_token) !== handle.fenceToken) {
				return { kind: "STALE_HANDLE" };
			}
			if (lockEpochMs >= ownershipRow.lease_until_epoch_ms) {
				return { kind: "EXPIRED_HANDLE" };
			}
			const stateRow = db
				.prepare("SELECT state_revision FROM run_state WHERE singleton = 1")
				.get() as { state_revision: number | bigint } | undefined;
			if (
				stateRow !== undefined &&
				bigintFromStateRow(stateRow.state_revision) !== expectedRevisionBigInt
			) {
				return { kind: "REVISION_CONFLICT" };
			}
			const lifecycle = readWorkflowLifecycleRow(db, handle.incarnationId);
			if (lifecycle === null) {
				return {
					kind: "DB_FAILURE",
					cause: new DbIntegrityError(
						"workflow lifecycle row missing during commit",
					),
				};
			}
			if (lifecycle.status === WORKFLOW_STATUS_TERMINAL) {
				return { kind: "WORKFLOW_TERMINAL" };
			}
			return {
				kind: "DB_FAILURE",
				cause: new DbIntegrityError("state commit failed for unknown reason"),
			};
		}
		assertTerminalTransitionMatchesState(
			nextState as StateRecord<object>,
			params.terminalKind,
		);
		if (params.terminalKind !== undefined) {
			transitionWorkflowToTerminalInTransaction(
				db,
				handle.incarnationId,
				params.terminalKind,
				lockEpochMs,
			);
		}
		try {
			commit(db);
		} catch (error) {
			rollback(db);
			return { kind: "DB_FAILURE", cause: error };
		}
		return {
			kind: "COMMITTED",
			committed: {
				state: {
					...nextState,
					runIncarnationId: handle.incarnationId,
					stateRevision: String(bigintFromStateRow(row.state_revision)),
					committedFenceToken: String(
						bigintFromStateRow(row.committed_by_fence_token),
					),
				},
				stateDigest: row.state_digest,
			},
		};
	} catch (error) {
		rollback(db);
		return { kind: "DB_FAILURE", cause: error };
	}
}
