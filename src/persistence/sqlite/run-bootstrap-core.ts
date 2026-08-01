// Core bootstrap algorithm — incarnation + ownership + state in a single
// transaction.
//
// This module contains the unique implementation of the atomic bootstrap and
// legacy migration algorithms.  Both production callers (via run-bootstrap.ts)
// and tests inject their own identity generator through RunBootstrapDependencies.
//
// The production value is `productionDependencies`, which wraps `generateRunId`.
//
// Fault injection is supported through BootstrapInternalDependencies for
// testing atomicity guarantees.  The public API (run-bootstrap.ts) never
// exposes these hooks.

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
// Fault injection types (internal — never exposed on the public API)
// ---------------------------------------------------------------------------

/** Closed set of fault points for bootstrap atomicity testing.
 *
 *  The first five points are pre-commit — an injected failure at any of
 *  them must result in a complete rollback with no observable rows.
 *
 *  AFTER_COMMIT_BEFORE_HANDLE is post-commit and exists for structural
 *  verification; an injected failure here cannot be rolled back. */
export type BootstrapFaultPoint =
	| "AFTER_BEGIN"
	| "AFTER_INCARNATION_WRITE"
	| "AFTER_OWNERSHIP_WRITE"
	| "AFTER_STATE_WRITE"
	| "BEFORE_COMMIT"
	| "AFTER_COMMIT_BEFORE_HANDLE";

/** Sentinel error for fault injection tests.
 *
 *  Tests throw this from `onFaultPoint` when a target frontier is reached.
 *  The error carries the fault point for assertion purposes. */
export class InjectedBootstrapFailure extends Error {
	constructor(readonly point: BootstrapFaultPoint) {
		super(`Injected bootstrap failure at ${point}`);
		this.name = "InjectedBootstrapFailure";
	}
}

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

/** Injectable dependencies for atomic run bootstrap and legacy migration.
 *
 *  The production value is {@link productionDependencies}.  Tests may supply a
 *  deterministic generator to verify identity stability across SQLITE_BUSY
 *  retries. */
export interface RunBootstrapDependencies {
	readonly generateId: () => string;
}

/** Internal dependencies — extends RunBootstrapDependencies with fault
 *  injection hooks reserved for testing.
 *
 *  NEVER exposed on the public API.  Production code always passes
 *  `productionDependencies` (which has no `onFaultPoint`). */
export interface BootstrapInternalDependencies
	extends RunBootstrapDependencies {
	readonly onFaultPoint?: (point: BootstrapFaultPoint) => void;
}

/** Production dependencies — always uses `generateRunId`. */
export const productionDependencies: BootstrapInternalDependencies = {
	generateId: generateRunId,
};

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

/** @internal — exported for use by bootstrap-atomicity.test.ts (tests only). */
export function computeDigest(jsonStr: string): string {
	return `sha256:${createHash("sha256").update(jsonStr).digest("hex")}`;
}

/** @internal — exported for use by bootstrap-atomicity.test.ts (tests only). */
export function isBusy(error: unknown): boolean {
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
//
// @internal — exported for use by bootstrap-atomicity.test.ts (tests only).
// Not part of the public API.

export interface EstablishResult {
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

/** Recovery policy for partial DB states.
 *
 *  - FORBIDDEN: any existing row in incarnation, ownership, or state tables
 *    (even an incomplete set) is rejected as INCOMPLETE_EXISTING_BOOTSTRAP.
 *    Only a completely empty (schema-only) DB is accepted.  Used by
 *    bootstrapNewRunAtomic for new runs.
 *
 *  - FROM_VALIDATED_LEGACY_STATE: recovery is allowed when a validated
 *    state.json exists and can serve as the authoritative state source.
 *    The ownership row may be FREE or expired; the fence token is
 *    incremented.  Used by migrateLegacyRunAtomic. */
export type PartialRecoveryPolicy = "FORBIDDEN" | "FROM_VALIDATED_LEGACY_STATE";

/** @internal — exported for use by bootstrap-atomicity.test.ts (tests only). */
export function establishRunInTransaction(
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
		partialRecovery: PartialRecoveryPolicy;
		// Candidate incarnation ID — generated once by the caller before the
		// retry loop so that SQLITE_BUSY retries preserve the same identity.
		readonly incarnationCandidate: string;
		legacyStartedAtEpochMs?: number;
		legacyStartedAt?: string;
		legacyLastTransitionAtEpochMs?: number;
		legacyLastTransitionAt?: string;
		/** Fault injection hook — internal, never exposed on public API. */
		readonly onFaultPoint?: (point: BootstrapFaultPoint) => void;
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
		partialRecovery,
	} = params;

	// Normalize timestamps: for a new run, use the post-lock clock;
	// for legacy migration, preserve the legacy timestamps independently.
	const effectiveStartedAtEpochMs = params.legacyStartedAtEpochMs ?? nowEpochMs;
	const effectiveStartedAt = params.legacyStartedAt ?? nowIso;
	const effectiveLastTransitionAtEpochMs =
		params.legacyLastTransitionAtEpochMs ?? nowEpochMs;
	const effectiveLastTransitionAt = params.legacyLastTransitionAt ?? nowIso;

	const initialStateObj = JSON.parse(rawInitialStateJson) as Record<
		string,
		unknown
	>;
	initialStateObj.startedAt = effectiveStartedAt;
	initialStateObj.startedAtEpochMs = effectiveStartedAtEpochMs;
	initialStateObj.lastTransitionAt = effectiveLastTransitionAt;
	initialStateObj.lastTransitionAtEpochMs = effectiveLastTransitionAtEpochMs;
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

	// Partial state detection — policy-dependent.
	const hasAnyRow =
		snapshot.hasIncarnation || snapshot.hasOwnership || snapshot.hasState;
	const isComplete =
		snapshot.hasIncarnation && snapshot.hasOwnership && snapshot.hasState;

	if (hasAnyRow && !isComplete) {
		// Incomplete bootstrap: at least one table has rows but not all three.
		if (partialRecovery === "FORBIDDEN") {
			// bootstrapNewRunAtomic: never recover a partial DB with
			// config.initialState.  The original state is lost and
			// the current config may differ from the interrupted attempt.
			throw new DbIntegrityError(
				"INCOMPLETE_BOOTSTRAP: partial DB detected — recovery forbidden without validated legacy state",
			);
		}

		// FROM_VALIDATED_LEGACY_STATE: recovery allowed only with a
		// validated state.json as the authoritative source.
		//
		// Check specific partial states:
		if (snapshot.hasOwnership && !snapshot.hasState) {
			if (
				snapshot.ownershipStatus === "HELD" &&
				snapshot.leaseUntilEpochMs !== null &&
				nowEpochMs < snapshot.leaseUntilEpochMs
			) {
				throw new DbIntegrityError(
					"INCOMPLETE_BOOTSTRAP: ownership held but no state row — no recovery source",
				);
			}
			// Ownership is FREE or expired — proceed to recovery.
		}

		if (snapshot.hasState && !snapshot.hasOwnership) {
			throw new DbIntegrityError(
				"INCOMPLETE_BOOTSTRAP: state exists but no ownership row",
			);
		}

		// Incarnation-only or incarnation+ownership(FREE) — proceed.
	}

	// 2. Ensure incarnation — use the caller-supplied candidate.
	//    If a row already exists the candidate is discarded and the
	//    persisted identity is returned.
	const incarnationId = ensureIncarnationInTransaction(
		db,
		runId,
		params.incarnationCandidate,
		orchestratorName,
		params.legacyStartedAtEpochMs ?? nowEpochMs,
		params.legacyStartedAt ?? nowIso,
	);
	params.onFaultPoint?.("AFTER_INCARNATION_WRITE");

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
	params.onFaultPoint?.("AFTER_OWNERSHIP_WRITE");

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
	params.onFaultPoint?.("AFTER_STATE_WRITE");

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
// Core: bootstrapNewRunAtomicCore
// ---------------------------------------------------------------------------
// The unique implementation of atomic new-run bootstrap.
//
// Production callers go through `bootstrapNewRunAtomic` (run-bootstrap.ts)
// which injects `productionDependencies`.  Tests inject a deterministic
// generator to prove identity stability across SQLITE_BUSY retries.

/** Bootstrap a brand-new run atomically.
 *
 *  All three tables (incarnation, ownership, state) are populated inside a
 *  single BEGIN IMMEDIATE ... COMMIT.  The LockHandle is only constructed
 *  and returned after the COMMIT succeeds.
 *
 *  If any statement fails before COMMIT, the transaction is rolled back.
 *  No partial state is observable, no LockHandle is published.
 *
 *  The `deps.generateId()` parameter permits deterministic testing of
 *  identity stability across SQLITE_BUSY retries.
 *
 *  The `deps.onFaultPoint()` hook is reserved for internal fault injection
 *  tests and is NEVER exposed on the public API. */
export function bootstrapNewRunAtomicCore(
	params: BootstrapNewRunParams,
	deps: BootstrapInternalDependencies,
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

	const ownerToken = deps.generateId();
	const incarnationCandidate = deps.generateId();
	const ownerPid = process.pid;
	const initialStateJson = JSON.stringify(initialState);
	// Timestamps in initialRecord (startedAt, lastTransitionAt, etc.) are
	// pre-lock values.  establishRunInTransaction will normalize them to
	// the post-lock clock for new runs, or preserve legacy timestamps.
	//
	// incarnationCandidate is generated once before the retry loop so
	// that SQLITE_BUSY retries preserve the same logical identity.

	const deadlineMs = performance.now() + contentionDeadlineMs;
	const maxAttempts = 10;

	for (let attempt = 0; attempt < maxAttempts; attempt++) {
		if (performance.now() > deadlineMs) break;

		let transactionStarted = false;
		let committed = false;

		try {
			beginImmediate(db);
			transactionStarted = true;
			deps.onFaultPoint?.("AFTER_BEGIN");
		} catch (error) {
			if (transactionStarted) {
				rollback(db);
			}
			if (isBusy(error)) continue;
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
				partialRecovery: "FORBIDDEN",
				incarnationCandidate,
				...(deps.onFaultPoint ? { onFaultPoint: deps.onFaultPoint } : {}),
			});
		} catch (error) {
			if (transactionStarted && !committed) {
				rollback(db);
			}
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
			if (transactionStarted && !committed) {
				rollback(db);
			}
			return { kind: "ALREADY_ESTABLISHED" };
		}

		// Pre-commit fault point + COMMIT — both wrapped so injected
		// failures at BEFORE_COMMIT trigger rollback.
		try {
			deps.onFaultPoint?.("BEFORE_COMMIT");
			commit(db);
			committed = true;
		} catch (error) {
			if (transactionStarted && !committed) {
				rollback(db);
			}
			if (isBusy(error)) continue;
			return { kind: "DB_FAILURE", cause: error };
		}

		// Post-commit fault point — for structural verification only.
		// An injected failure here CANNOT be rolled back (COMMIT already
		// succeeded).  Crash-recovery tests in later lots will prove
		// correct handle reconstruction after a post-commit crash.
		deps.onFaultPoint?.("AFTER_COMMIT_BEFORE_HANDLE");

		// Only after COMMIT: build LockHandle and CommittedState.
		const handle: LockHandle = {
			ownerToken: establishResult.ownerToken,
			incarnationId: establishResult.incarnationId,
			fenceToken: establishResult.fenceToken,
			leaseUntilEpochMs: establishResult.leaseUntilEpochMs,
		};

		const committedState: CommittedState = {
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

		return { kind: "BOOTSTRAPPED", handle, committed: committedState };
	}

	return { kind: "DB_CONTENTION_TIMEOUT" };
}

// ---------------------------------------------------------------------------
// Core: migrateLegacyRunAtomicCore
// ---------------------------------------------------------------------------
// The unique implementation of atomic legacy-run migration.
//
// Production callers go through `migrateLegacyRunAtomic` (run-bootstrap.ts)
// which injects `productionDependencies`.  Tests inject a deterministic
// generator to prove identity stability across SQLITE_BUSY retries.

/** Migrate a legacy run (state.json, no SQLite DB) into an authoritative
 *  SQLite run atomically.
 *
 *  Legacy migration preserves the logical runId and historical state
 *  timestamps, but assigns a new Turnlock run incarnation because the
 *  legacy protocol did not contain a distinct durable incarnation identity.
 *
 *  Ownership is established with current wall-clock time.
 *  All three tables populated in a single BEGIN IMMEDIATE ... COMMIT.
 *
 *  The `deps.generateId()` parameter permits deterministic testing of
 *  identity stability across SQLITE_BUSY retries.
 *
 *  The `deps.onFaultPoint()` hook is reserved for internal fault injection
 *  tests and is NEVER exposed on the public API. */
export function migrateLegacyRunAtomicCore(
	params: MigrateLegacyRunParams,
	deps: BootstrapInternalDependencies,
): MigrateLegacyRunResult {
	const {
		db,
		runId,
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

	// Generate owner token and incarnation candidate once before the
	// retry loop — a SQLITE_BUSY retry is an infrastructure retry,
	// not a new logical migration attempt, and must preserve the same
	// incarnation identity.
	const ownerToken = deps.generateId();
	const incarnationCandidate = deps.generateId();
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

		let transactionStarted = false;
		let committed = false;

		try {
			beginImmediate(db);
			transactionStarted = true;
			deps.onFaultPoint?.("AFTER_BEGIN");
		} catch (error) {
			if (transactionStarted) {
				rollback(db);
			}
			if (isBusy(error)) continue;
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
				partialRecovery: "FROM_VALIDATED_LEGACY_STATE",
				incarnationCandidate,
				legacyStartedAtEpochMs,
				legacyStartedAt,
				legacyLastTransitionAtEpochMs,
				legacyLastTransitionAt,
				...(deps.onFaultPoint ? { onFaultPoint: deps.onFaultPoint } : {}),
			});
		} catch (error) {
			if (transactionStarted && !committed) {
				rollback(db);
			}
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
			if (transactionStarted && !committed) {
				rollback(db);
			}
			return { kind: "ALREADY_ESTABLISHED" };
		}

		// Pre-commit fault point + COMMIT — both wrapped so injected
		// failures at BEFORE_COMMIT trigger rollback.
		try {
			deps.onFaultPoint?.("BEFORE_COMMIT");
			commit(db);
			committed = true;
		} catch (error) {
			if (transactionStarted && !committed) {
				rollback(db);
			}
			if (isBusy(error)) continue;
			return { kind: "DB_FAILURE", cause: error };
		}

		// Post-commit fault point — for structural verification only.
		// An injected failure here CANNOT be rolled back (COMMIT already
		// succeeded).  Crash-recovery tests in later lots will prove
		// correct handle reconstruction after a post-commit crash.
		deps.onFaultPoint?.("AFTER_COMMIT_BEFORE_HANDLE");

		// Only after COMMIT: build LockHandle and CommittedState.
		const handle: LockHandle = {
			ownerToken: establishResult.ownerToken,
			incarnationId: establishResult.incarnationId,
			fenceToken: establishResult.fenceToken,
			leaseUntilEpochMs: establishResult.leaseUntilEpochMs,
		};

		const committedState: CommittedState = {
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

		return { kind: "MIGRATED", handle, committed: committedState };
	}

	return { kind: "DB_CONTENTION_TIMEOUT" };
}

// ---------------------------------------------------------------------------
// Re-export for convenience
// ---------------------------------------------------------------------------

export type { LockHandle } from "./ownership";
