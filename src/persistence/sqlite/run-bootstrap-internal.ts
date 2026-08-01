// Internal injectable variants of atomic run bootstrap and legacy migration.
// NOT part of the public API — reserved for internal tests.
//
// Public consumers must use `bootstrapNewRunAtomic` / `migrateLegacyRunAtomic`
// from `run-bootstrap.ts`, which always use the production `generateRunId`
// identity generator.

import { generateRunId } from "../../services/run-id";
import { DbIntegrityError } from "./errors";
import { beginImmediate, commit, type LockHandle, rollback } from "./ownership";
import {
	type BootstrapNewRunParams,
	type BootstrapNewRunResult,
	type CommittedState,
	type EstablishResult,
	establishRunInTransaction,
	isBusy,
	type MigrateLegacyRunParams,
	type MigrateLegacyRunResult,
} from "./run-bootstrap";

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

/** Injectable dependencies for atomic run bootstrap.  The production value is
 *  `productionDependencies`.  Tests may supply a deterministic generator to
 *  verify identity stability across retries. */
export interface RunBootstrapDependencies {
	readonly generateId: () => string;
}

/** Production dependencies — always uses `generateRunId`. */
export const productionDependencies: RunBootstrapDependencies = {
	generateId: generateRunId,
};

// ---------------------------------------------------------------------------
// Bootstrap — injectable implementation
// ---------------------------------------------------------------------------

/** Bootstrap a brand-new run atomically (injectable).
 *
 *  Prefer `bootstrapNewRunAtomic` from run-bootstrap.ts for production
 *  callers.  This variant exists solely for deterministic testing. */
export function bootstrapNewRunAtomicWithDependencies(
	params: BootstrapNewRunParams,
	deps: RunBootstrapDependencies,
): BootstrapNewRunResult {
	const {
		db,
		runId,
		orchestratorName,
		leaseDurationMs,
		initialState,
		stateSchemaVersion,
		contentionDeadlineMs,
	} = params;

	const ownerToken = deps.generateId();
	const incarnationCandidate = deps.generateId();
	const ownerPid = process.pid;
	const initialStateJson = JSON.stringify(initialState);

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
			});
		} catch (error) {
			rollback(db);
			if (error instanceof DbIntegrityError) {
				const msg = error.message;
				if (msg.startsWith("ACTIVE_CONFLICT")) {
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

		try {
			commit(db);
		} catch (error) {
			rollback(db);
			if (isBusy(error)) continue;
			return { kind: "DB_FAILURE", cause: error };
		}

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
// Migration — injectable implementation
// ---------------------------------------------------------------------------

/** Migrate a legacy run atomically (injectable).
 *
 *  Prefer `migrateLegacyRunAtomic` from run-bootstrap.ts for production
 *  callers.  This variant exists solely for deterministic testing. */
export function migrateLegacyRunAtomicWithDependencies(
	params: MigrateLegacyRunParams,
	deps: RunBootstrapDependencies,
): MigrateLegacyRunResult {
	const {
		db,
		runId,
		orchestratorName,
		leaseDurationMs,
		legacyState,
		legacyStartedAtEpochMs,
		legacyStartedAt,
		legacyLastTransitionAtEpochMs,
		legacyLastTransitionAt,
		stateSchemaVersion,
		contentionDeadlineMs,
	} = params;

	const ownerToken = deps.generateId();
	const incarnationCandidate = deps.generateId();
	const ownerPid = process.pid;

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

		try {
			commit(db);
		} catch (error) {
			rollback(db);
			if (isBusy(error)) continue;
			return { kind: "DB_FAILURE", cause: error };
		}

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

export type { LockHandle } from "./ownership";
