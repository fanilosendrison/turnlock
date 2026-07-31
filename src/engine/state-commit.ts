// Engine-level state commit helpers — strict wrappers around the SQLite
// persistence layer.  Handlers use these instead of importing from
// persistence/ or services/state-io directly.
//
// Contract (TL-F-001 point 1):
//   Every wrapper follows the "orThrow" pattern — success returns normally,
//   any other result throws a typed error immediately.  It is impossible for
//   a handler to ignore a STALE_HANDLE, EXPIRED_HANDLE, REVISION_CONFLICT,
//   or DB_FAILURE.

import * as fs from "node:fs";
import * as path from "node:path";
import {
	ArtifactIntegrityError,
	AuthorityLostError,
	PersistenceFailureError,
	StateRevisionConflictError,
} from "../errors/concrete";
import {
	beginImmediate,
	commit,
	type LockHandle,
	refreshOwnership,
	releaseOwnership,
	rollback,
} from "../persistence/sqlite/ownership";
import type { RunDatabase } from "../persistence/sqlite/run-database";
import {
	type CommittedState,
	projectAuthoritativeStateFenced,
	type StateRecord,
	commitState as sqliteCommitState,
} from "../persistence/sqlite/run-state-store";
import { readAndVerifyArtifact } from "../services/artifact-store";
import { clock as defaultClock } from "../services/clock";
import type { StateFile } from "../services/state-io";
import type { ArtifactRef } from "../types/artifacts";

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
 *  then project state.json under fence.  Updates ctx.stateRevision on success.
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
		leaseClockEpochMs: () => defaultClock.nowEpochMs(),
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

// ---------------------------------------------------------------------------
// projectCanonicalArtifactFenced — fenced canonical projection
// ---------------------------------------------------------------------------

/** Describes where in the authoritative state the ArtifactRef is expected. */
export interface ExpectedArtifactPlacement {
	/** JSON pointer path, e.g. "/terminalResult/outputArtifact" or
	 *  "/pendingDelegation/manifestArtifact". */
	readonly pointer: string;
	readonly artifact: ArtifactRef;
}

/** Project an immutable artifact as a canonical file, but only if the caller
 *  still holds authority AND the current authoritative state still references
 *  this exact artifact at the expected position.
 *
 *  Protocol (all inside BEGIN IMMEDIATE):
 *    1. Verify ownership row: status=HELD, matching incarnation/owner/fence,
 *       AND lease_until_epoch_ms > now.
 *    2. Read the current state_json from run_state.
 *    3. Verify the field at expectedPlacement.pointer matches
 *       expectedPlacement.artifact exactly (all fields).
 *    4. Read and verify the immutable blob.
 *    5. Write the canonical projection atomically (tmp + rename).
 *    6. COMMIT.
 *
 *  Guarantees:
 *    - A stale owner whose lease expired is rejected (EXPIRED_HANDLE).
 *    - A successor with a higher fence token is rejected (STALE_HANDLE).
 *    - An artifact superseded by a later revision of the same owner is
 *      rejected (CANONICAL_PROJECTION_SUPERSEDED).
 *    - If the blob itself was tampered with, ArtifactIntegrityError is thrown
 *      before any file is written. */
export function projectCanonicalArtifactFenced(
	ctx: {
		readonly runDb: RunDatabase;
		readonly handle: LockHandle;
		readonly runDir: string;
		readonly runId: string;
		readonly config?: { readonly name?: string };
		readonly currentPhase?: string | null;
	},
	expectedPlacement: ExpectedArtifactPlacement,
	canonicalPath: string,
): void {
	const db = ctx.runDb.connection;
	const nowEpochMs = defaultClock.nowEpochMs();

	try {
		beginImmediate(db);
	} catch (error) {
		throw new PersistenceFailureError(
			"canonical projection: BEGIN IMMEDIATE failed",
			{
				operation: "state_commit",
				cause: error,
				...errorOpts(ctx),
			},
		);
	}

	try {
		// Step 1 — Verify ownership including lease expiration.
		const ownershipRow = db
			.prepare(
				`SELECT ownership_status, incarnation_id, owner_token,
				        fence_token, lease_until_epoch_ms
				 FROM run_ownership WHERE singleton = 1`,
			)
			.get() as
			| {
					ownership_status: string;
					incarnation_id: string;
					owner_token: string;
					fence_token: number | bigint;
					lease_until_epoch_ms: number | null;
			  }
			| undefined;

		if (ownershipRow === undefined) {
			rollback(db);
			throw new AuthorityLostError(
				"Canonical projection rejected: ownership row missing",
				{
					operation: "state_commit",
					reason: "STALE_HANDLE",
					...errorOpts(ctx),
				},
			);
		}

		if (ownershipRow.ownership_status !== "HELD") {
			rollback(db);
			throw new AuthorityLostError(
				"Canonical projection rejected: ownership not held",
				{
					operation: "state_commit",
					reason: "STALE_HANDLE",
					...errorOpts(ctx),
				},
			);
		}

		if (ownershipRow.incarnation_id !== ctx.handle.incarnationId) {
			rollback(db);
			throw new AuthorityLostError(
				"Canonical projection rejected: incarnation mismatch",
				{
					operation: "state_commit",
					reason: "STALE_HANDLE",
					...errorOpts(ctx),
				},
			);
		}

		if (ownershipRow.owner_token !== ctx.handle.ownerToken) {
			rollback(db);
			throw new AuthorityLostError(
				"Canonical projection rejected: owner token mismatch",
				{
					operation: "state_commit",
					reason: "STALE_HANDLE",
					...errorOpts(ctx),
				},
			);
		}

		const rowFence =
			typeof ownershipRow.fence_token === "bigint"
				? ownershipRow.fence_token
				: BigInt(ownershipRow.fence_token);
		if (rowFence !== ctx.handle.fenceToken) {
			rollback(db);
			throw new AuthorityLostError(
				"Canonical projection rejected: fence token mismatch",
				{
					operation: "state_commit",
					reason: "STALE_HANDLE",
					...errorOpts(ctx),
				},
			);
		}

		// Lease check — lease is expired at the exact instant now >= leaseUntil.
		if (
			ownershipRow.lease_until_epoch_ms === null ||
			nowEpochMs >= ownershipRow.lease_until_epoch_ms
		) {
			rollback(db);
			throw new AuthorityLostError(
				"Canonical projection rejected: lease expired",
				{
					operation: "state_commit",
					reason: "EXPIRED_HANDLE",
					...errorOpts(ctx),
				},
			);
		}

		// Step 2 — Read the current authoritative state.
		const stateRow = db
			.prepare(
				`SELECT state_json, state_revision
				 FROM run_state WHERE singleton = 1`,
			)
			.get() as
			| { state_json: string; state_revision: number | bigint }
			| undefined;

		if (stateRow === undefined) {
			rollback(db);
			throw new PersistenceFailureError(
				"canonical projection: state row missing",
				{
					operation: "state_commit",
					...errorOpts(ctx),
				},
			);
		}

		// Step 3 — Verify the current state still references this exact artifact.
		let parsedState: Record<string, unknown>;
		try {
			parsedState = JSON.parse(stateRow.state_json) as Record<string, unknown>;
		} catch (err) {
			rollback(db);
			throw new PersistenceFailureError(
				"canonical projection: state_json is not valid JSON",
				{
					operation: "state_commit",
					cause: err,
					...errorOpts(ctx),
				},
			);
		}

		// Navigate the JSON pointer to find the expected artifact.
		const segments = expectedPlacement.pointer
			.split("/")
			.filter((s) => s.length > 0);
		let current: unknown = parsedState;
		for (const seg of segments) {
			if (
				typeof current !== "object" ||
				current === null ||
				Array.isArray(current)
			) {
				rollback(db);
				throw new PersistenceFailureError(
					`canonical projection: cannot navigate pointer ${expectedPlacement.pointer} at segment ${seg}`,
					{
						operation: "state_commit",
						...errorOpts(ctx),
					},
				);
			}
			current = (current as Record<string, unknown>)[seg];
		}

		// Compare the artifact reference fields exactly.
		if (!isArtifactRefEqual(current, expectedPlacement.artifact)) {
			rollback(db);
			throw new AuthorityLostError(
				"Canonical projection rejected: state no longer references this artifact",
				{
					operation: "state_commit",
					reason: "STALE_HANDLE",
					...errorOpts(ctx),
				},
			);
		}

		// Step 4 — Read and verify the immutable blob.
		const bytes = readAndVerifyArtifact(ctx.runDir, expectedPlacement.artifact);

		// Step 5 — Write canonical projection atomically.
		const parentDir = path.dirname(canonicalPath);
		fs.mkdirSync(parentDir, { recursive: true });
		const tmpPath = `${canonicalPath}.tmp-${process.pid}`;
		fs.writeFileSync(tmpPath, bytes);
		fs.renameSync(tmpPath, canonicalPath);

		// Step 6 — COMMIT.
		commit(db);
	} catch (error) {
		rollback(db);
		if (
			error instanceof AuthorityLostError ||
			error instanceof ArtifactIntegrityError ||
			error instanceof PersistenceFailureError
		) {
			throw error;
		}
		throw new PersistenceFailureError(
			`canonical projection failed: ${error instanceof Error ? error.message : String(error)}`,
			{
				operation: "state_commit",
				cause: error,
				...errorOpts(ctx),
			},
		);
	}
}

/** Deep-equal two ArtifactRef values by comparing each field exactly. */
function isArtifactRefEqual(a: unknown, b: ArtifactRef): boolean {
	if (typeof a !== "object" || a === null) return false;
	const ref = a as Record<string, unknown>;
	return (
		ref.kind === b.kind &&
		ref.digestAlgorithm === b.digestAlgorithm &&
		ref.digest === b.digest &&
		ref.relativePath === b.relativePath &&
		ref.mediaType === b.mediaType &&
		ref.sizeBytes === b.sizeBytes
	);
}
