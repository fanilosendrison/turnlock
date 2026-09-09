import {
	LEGACY_PENDING_INITIAL_DISPATCH_STATE_FIELD,
	LEGACY_PENDING_INITIAL_DISPATCH_VERSION_STATE_FIELD,
	PENDING_INITIAL_DISPATCH_STATE_FIELD,
	PENDING_INITIAL_DISPATCH_VERSION_STATE_FIELD,
} from "../../constants.js";
import { DbIntegrityError } from "./errors.js";
import type {
	BootstrapInternalDependencies,
	MigrateLegacyRunParams,
	MigrateLegacyRunResult,
} from "./run-bootstrap-contracts.js";
import {
	buildEstablishedRunPublication,
	establishRunInTransaction,
} from "./run-bootstrap-establishment.js";
import { executeBootstrapTransaction } from "./run-bootstrap-transaction.js";

function legacyStateWithoutInitialDispatchMarkers(
	params: MigrateLegacyRunParams,
): string {
	const state: Record<string, unknown> = {
		...params.legacyState,
		lastTransitionAt: params.legacyLastTransitionAt,
		lastTransitionAtEpochMs: params.legacyLastTransitionAtEpochMs,
	};
	delete state[PENDING_INITIAL_DISPATCH_STATE_FIELD];
	delete state[PENDING_INITIAL_DISPATCH_VERSION_STATE_FIELD];
	delete state[LEGACY_PENDING_INITIAL_DISPATCH_STATE_FIELD];
	delete state[LEGACY_PENDING_INITIAL_DISPATCH_VERSION_STATE_FIELD];
	return JSON.stringify(state);
}

/** Atomically migrate validated legacy state into the SQLite authority. */
export function migrateLegacyRunAtomicCore(
	params: MigrateLegacyRunParams,
	dependencies: BootstrapInternalDependencies,
): MigrateLegacyRunResult {
	const ownerToken = dependencies.generateId();
	const incarnationCandidate = dependencies.generateId();
	const initialStateJson = legacyStateWithoutInitialDispatchMarkers(params);
	const transaction = executeBootstrapTransaction(
		{
			db: params.db,
			contentionDeadlineMs: params.contentionDeadlineMs,
			...(params.leaseClockEpochMs
				? { leaseClockEpochMs: params.leaseClockEpochMs }
				: {}),
			dependencies,
		},
		(lockEpochMs, lockIso) =>
			establishRunInTransaction(params.db, {
				runId: params.runId,
				orchestratorName: params.orchestratorName,
				nowEpochMs: lockEpochMs,
				nowIso: lockIso,
				leaseDurationMs: params.leaseDurationMs,
				ownerToken,
				ownerPid: process.pid,
				initialStateJson,
				stateSchemaVersion: params.stateSchemaVersion,
				partialRecovery: "FROM_VALIDATED_LEGACY_STATE",
				incarnationCandidate,
				legacyStartedAtEpochMs: params.legacyStartedAtEpochMs,
				legacyStartedAt: params.legacyStartedAt,
				legacyLastTransitionAtEpochMs: params.legacyLastTransitionAtEpochMs,
				legacyLastTransitionAt: params.legacyLastTransitionAt,
				...(dependencies.onFaultPoint
					? { onFaultPoint: dependencies.onFaultPoint }
					: {}),
			}),
	);
	if (transaction.kind === "CONTENTION_TIMEOUT") {
		return { kind: "DB_CONTENTION_TIMEOUT" };
	}
	if (transaction.kind === "NO_COMMIT") {
		return { kind: "ALREADY_ESTABLISHED" };
	}
	if (transaction.kind === "FAILURE") {
		if (transaction.cause instanceof DbIntegrityError) {
			if (transaction.cause.message.startsWith("ACTIVE_CONFLICT")) {
				return { kind: "ACTIVE_CONFLICT" };
			}
			if (transaction.cause.message.startsWith("RUN_RETIRING")) {
				return { kind: "RUN_RETIRING" };
			}
			if (transaction.cause.message.startsWith("INCOMPLETE_BOOTSTRAP")) {
				return {
					kind: "INCOMPLETE_EXISTING_BOOTSTRAP",
					details: transaction.cause.message,
				};
			}
		}
		return { kind: "DB_FAILURE", cause: transaction.cause };
	}
	return {
		kind: "MIGRATED",
		...buildEstablishedRunPublication(transaction.value),
	};
}
