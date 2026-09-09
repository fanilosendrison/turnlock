import { DbIntegrityError } from "./errors.js";
import type {
	BootstrapInternalDependencies,
	BootstrapNewRunParams,
	BootstrapNewRunResult,
} from "./run-bootstrap-contracts.js";
import {
	buildEstablishedRunPublication,
	establishRunInTransaction,
} from "./run-bootstrap-establishment.js";
import { executeBootstrapTransaction } from "./run-bootstrap-transaction.js";

/** Atomically bootstrap a new run and publish its handle only after commit. */
export function bootstrapNewRunAtomicCore(
	params: BootstrapNewRunParams,
	dependencies: BootstrapInternalDependencies,
): BootstrapNewRunResult {
	const ownerToken = dependencies.generateId();
	const incarnationCandidate = dependencies.generateId();
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
				initialStateJson: JSON.stringify(params.initialState),
				stateSchemaVersion: params.stateSchemaVersion,
				partialRecovery: "FORBIDDEN",
				incarnationCandidate,
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
				const ownership = params.db
					.prepare(
						"SELECT lease_until_epoch_ms FROM run_ownership WHERE singleton = 1",
					)
					.get<{ readonly lease_until_epoch_ms: number }>();
				return {
					kind: "ACTIVE_CONFLICT",
					leaseUntilEpochMs:
						ownership?.lease_until_epoch_ms ??
						(transaction.lockEpochMs ?? Date.now()) + params.leaseDurationMs,
				};
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
		kind: "BOOTSTRAPPED",
		...buildEstablishedRunPublication(transaction.value),
	};
}
