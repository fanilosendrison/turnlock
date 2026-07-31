// Authoritative state store — state mutations committed under the fence token.
//
// Every commit CAS on (incarnation_id, owner_token, fence_token, lease,
// state_revision).  The `state.json` file is a projection, not the authority.

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { TerminalDoneRecord } from "../../types/artifacts";
import { DbIntegrityError } from "./errors";
import { beginImmediate, commit, type LockHandle, rollback } from "./ownership";
import type { SqliteConnection } from "./sqlite-driver";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StateAuthorityMetadata {
	readonly runIncarnationId: string;
	readonly stateRevision: string;
	readonly committedFenceToken: string;
}

export interface StateRecord<S extends object> {
	readonly schemaVersion: number;
	readonly runId: string;
	readonly orchestratorName: string;
	readonly startedAt: string;
	readonly startedAtEpochMs: number;
	readonly lastTransitionAt: string;
	readonly lastTransitionAtEpochMs: number;
	readonly currentPhase: string;
	readonly phasesExecuted: number;
	readonly accumulatedDurationMs: number;
	readonly data: S;
	readonly pendingDelegation?: unknown;
	readonly pendingExternalRequest?: unknown;
	readonly terminalResult?: TerminalDoneRecord;
	readonly usedLabels: readonly string[];
	// Authority metadata — only present when read from SQLite.
	readonly runIncarnationId: string;
	readonly stateRevision: string;
	readonly committedFenceToken: string;
}

export interface CommittedState<S extends object> {
	readonly state: StateRecord<S>;
	readonly stateDigest: string;
}

export interface CommitStateParams<S extends object> {
	readonly db: SqliteConnection;
	readonly handle: LockHandle;
	readonly expectedRevision: string;
	readonly nextState: StateRecord<S>;
	readonly nowEpochMs: number;
	readonly nowIso: string;
}

export type CommitStateResult =
	| { readonly kind: "COMMITTED"; readonly committed: CommittedState<object> }
	| { readonly kind: "STALE_HANDLE" }
	| { readonly kind: "EXPIRED_HANDLE" }
	| { readonly kind: "REVISION_CONFLICT" }
	| { readonly kind: "DB_FAILURE"; readonly cause: unknown };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function bigintFromRow(value: unknown): bigint {
	if (typeof value === "bigint") return value;
	if (typeof value === "number") return BigInt(value);
	throw new DbIntegrityError(`expected bigint, got ${typeof value}`);
}

function computeDigest(jsonStr: string): string {
	return `sha256:${createHash("sha256").update(jsonStr).digest("hex")}`;
}

// ---------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------

const ENSURE_STATE_ROW_SQL = `
INSERT OR IGNORE INTO run_state
    (singleton, incarnation_id, state_schema_version,
     state_json, state_digest,
     committed_by_owner_token, committed_by_fence_token,
     committed_at_epoch_ms, committed_at_iso)
VALUES (1, :incarnation_id, :schema_version,
        :state_json, :state_digest,
        '', 0,
        :now_epoch, :now_iso)
`;

const COMMIT_STATE_SQL = `
UPDATE run_state
SET
    state_revision = state_revision + 1,
    state_schema_version = :schema_version,
    state_json = :state_json,
    state_digest = :state_digest,
    committed_by_owner_token = :owner_token,
    committed_by_fence_token = :fence_token,
    committed_at_epoch_ms = :now_epoch,
    committed_at_iso = :now_iso
WHERE singleton = 1
  AND incarnation_id = :incarnation_id
  AND state_revision = :expected_revision
  AND EXISTS (
      SELECT 1
      FROM run_ownership
      WHERE run_ownership.singleton = 1
        AND run_ownership.incarnation_id = :incarnation_id
        AND run_ownership.ownership_status = 'HELD'
        AND run_ownership.owner_token = :owner_token
        AND run_ownership.fence_token = :fence_token
        AND run_ownership.lease_until_epoch_ms > :now_epoch
  )
RETURNING
    state_revision,
    state_json,
    state_digest,
    committed_by_fence_token
`;

const READ_STATE_SQL = `
SELECT
    rs.state_schema_version,
    rs.state_json,
    rs.state_digest,
    rs.state_revision,
    rs.committed_by_fence_token,
    ri.run_id,
    ri.orchestrator_name,
    ri.incarnation_id,
    ri.created_at_iso AS started_at,
    ri.created_at_epoch_ms AS started_at_epoch_ms
FROM run_state rs
JOIN run_incarnation ri ON ri.incarnation_id = rs.incarnation_id
WHERE rs.singleton = 1
`;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function ensureInitialStateRow(
	db: SqliteConnection,
	incarnationId: string,
	schemaVersion: number,
	initialJson: string,
	nowEpochMs: number,
	nowIso: string,
): void {
	const digest = computeDigest(initialJson);
	db.prepare(ENSURE_STATE_ROW_SQL).run({
		":incarnation_id": incarnationId,
		":schema_version": schemaVersion,
		":state_json": initialJson,
		":state_digest": digest,
		":now_epoch": nowEpochMs,
		":now_iso": nowIso,
	});
}

export function commitState<S extends object>(
	params: CommitStateParams<S>,
): CommitStateResult {
	const { db, handle, expectedRevision, nextState, nowEpochMs, nowIso } =
		params;

	const expectedRevisionBigInt = BigInt(expectedRevision);

	const jsonStr = JSON.stringify(nextState);
	const digest = computeDigest(jsonStr);

	try {
		beginImmediate(db);
	} catch (error) {
		return { kind: "DB_FAILURE", cause: error };
	}

	try {
		const row = db.prepare(COMMIT_STATE_SQL).get({
			":schema_version": nextState.schemaVersion,
			":state_json": jsonStr,
			":state_digest": digest,
			":owner_token": handle.ownerToken,
			":fence_token": handle.fenceToken,
			":now_epoch": nowEpochMs,
			":now_iso": nowIso,
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
			// Diagnose why the CAS failed.
			const ownershipRow = db
				.prepare(
					`SELECT ownership_status, owner_token, fence_token,
					        lease_until_epoch_ms
					 FROM run_ownership WHERE singleton = 1`,
				)
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

			if (bigintFromRow(ownershipRow.fence_token) !== handle.fenceToken) {
				return { kind: "STALE_HANDLE" };
			}

			if (nowEpochMs > ownershipRow.lease_until_epoch_ms) {
				return { kind: "EXPIRED_HANDLE" };
			}

			// Ownership matches but revision doesn't.
			const stateRow = db
				.prepare("SELECT state_revision FROM run_state WHERE singleton = 1")
				.get() as { state_revision: number | bigint } | undefined;

			if (
				stateRow !== undefined &&
				bigintFromRow(stateRow.state_revision) !== expectedRevisionBigInt
			) {
				return { kind: "REVISION_CONFLICT" };
			}

			return {
				kind: "DB_FAILURE",
				cause: new DbIntegrityError("state commit failed for unknown reason"),
			};
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
					stateRevision: String(bigintFromRow(row.state_revision)),
					committedFenceToken: String(
						bigintFromRow(row.committed_by_fence_token),
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

export interface ReadStateResult<S extends object> {
	readonly state: StateRecord<S> | null;
	readonly digest: string | null;
}

export function readAuthoritativeState<S extends object>(
	db: SqliteConnection,
): ReadStateResult<S> {
	const row = db.prepare(READ_STATE_SQL).get() as
		| {
				state_schema_version: number;
				state_json: string;
				state_digest: string;
				state_revision: number | bigint;
				committed_by_fence_token: number | bigint;
				run_id: string;
				orchestrator_name: string;
				incarnation_id: string;
				started_at: string;
				started_at_epoch_ms: number;
		  }
		| undefined;

	if (row === undefined) return { state: null, digest: null };

	const parsed = JSON.parse(row.state_json) as Record<string, unknown>;
	const state: StateRecord<S> = {
		schemaVersion: row.state_schema_version,
		runId: row.run_id,
		orchestratorName: row.orchestrator_name,
		startedAt: row.started_at,
		startedAtEpochMs: row.started_at_epoch_ms,
		lastTransitionAt: (parsed.lastTransitionAt as string) ?? "",
		lastTransitionAtEpochMs: (parsed.lastTransitionAtEpochMs as number) ?? 0,
		currentPhase: (parsed.currentPhase as string) ?? "",
		phasesExecuted: (parsed.phasesExecuted as number) ?? 0,
		accumulatedDurationMs: (parsed.accumulatedDurationMs as number) ?? 0,
		data: (parsed.data as S) ?? ({} as S),
		pendingDelegation: parsed.pendingDelegation,
		pendingExternalRequest: parsed.pendingExternalRequest,
		usedLabels: (parsed.usedLabels as readonly string[]) ?? [],
		runIncarnationId: row.incarnation_id,
		stateRevision: String(bigintFromRow(row.state_revision)),
		committedFenceToken: String(bigintFromRow(row.committed_by_fence_token)),
	};

	return { state, digest: row.state_digest };
}

// ---------------------------------------------------------------------------
// state.json projection
// ---------------------------------------------------------------------------

export function projectStateJson(
	runDir: string,
	state: StateRecord<object>,
	digest: string,
): void {
	const projection: Record<string, unknown> = {
		schemaVersion: state.schemaVersion,
		runId: state.runId,
		orchestratorName: state.orchestratorName,
		startedAt: state.startedAt,
		startedAtEpochMs: state.startedAtEpochMs,
		lastTransitionAt: state.lastTransitionAt,
		lastTransitionAtEpochMs: state.lastTransitionAtEpochMs,
		currentPhase: state.currentPhase,
		phasesExecuted: state.phasesExecuted,
		accumulatedDurationMs: state.accumulatedDurationMs,
		data: state.data,
		usedLabels: state.usedLabels,
		// Authority metadata embedded in projection for integrity checks.
		runIncarnationId: state.runIncarnationId,
		stateRevision: String(state.stateRevision),
		committedFenceToken: String(state.committedFenceToken),
		stateDigest: digest,
	};
	if (state.pendingDelegation !== undefined) {
		projection.pendingDelegation = state.pendingDelegation;
	}
	if (state.pendingExternalRequest !== undefined) {
		projection.pendingExternalRequest = state.pendingExternalRequest;
	}
	if (state.terminalResult !== undefined) {
		projection.terminalResult = state.terminalResult;
	}

	const json = JSON.stringify(projection);
	const tmpPath = path.join(runDir, "state.json.tmp");
	const statePath = path.join(runDir, "state.json");

	fs.writeFileSync(tmpPath, json, { encoding: "utf-8" });
	fs.renameSync(tmpPath, statePath);
}
