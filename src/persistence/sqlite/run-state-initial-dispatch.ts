import { DbIntegrityError } from "./errors.js";
import type { LockHandle } from "./ownership-contracts.js";
import { beginImmediate, commit, rollback } from "./ownership-transactions.js";
import {
	bigintFromStateRow,
	computeStateDigest,
	isPendingInitialDispatchV1,
	stripAllPendingInitialDispatchMarkers,
} from "./run-state-codec.js";
import type {
	ClaimInitialDispatchParams,
	ClaimInitialDispatchResult,
} from "./run-state-contracts.js";
import { readAuthoritativeState } from "./run-state-read.js";
import { COMMIT_STATE_SQL, READ_RAW_STATE_JSON_SQL } from "./run-state-sql.js";
import type { SqliteConnection } from "./sqlite-driver.js";

function diagnoseClaimInitialDispatchUpdateFailure(
	db: SqliteConnection,
	handle: LockHandle,
	lockEpochMs: number,
): ClaimInitialDispatchResult {
	const ownershipRow = db
		.prepare(`SELECT ownership_status, owner_token, fence_token, lease_until_epoch_ms
			 FROM run_ownership WHERE singleton = 1`)
		.get() as
		| {
				ownership_status: string;
				owner_token: string | null;
				fence_token: number | bigint;
				lease_until_epoch_ms: number | null;
		  }
		| undefined;
	if (ownershipRow === undefined) {
		return {
			kind: "DB_FAILURE",
			cause: new DbIntegrityError(
				"ownership row missing during initial dispatch claim",
			),
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
	if (
		ownershipRow.lease_until_epoch_ms === null ||
		lockEpochMs >= ownershipRow.lease_until_epoch_ms
	) {
		return { kind: "EXPIRED_HANDLE" };
	}
	const stateRow = db
		.prepare("SELECT state_revision FROM run_state WHERE singleton = 1")
		.get() as { state_revision: number | bigint } | undefined;
	if (stateRow === undefined) {
		return {
			kind: "DB_FAILURE",
			cause: new DbIntegrityError(
				"state row missing during initial dispatch claim",
			),
		};
	}
	if (bigintFromStateRow(stateRow.state_revision) !== 0n) {
		return { kind: "REVISION_CONFLICT" };
	}
	return {
		kind: "DB_FAILURE",
		cause: new DbIntegrityError(
			"initial dispatch claim failed for unknown reason",
		),
	};
}

/** Atomically consume the one-time authorization for the initial phase. */
export function claimInitialDispatchUnderFence(
	params: ClaimInitialDispatchParams,
): ClaimInitialDispatchResult {
	const { db, handle } = params;
	try {
		beginImmediate(db);
	} catch (error) {
		return { kind: "DB_FAILURE", cause: error };
	}
	const lockEpochMs = (params.leaseClockEpochMs ?? Date.now)();
	const lockIso = new Date(lockEpochMs).toISOString();
	try {
		const current = readAuthoritativeState<object>(db);
		if (current.state === null) {
			rollback(db);
			return {
				kind: "DB_FAILURE",
				cause: new DbIntegrityError(
					"state row missing during initial dispatch claim",
				),
			};
		}
		if (current.state.stateRevision !== "0") {
			rollback(db);
			return { kind: "REVISION_CONFLICT" };
		}
		if (!current.pendingInitialDispatch) {
			rollback(db);
			return { kind: "INITIAL_DISPATCH_NOT_PENDING" };
		}
		const rawStateRow = db.prepare(READ_RAW_STATE_JSON_SQL).get() as
			| { state_json: string }
			| undefined;
		if (rawStateRow === undefined) {
			rollback(db);
			return {
				kind: "DB_FAILURE",
				cause: new DbIntegrityError(
					"raw state row missing during initial dispatch claim",
				),
			};
		}
		const parsedState = JSON.parse(rawStateRow.state_json) as unknown;
		if (
			typeof parsedState !== "object" ||
			parsedState === null ||
			Array.isArray(parsedState)
		) {
			throw new DbIntegrityError(
				"state_json must be an object during initial dispatch claim",
			);
		}
		const stateWithoutPendingInitialDispatch = parsedState as Record<
			string,
			unknown
		>;
		if (!isPendingInitialDispatchV1(stateWithoutPendingInitialDispatch)) {
			rollback(db);
			return { kind: "INITIAL_DISPATCH_NOT_PENDING" };
		}
		stripAllPendingInitialDispatchMarkers(stateWithoutPendingInitialDispatch);
		const nextStateJson = JSON.stringify(stateWithoutPendingInitialDispatch);
		const nextStateDigest = computeStateDigest(nextStateJson);
		const claimedRow = db.prepare(COMMIT_STATE_SQL).get({
			":schema_version": current.state.schemaVersion,
			":state_json": nextStateJson,
			":state_digest": nextStateDigest,
			":owner_token": handle.ownerToken,
			":fence_token": handle.fenceToken,
			":now_epoch": lockEpochMs,
			":now_iso": lockIso,
			":incarnation_id": handle.incarnationId,
			":expected_revision": 0n,
		}) as unknown | undefined;
		if (claimedRow === undefined) {
			rollback(db);
			return diagnoseClaimInitialDispatchUpdateFailure(db, handle, lockEpochMs);
		}
		const claimed = readAuthoritativeState<object>(db);
		if (claimed.state === null || claimed.digest === null) {
			throw new DbIntegrityError(
				"claimed initial dispatch state could not be re-read",
			);
		}
		if (claimed.state.stateRevision !== "1" || claimed.pendingInitialDispatch) {
			throw new DbIntegrityError(
				"initial dispatch claim did not produce revision 1 without its marker",
			);
		}
		try {
			commit(db);
		} catch (error) {
			rollback(db);
			return { kind: "DB_FAILURE", cause: error };
		}
		return {
			kind: "CLAIMED",
			committed: { state: claimed.state, stateDigest: claimed.digest },
		};
	} catch (error) {
		rollback(db);
		return { kind: "DB_FAILURE", cause: error };
	}
}
