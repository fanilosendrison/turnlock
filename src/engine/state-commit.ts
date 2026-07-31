// Engine-level state commit helpers — strict wrappers around the SQLite
// persistence layer.  Handlers use these instead of importing from
// persistence/ or services/state-io directly.
//
// Contract (TL-F-001 point 1):
//   Every wrapper follows the "orThrow" pattern — success returns normally,
//   any other result throws a typed error immediately.  It is impossible for
//   a handler to ignore a STALE_HANDLE, EXPIRED_HANDLE, REVISION_CONFLICT,
//   or DB_FAILURE.

import {
	AuthorityLostError,
	PersistenceFailureError,
	StateRevisionConflictError,
} from "../errors/concrete";
import {
	type LockHandle,
	refreshOwnership,
	releaseOwnership,
} from "../persistence/sqlite/ownership";
import type { RunDatabase } from "../persistence/sqlite/run-database";
import {
	type CommittedState,
	projectStateJson,
	type StateRecord,
	commitState as sqliteCommitState,
} from "../persistence/sqlite/run-state-store";
import { clock as defaultClock } from "../services/clock";
import type { StateFile } from "../services/state-io";

export type { LockHandle } from "../persistence/sqlite/ownership";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function errorOpts(ctx: {
	readonly runId: string;
	readonly config?: { readonly name?: string };
	readonly currentPhase?: string | null;
}): {
	runId: string;
	orchestratorName?: string;
	phase?: string;
} {
	const opts: {
		runId: string;
		orchestratorName?: string;
		phase?: string;
	} = { runId: ctx.runId };
	if (ctx.config?.name !== undefined) opts.orchestratorName = ctx.config.name;
	if (ctx.currentPhase !== null && ctx.currentPhase !== undefined) {
		opts.phase = ctx.currentPhase;
	}
	return opts;
}

// ---------------------------------------------------------------------------
// assertNever — static exhaustiveness guard
// ---------------------------------------------------------------------------

function assertNever(value: never): never {
	throw new Error(
		`Unhandled authoritative persistence result: ${String(value)}`,
	);
}

// ---------------------------------------------------------------------------
// commitStateWithProjection — strict, orThrow
// ---------------------------------------------------------------------------

/** Commit a state transition through the authoritative SQLite store,
 *  then project state.json.  Updates ctx.stateRevision on success.
 *
 *  Throws:
 *    - AuthorityLostError  on STALE_HANDLE / EXPIRED_HANDLE
 *    - StateRevisionConflictError on REVISION_CONFLICT
 *    - PersistenceFailureError on DB_FAILURE
 */
export function commitStateWithProjection<S extends object>(
	ctx: {
		readonly runDb: RunDatabase;
		readonly handle: LockHandle;
		readonly runDir: string;
		readonly config?: { readonly name?: string };
		readonly runId: string;
		readonly currentPhase?: string | null;
		stateRevision: string;
	},
	nextState: StateFile<S>,
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
	};

	const result = sqliteCommitState({
		db: ctx.runDb.connection,
		handle: ctx.handle,
		expectedRevision: ctx.stateRevision,
		nextState: stateRecord,
		nowEpochMs: defaultClock.nowEpochMs(),
		nowIso: defaultClock.nowWallIso(),
	});

	switch (result.kind) {
		case "COMMITTED": {
			ctx.stateRevision = result.committed.state.stateRevision;
			projectStateJson(
				ctx.runDir,
				result.committed.state,
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
					...errorOpts(ctx),
				},
			);

		case "EXPIRED_HANDLE":
			throw new AuthorityLostError(
				"State commit rejected because the ownership lease expired",
				{
					operation: "state_commit",
					reason: "EXPIRED_HANDLE",
					...errorOpts(ctx),
				},
			);

		case "REVISION_CONFLICT":
			throw new StateRevisionConflictError(
				`State revision conflict: expected ${ctx.stateRevision}`,
				errorOpts(ctx),
			);

		case "DB_FAILURE":
			throw new PersistenceFailureError("SQLite state commit failed", {
				operation: "state_commit",
				cause: result.cause,
				...errorOpts(ctx),
			});

		default:
			return assertNever(result);
	}
}

// ---------------------------------------------------------------------------
// refreshOwnershipFromContext — strict, orThrow
// ---------------------------------------------------------------------------

/** Refresh the ownership lease.  Returns the updated LockHandle on success.
 *
 *  Throws:
 *    - AuthorityLostError  on STALE_HANDLE / EXPIRED_HANDLE
 *    - PersistenceFailureError on DB_FAILURE
 */
export function refreshOwnershipFromContext(ctx: {
	readonly runDb: RunDatabase;
	handle: LockHandle;
	readonly runId: string;
	readonly config?: { readonly name?: string };
	readonly currentPhase?: string | null;
}): LockHandle {
	const now = defaultClock.nowEpochMs();
	const result = refreshOwnership({
		db: ctx.runDb.connection,
		handle: ctx.handle,
		nowEpochMs: now,
		leaseDurationMs: 30 * 60 * 1000, // DEFAULT_IDLE_LEASE_MS
	});

	switch (result.kind) {
		case "SUCCESS": {
			ctx.handle = result.handle;
			return result.handle;
		}

		case "STALE_HANDLE":
			throw new AuthorityLostError(
				"Ownership refresh rejected because the handle is stale",
				{
					operation: "refresh",
					reason: "STALE_HANDLE",
					...errorOpts(ctx),
				},
			);

		case "EXPIRED_HANDLE":
			throw new AuthorityLostError(
				"Ownership refresh rejected because the lease expired",
				{
					operation: "refresh",
					reason: "EXPIRED_HANDLE",
					...errorOpts(ctx),
				},
			);

		case "DB_FAILURE":
			throw new PersistenceFailureError("SQLite ownership refresh failed", {
				operation: "refresh",
				cause: result.cause,
				...errorOpts(ctx),
			});

		default:
			return assertNever(result);
	}
}

// ---------------------------------------------------------------------------
// releaseOwnershipFromContext — strict, orThrow
// ---------------------------------------------------------------------------

/** Release ownership through the SQLite store.  Only normal handlers use
 *  this — signal handlers must use releaseOwnershipBestEffort.
 *
 *  Throws:
 *    - AuthorityLostError  on STALE_HANDLE / EXPIRED_HANDLE
 *    - PersistenceFailureError on DB_FAILURE
 */
export function releaseOwnershipFromContext(ctx: {
	readonly runDb: RunDatabase;
	readonly handle: LockHandle;
	readonly runId: string;
	readonly config?: { readonly name?: string };
	readonly currentPhase?: string | null;
}): void {
	const result = releaseOwnership({
		db: ctx.runDb.connection,
		handle: ctx.handle,
	});

	switch (result.kind) {
		case "SUCCESS":
			return;

		case "STALE_HANDLE":
			throw new AuthorityLostError(
				"Ownership release rejected because the handle is stale",
				{
					operation: "release",
					reason: "STALE_HANDLE",
					...errorOpts(ctx),
				},
			);

		case "EXPIRED_HANDLE":
			throw new AuthorityLostError(
				"Ownership release rejected because the lease expired",
				{
					operation: "release",
					reason: "EXPIRED_HANDLE",
					...errorOpts(ctx),
				},
			);

		case "DB_FAILURE":
			throw new PersistenceFailureError("SQLite ownership release failed", {
				operation: "release",
				cause: result.cause,
				...errorOpts(ctx),
			});

		default:
			assertNever(result);
	}
}

// ---------------------------------------------------------------------------
// releaseOwnershipBestEffort — non-throwing, for signal handlers / cleanup
// ---------------------------------------------------------------------------

export interface OwnershipContextWithLogger {
	readonly runDb: RunDatabase;
	readonly handle: LockHandle;
	readonly runId: string;
	readonly logger: {
		emit(event: {
			eventType: string;
			runId: string;
			reason?: string;
			timestamp: string;
		}): void;
	};
}

/** Release ownership on a best-effort basis.  Never throws.
 *  Only for signal handlers and emergency cleanup — normal handlers
 *  must use releaseOwnershipFromContext (strict). */
export function releaseOwnershipBestEffort(
	ctx: OwnershipContextWithLogger,
): void {
	try {
		const result = releaseOwnership({
			db: ctx.runDb.connection,
			handle: ctx.handle,
		});

		if (result.kind !== "SUCCESS") {
			try {
				ctx.logger.emit({
					eventType: "ownership_release_failed",
					runId: ctx.runId,
					reason: result.kind,
					timestamp: defaultClock.nowWallIso(),
				});
			} catch {
				// logger best-effort
			}
		}
	} catch {
		// cleanup best-effort — never propagate from signal handlers
	}
}
