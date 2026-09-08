import type { TerminalDoneRecord } from "../../types/artifacts.js";
import { DbIntegrityError } from "./errors.js";
import {
	bigintFromStateRow,
	computeStateDigest,
	isPendingInitialDispatchV1,
} from "./run-state-codec.js";
import type { ReadStateResult, StateRecord } from "./run-state-contracts.js";
import { READ_STATE_SQL } from "./run-state-sql.js";
import type { SqliteConnection } from "./sqlite-driver.js";

/** Read and verify the authoritative state stored in SQLite. */
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
	if (row === undefined) {
		return { state: null, digest: null, pendingInitialDispatch: false };
	}
	const actualDigest = computeStateDigest(row.state_json);
	if (actualDigest !== row.state_digest) {
		throw new DbIntegrityError(
			`run_state digest mismatch: stored=${row.state_digest}, actual=${actualDigest}`,
		);
	}
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
		stateRevision: String(bigintFromStateRow(row.state_revision)),
		committedFenceToken: String(
			bigintFromStateRow(row.committed_by_fence_token),
		),
		...(parsed.terminalResult !== undefined
			? { terminalResult: parsed.terminalResult as TerminalDoneRecord }
			: {}),
	};
	return {
		state,
		digest: row.state_digest,
		pendingInitialDispatch: isPendingInitialDispatchV1(parsed),
	};
}
