import { STATE_SCHEMA_VERSION } from "../../constants.js";
import { DbIntegrityError } from "./errors.js";
import { beginImmediate, commit, rollback } from "./ownership-transactions.js";
import { bigintFromStateRow, computeStateDigest } from "./run-state-codec.js";
import type {
	InitializeStateParams,
	InitializeStateResult,
	StateRecord,
} from "./run-state-contracts.js";
import { readAuthoritativeState } from "./run-state-read.js";
import { INITIALIZE_STATE_SQL } from "./run-state-sql.js";

/** Establish the initial authoritative state row under the current fence. */
export function initializeStateUnderFence(
	params: InitializeStateParams,
): InitializeStateResult {
	const {
		db,
		handle,
		initialState,
		nowEpochMs: _nowEpochMs,
		nowIso: _nowIso,
	} = params;
	const schemaVersion =
		(initialState.schemaVersion as number) ?? STATE_SCHEMA_VERSION;
	const jsonStr = JSON.stringify(initialState);
	const digest = computeStateDigest(jsonStr);
	try {
		beginImmediate(db);
	} catch (error) {
		return { kind: "DB_FAILURE", cause: error };
	}
	const lockEpochMs = (params.leaseClockEpochMs ?? Date.now)();
	const lockIso = new Date(lockEpochMs).toISOString();
	try {
		const row = db.prepare(INITIALIZE_STATE_SQL).get({
			":incarnation_id": handle.incarnationId,
			":schema_version": schemaVersion,
			":state_json": jsonStr,
			":state_digest": digest,
			":owner_token": handle.ownerToken,
			":fence_token": handle.fenceToken,
			":now_epoch": lockEpochMs,
			":now_iso": lockIso,
		}) as
			| {
					state_revision: number | bigint;
					state_json: string;
					state_digest: string;
					committed_by_fence_token: number | bigint;
			  }
			| undefined;
		if (row !== undefined) {
			try {
				commit(db);
			} catch (error) {
				rollback(db);
				return { kind: "DB_FAILURE", cause: error };
			}
			const revision = String(bigintFromStateRow(row.state_revision));
			return {
				kind: "INITIALIZED",
				committed: {
					state: {
						...(initialState as unknown as StateRecord<object>),
						runIncarnationId: handle.incarnationId,
						stateRevision: revision,
						committedFenceToken: String(
							bigintFromStateRow(row.committed_by_fence_token),
						),
					},
					stateDigest: row.state_digest,
				},
			};
		}
		rollback(db);
		const ownershipRow = db
			.prepare(`SELECT ownership_status, owner_token, fence_token,
				        lease_until_epoch_ms
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
					"ownership row missing during initialization",
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
			ownershipRow.lease_until_epoch_ms !== null &&
			lockEpochMs >= ownershipRow.lease_until_epoch_ms
		) {
			return { kind: "EXPIRED_HANDLE" };
		}
		const existing = db
			.prepare("SELECT 1 FROM run_state WHERE singleton = 1")
			.get();
		if (existing !== undefined) {
			const read = readAuthoritativeState(db);
			if (read.state !== null) {
				return {
					kind: "ALREADY_INITIALIZED",
					state: read.state,
					digest: read.digest ?? "",
				};
			}
			return {
				kind: "DB_FAILURE",
				cause: new DbIntegrityError(
					"run_state row exists but could not be read",
				),
			};
		}
		return {
			kind: "DB_FAILURE",
			cause: new DbIntegrityError("initialize state failed for unknown reason"),
		};
	} catch (error) {
		rollback(db);
		return { kind: "DB_FAILURE", cause: error };
	}
}
