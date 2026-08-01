// Atomic run bootstrap — incarnation + ownership + state in a single transaction.
//
// Replaces the old multi-transaction sequence:
//   acquireOwnership() → initializeStateUnderFence()
//
// Guarantees: after any bootstrap or migration attempt, the SQLite database
// is in one of two states:
//   - NOT ESTABLISHED: no incarnation, no ownership, no state (schema-only OK)
//   - FULLY ESTABLISHED: incarnation + ownership HELD + state, all consistent,
//     with the LockHandle only published after COMMIT succeeds.

import { createHash } from "node:crypto";
import { generateRunId } from "../../services/run-id";
import { DbIntegrityError } from "./errors";
import {
	acquireOwnershipDirectInTransaction,
	beginImmediate,
	commit,
	ensureIncarnationInTransaction,
	ensureOwnershipRowInTransaction,
	type LockHandle,
	rollback,
} from "./ownership";
import type { SqliteConnection } from "./sqlite-driver";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CommittedState {
	readonly state: Record<string, unknown>;
	readonly stateDigest: string;
	readonly stateRevision: string;
	readonly committedFenceToken: string;
	readonly incarnationId: string;
}

export interface BootstrapNewRunParams {
	readonly db: SqliteConnection;
	readonly runId: string;
	readonly orchestratorName: string;
	readonly nowEpochMs: number;
	readonly nowIso: string;
	readonly leaseDurationMs: number;
	/** Clock callback captured AFTER BEGIN IMMEDIATE for lease calculation. */
	readonly leaseClockEpochMs?: () => number;
	readonly initialState: Record<string, unknown>;
	readonly stateSchemaVersion: number;
	readonly contentionDeadlineMs: number;
}

export type BootstrapNewRunResult =
	| {
			readonly kind: "BOOTSTRAPPED";
			readonly handle: LockHandle;
			readonly committed: CommittedState;
	  }
	| { readonly kind: "ALREADY_ESTABLISHED" }
	| {
			readonly kind: "ACTIVE_CONFLICT";
			readonly leaseUntilEpochMs: number;
	  }
	| {
			readonly kind: "INCOMPLETE_EXISTING_BOOTSTRAP";
			readonly details: string;
	  }
	| { readonly kind: "DB_CONTENTION_TIMEOUT" }
	| { readonly kind: "DB_FAILURE"; readonly cause: unknown };

export interface MigrateLegacyRunParams {
	readonly db: SqliteConnection;
	readonly runId: string;
	readonly incarnationId: string;
	readonly orchestratorName: string;
	readonly nowEpochMs: number;
	readonly nowIso: string;
	readonly leaseDurationMs: number;
	/** Clock callback captured AFTER BEGIN IMMEDIATE for lease calculation. */
	readonly leaseClockEpochMs?: () => number;
	readonly legacyState: Record<string, unknown>;
	readonly legacyStartedAtEpochMs: number;
	readonly legacyStartedAt: string;
	readonly legacyLastTransitionAtEpochMs: number;
	readonly legacyLastTransitionAt: string;
	readonly stateSchemaVersion: number;
	readonly contentionDeadlineMs: number;
}

export type MigrateLegacyRunResult =
	| {
			readonly kind: "MIGRATED";
			readonly handle: LockHandle;
			readonly committed: CommittedState;
	  }
	| { readonly kind: "ALREADY_ESTABLISHED" }
	| { readonly kind: "ACTIVE_CONFLICT" }
	| {
			readonly kind: "INCOMPLETE_EXISTING_BOOTSTRAP";
			readonly details: string;
	  }
	| { readonly kind: "DB_CONTENTION_TIMEOUT" }
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

function isBusy(error: unknown): boolean {
	const msg = String(error);
	return msg.includes("SQLITE_BUSY") || msg.includes("database is locked");
}

// ---------------------------------------------------------------------------
// Diagnostic helpers — reads current DB state to classify what we found
// ---------------------------------------------------------------------------

interface DbSnapshot {
	readonly hasIncarnation: boolean;
	readonly hasOwnership: boolean;
	readonly hasState: boolean;
	readonly ownershipStatus: string | null;
	readonly fenceToken: bigint | null;
	readonly leaseUntilEpochMs: number | null;
}

function readDbSnapshot(db: SqliteConnection): DbSnapshot {
	const incRow = db
		.prepare("SELECT 1 FROM run_incarnation WHERE singleton = 1")
		.get();
	const ownRow = db
		.prepare(
			"SELECT ownership_status, fence_token, lease_until_epoch_ms FROM run_ownership WHERE singleton = 1",
		)
		.get() as
		| {
				ownership_status: string;
				fence_token: number | bigint;
				lease_until_epoch_ms: number | null;
		  }
		| undefined;
	const stateRow = db
		.prepare("SELECT 1 FROM run_state WHERE singleton = 1")
		.get();

	return {
		hasIncarnation: incRow !== undefined,
		hasOwnership: ownRow !== undefined,
		hasState: stateRow !== undefined,
		ownershipStatus: ownRow?.ownership_status ?? null,
		fenceToken: ownRow ? bigintFromRow(ownRow.fence_token) : null,
		leaseUntilEpochMs: ownRow?.lease_until_epoch_ms ?? null,
	};
}

// ---------------------------------------------------------------------------
// Internal: establishRunInTransaction
// ---------------------------------------------------------------------------
// All three tables are populated inside a single BEGIN IMMEDIATE ... COMMIT.
// This function assumes the caller has already opened the transaction.
// It does NOT begin, commit, or rollback — the caller manages the boundary.
//
// Returns the data needed to build a LockHandle and CommittedState,
// or null if the run is already fully established.
// Throws on integrity errors.

interface EstablishResult {
	readonly incarnationId: string;
	readonly ownerToken: string;
	readonly fenceToken: bigint;
	readonly leaseUntilEpochMs: number;
	readonly stateDigest: string;
	readonly stateRevision: string;
	readonly committedFenceToken: string;
	/** The normalized state object that was actually inserted into run_state. */
	readonly normalizedState: Record<string, unknown>;
}

function establishRunInTransaction(
	db: SqliteConnection,
	params: {
		runId: string;
		orchestratorName: string;
		nowEpochMs: number;
		nowIso: string;
		leaseDurationMs: number;
		ownerToken: string;
		ownerPid: number;
		initialStateJson: string;
		stateSchemaVersion: number;
		// For legacy migration: pre-created incarnation data
		legacyIncarnationId?: string;
		legacyStartedAtEpochMs?: number;
		legacyStartedAt?: string;
	},
): EstablishResult | null {
	const {
		runId,
		orchestratorName,
		nowEpochMs,
		nowIso,
		leaseDurationMs,
		ownerToken,
		ownerPid,
		initialStateJson: rawInitialStateJson,
		stateSchemaVersion,
	} = params;

	// Normalize timestamps: for a new run, use the post-lock clock;
	// for legacy migration, preserve the legacy timestamps.
	const effectiveNowEpochMs = params.legacyStartedAtEpochMs ?? nowEpochMs;
	const effectiveNowIso = params.legacyStartedAt ?? nowIso;
	const initialStateObj = JSON.parse(rawInitialStateJson) as Record<
		string,
		unknown
	>;
	initialStateObj.startedAt = effectiveNowIso;
	initialStateObj.startedAtEpochMs = effectiveNowEpochMs;
	initialStateObj.lastTransitionAt = effectiveNowIso;
	initialStateObj.lastTransitionAtEpochMs = effectiveNowEpochMs;
	const initialStateJson = JSON.stringify(initialStateObj);

	// 1. Check current state.
	const snapshot = readDbSnapshot(db);

	// Already fully established?
	if (snapshot.hasIncarnation && snapshot.hasOwnership && snapshot.hasState) {
		// If ownership is actively held by another process, report conflict.
		if (
			snapshot.ownershipStatus === "HELD" &&
			snapshot.leaseUntilEpochMs !== null &&
			nowEpochMs < snapshot.leaseUntilEpochMs
		) {
			throw new DbIntegrityError(
				"ACTIVE_CONFLICT: ownership held by another process",
			);
		}
		// Ownership is FREE or expired — the run is established but
		// unowned.  This is a valid state for --resume, not for --initial.
		return null; // ALREADY_ESTABLISHED
	}

	// Partial state detection.
	if (snapshot.hasOwnership && !snapshot.hasState) {
		// Ownership row exists but no state — incomplete bootstrap.
		// Check if ownership is actively held.
		if (
			snapshot.ownershipStatus === "HELD" &&
			snapshot.leaseUntilEpochMs !== null &&
			nowEpochMs < snapshot.leaseUntilEpochMs
		) {
			// Active owner — cannot recover without the lost state.
			throw new DbIntegrityError(
				"INCOMPLETE_BOOTSTRAP: ownership held but no state row — no recovery source",
			);
		}
		// Ownership is FREE or expired — we can recover by establishing
		// state in this same transaction.
	}

	if (snapshot.hasState && !snapshot.hasOwnership) {
		throw new DbIntegrityError(
			"INCOMPLETE_BOOTSTRAP: state exists but no ownership row",
		);
	}

	// 2. Ensure incarnation.
	const incarnationId = ensureIncarnationInTransaction(
		db,
		runId,
		orchestratorName,
		params.legacyStartedAtEpochMs ?? nowEpochMs,
		params.legacyStartedAt ?? nowIso,
	);

	// 3. Ensure ownership row.
	ensureOwnershipRowInTransaction(db, incarnationId);

	// 4. Acquire ownership directly.
	const acquireResult = acquireOwnershipDirectInTransaction(
		db,
		incarnationId,
		ownerToken,
		ownerPid,
		nowEpochMs,
		leaseDurationMs,
	);

	if (acquireResult === null) {
		throw new DbIntegrityError(
			"ACTIVE_CONFLICT: ownership held by another process",
		);
	}

	// 5. Insert initial state.
	const digest = computeDigest(initialStateJson);

	const insertResult = db
		.prepare(
			`INSERT INTO run_state (
			    singleton,
			    incarnation_id,
			    state_revision,
			    state_schema_version,
			    state_json,
			    state_digest,
			    committed_by_owner_token,
			    committed_by_fence_token,
			    committed_at_epoch_ms,
			    committed_at_iso
			)
			SELECT
			    1,
			    :incarnation_id,
			    0,
			    :schema_version,
			    :state_json,
			    :state_digest,
			    :owner_token,
			    :fence_token,
			    :now_epoch,
			    :now_iso
			WHERE NOT EXISTS (
			    SELECT 1 FROM run_state WHERE singleton = 1
			)
			RETURNING state_revision, state_digest, committed_by_fence_token`,
		)
		.get({
			":incarnation_id": incarnationId,
			":schema_version": stateSchemaVersion,
			":state_json": initialStateJson,
			":state_digest": digest,
			":owner_token": ownerToken,
			":fence_token": acquireResult.fenceToken,
			":now_epoch": nowEpochMs,
			":now_iso": nowIso,
		}) as
		| {
				state_revision: number | bigint;
				state_digest: string;
				committed_by_fence_token: number | bigint;
		  }
		| undefined;

	if (insertResult === undefined) {
		// State row already exists — this means another caller raced us
		// (should be impossible under BEGIN IMMEDIATE, but defensive).
		// Re-read to check.
		const existingState = db
			.prepare(
				"SELECT state_revision, state_digest, committed_by_fence_token FROM run_state WHERE singleton = 1",
			)
			.get() as
			| {
					state_revision: number | bigint;
					state_digest: string;
					committed_by_fence_token: number | bigint;
			  }
			| undefined;

		if (existingState !== undefined) {
			// State exists — the run was established by someone else.
			return null; // ALREADY_ESTABLISHED
		}

		throw new DbIntegrityError(
			"Failed to insert initial state row — unknown reason",
		);
	}

	// 6. Verify coherence.
	const finalSnapshot = readDbSnapshot(db);
	if (
		!finalSnapshot.hasIncarnation ||
		!finalSnapshot.hasOwnership ||
		!finalSnapshot.hasState
	) {
		throw new DbIntegrityError(
			"Post-insert coherence check failed — partial state detected",
		);
	}

	return {
		incarnationId,
		ownerToken,
		fenceToken: acquireResult.fenceToken,
		leaseUntilEpochMs: acquireResult.leaseUntilEpochMs,
		stateDigest: insertResult.state_digest,
		stateRevision: String(bigintFromRow(insertResult.state_revision)),
		committedFenceToken: String(
			bigintFromRow(insertResult.committed_by_fence_token),
		),
		normalizedState: initialStateObj,
	};
}

// ---------------------------------------------------------------------------
// Public API: bootstrapNewRunAtomic
// ---------------------------------------------------------------------------

/** Bootstrap a brand-new run atomically.
 *
 *  All three tables (incarnation, ownership, state) are populated inside a
 *  single BEGIN IMMEDIATE ... COMMIT.  The LockHandle is only constructed
 *  and returned after the COMMIT succeeds.
 *
 *  If any statement fails before COMMIT, the transaction is rolled back.
 *  No partial state is observable, no LockHandle is published. */
export function bootstrapNewRunAtomic(
	params: BootstrapNewRunParams,
): BootstrapNewRunResult {
	const {
		db,
		runId,
		orchestratorName,
		nowEpochMs: _nowEpochMs,
		nowIso: _nowIso,
		leaseDurationMs,
		initialState,
		stateSchemaVersion,
		contentionDeadlineMs,
	} = params;

	const ownerToken = generateRunId();
	const ownerPid = process.pid;
	const initialStateJson = JSON.stringify(initialState);
	// Timestamps in initialRecord (startedAt, lastTransitionAt, etc.) are
	// pre-lock values.  establishRunInTransaction will normalize them to
	// the post-lock clock for new runs, or preserve legacy timestamps.

	const deadlineMs = performance.now() + contentionDeadlineMs;
	const maxAttempts = 10;

	for (let attempt = 0; attempt < maxAttempts; attempt++) {
		if (performance.now() > deadlineMs) break;

		try {
			beginImmediate(db);
		} catch (error) {
			if (isBusy(error)) continue;
			rollback(db);
			return { kind: "DB_FAILURE", cause: error };
		}

		// Capture clock AFTER lock acquisition.
		const lockEpochMs = (params.leaseClockEpochMs ?? Date.now)();
		const lockIso = new Date(lockEpochMs).toISOString();

		let establishResult: EstablishResult | null;
		try {
			establishResult = establishRunInTransaction(db, {
				runId,
				orchestratorName,
				nowEpochMs: lockEpochMs,
				nowIso: lockIso,
				leaseDurationMs,
				ownerToken,
				ownerPid,
				initialStateJson,
				stateSchemaVersion,
			});
		} catch (error) {
			rollback(db);
			if (error instanceof DbIntegrityError) {
				const msg = error.message;
				if (msg.startsWith("ACTIVE_CONFLICT")) {
					// Re-read lease for reporting.
					const ownRow = db
						.prepare(
							"SELECT lease_until_epoch_ms FROM run_ownership WHERE singleton = 1",
						)
						.get() as { lease_until_epoch_ms: number } | undefined;
					return {
						kind: "ACTIVE_CONFLICT",
						leaseUntilEpochMs:
							ownRow?.lease_until_epoch_ms ?? lockEpochMs + leaseDurationMs,
					};
				}
				if (msg.startsWith("INCOMPLETE_BOOTSTRAP")) {
					return {
						kind: "INCOMPLETE_EXISTING_BOOTSTRAP",
						details: msg,
					};
				}
			}
			return { kind: "DB_FAILURE", cause: error };
		}

		if (establishResult === null) {
			rollback(db);
			return { kind: "ALREADY_ESTABLISHED" };
		}

		// COMMIT.
		try {
			commit(db);
		} catch (error) {
			rollback(db);
			if (isBusy(error)) continue;
			return { kind: "DB_FAILURE", cause: error };
		}

		// Only after COMMIT: build LockHandle and CommittedState.
		const handle: LockHandle = {
			ownerToken: establishResult.ownerToken,
			incarnationId: establishResult.incarnationId,
			fenceToken: establishResult.fenceToken,
			leaseUntilEpochMs: establishResult.leaseUntilEpochMs,
		};

		const committed: CommittedState = {
			state: {
				...establishResult.normalizedState,
				runIncarnationId: establishResult.incarnationId,
				stateRevision: establishResult.stateRevision,
				committedFenceToken: establishResult.committedFenceToken,
			},
			stateDigest: establishResult.stateDigest,
			stateRevision: establishResult.stateRevision,
			committedFenceToken: establishResult.committedFenceToken,
			incarnationId: establishResult.incarnationId,
		};

		return { kind: "BOOTSTRAPPED", handle, committed };
	}

	return { kind: "DB_CONTENTION_TIMEOUT" };
}

// ---------------------------------------------------------------------------
// Public API: migrateLegacyRunAtomic
// ---------------------------------------------------------------------------

/** Migrate a legacy run (state.json, no SQLite DB) into an authoritative
 *  SQLite run atomically.
 *
 *  Preserves the legacy startedAt/lastTransitionAt timestamps.
 *  Ownership is established with current wall-clock time.
 *  All three tables populated in a single BEGIN IMMEDIATE ... COMMIT. */
export function migrateLegacyRunAtomic(
	params: MigrateLegacyRunParams,
): MigrateLegacyRunResult {
	const {
		db,
		runId,
		incarnationId,
		orchestratorName,
		nowEpochMs: _nowEpochMs,
		nowIso: _nowIso,
		leaseDurationMs,
		legacyState,
		legacyStartedAtEpochMs,
		legacyStartedAt,
		legacyLastTransitionAtEpochMs,
		legacyLastTransitionAt,
		stateSchemaVersion,
		contentionDeadlineMs,
	} = params;

	const ownerToken = generateRunId();
	const ownerPid = process.pid;

	// Build the initial state JSON with legacy timestamps.
	const initialStateForDb: Record<string, unknown> = {
		...legacyState,
		lastTransitionAt: legacyLastTransitionAt,
		lastTransitionAtEpochMs: legacyLastTransitionAtEpochMs,
	};
	const initialStateJson = JSON.stringify(initialStateForDb);

	const deadlineMs = performance.now() + contentionDeadlineMs;
	const maxAttempts = 10;

	for (let attempt = 0; attempt < maxAttempts; attempt++) {
		if (performance.now() > deadlineMs) break;

		try {
			beginImmediate(db);
		} catch (error) {
			if (isBusy(error)) continue;
			rollback(db);
			return { kind: "DB_FAILURE", cause: error };
		}

		// Capture clock AFTER lock acquisition.
		const lockEpochMs = (params.leaseClockEpochMs ?? Date.now)();
		const lockIso = new Date(lockEpochMs).toISOString();

		let establishResult: EstablishResult | null;
		try {
			establishResult = establishRunInTransaction(db, {
				runId,
				orchestratorName,
				nowEpochMs: lockEpochMs,
				nowIso: lockIso,
				leaseDurationMs,
				ownerToken,
				ownerPid,
				initialStateJson,
				stateSchemaVersion,
				legacyIncarnationId: incarnationId,
				legacyStartedAtEpochMs,
				legacyStartedAt,
			});
		} catch (error) {
			rollback(db);
			if (error instanceof DbIntegrityError) {
				const msg = error.message;
				if (msg.startsWith("ACTIVE_CONFLICT")) {
					return { kind: "ACTIVE_CONFLICT" };
				}
				if (msg.startsWith("INCOMPLETE_BOOTSTRAP")) {
					return {
						kind: "INCOMPLETE_EXISTING_BOOTSTRAP",
						details: msg,
					};
				}
			}
			return { kind: "DB_FAILURE", cause: error };
		}

		if (establishResult === null) {
			rollback(db);
			return { kind: "ALREADY_ESTABLISHED" };
		}

		// COMMIT.
		try {
			commit(db);
		} catch (error) {
			rollback(db);
			if (isBusy(error)) continue;
			return { kind: "DB_FAILURE", cause: error };
		}

		// Only after COMMIT: build LockHandle and CommittedState.
		const handle: LockHandle = {
			ownerToken: establishResult.ownerToken,
			incarnationId: establishResult.incarnationId,
			fenceToken: establishResult.fenceToken,
			leaseUntilEpochMs: establishResult.leaseUntilEpochMs,
		};

		const committed: CommittedState = {
			state: {
				...establishResult.normalizedState,
				runIncarnationId: establishResult.incarnationId,
				stateRevision: establishResult.stateRevision,
				committedFenceToken: establishResult.committedFenceToken,
			},
			stateDigest: establishResult.stateDigest,
			stateRevision: establishResult.stateRevision,
			committedFenceToken: establishResult.committedFenceToken,
			incarnationId: establishResult.incarnationId,
		};

		return { kind: "MIGRATED", handle, committed };
	}

	return { kind: "DB_CONTENTION_TIMEOUT" };
}

// ---------------------------------------------------------------------------
// Re-export for convenience
// ---------------------------------------------------------------------------

export type { LockHandle } from "./ownership";
