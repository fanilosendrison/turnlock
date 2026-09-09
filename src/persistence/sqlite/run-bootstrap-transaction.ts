import { beginImmediate, commit, rollback } from "./ownership.js";
import type {
	BootstrapInternalDependencies,
	BootstrapNewRunParams,
} from "./run-bootstrap-contracts.js";
import { isBusy } from "./run-bootstrap-establishment.js";
import type { SqliteConnection } from "./sqlite-driver.js";

interface BootstrapTransactionParams {
	readonly db: SqliteConnection;
	readonly contentionDeadlineMs: number;
	readonly leaseClockEpochMs?: BootstrapNewRunParams["leaseClockEpochMs"];
	readonly dependencies: BootstrapInternalDependencies;
}

export type BootstrapTransactionResult<T> =
	| { readonly kind: "COMMITTED"; readonly value: T }
	| { readonly kind: "NO_COMMIT" }
	| { readonly kind: "CONTENTION_TIMEOUT" }
	| {
			readonly kind: "FAILURE";
			readonly cause: unknown;
			readonly lockEpochMs?: number;
	  };

/** Execute the shared BEGIN/operation/COMMIT retry protocol to its deadline. */
export function executeBootstrapTransaction<T>(
	params: BootstrapTransactionParams,
	operation: (lockEpochMs: number, lockIso: string) => T | null,
): BootstrapTransactionResult<T> {
	const deadlineMs = performance.now() + params.contentionDeadlineMs;
	for (;;) {
		if (performance.now() > deadlineMs) {
			return { kind: "CONTENTION_TIMEOUT" };
		}
		try {
			beginImmediate(params.db);
			params.dependencies.onFaultPoint?.("AFTER_BEGIN");
		} catch (error) {
			rollback(params.db);
			if (isBusy(error)) continue;
			return { kind: "FAILURE", cause: error };
		}
		const lockEpochMs = (params.leaseClockEpochMs ?? Date.now)();
		const lockIso = new Date(lockEpochMs).toISOString();
		let value: T | null;
		try {
			value = operation(lockEpochMs, lockIso);
		} catch (error) {
			rollback(params.db);
			if (isBusy(error)) continue;
			return { kind: "FAILURE", cause: error, lockEpochMs };
		}
		if (value === null) {
			rollback(params.db);
			return { kind: "NO_COMMIT" };
		}
		try {
			params.dependencies.onFaultPoint?.("BEFORE_COMMIT");
			commit(params.db);
		} catch (error) {
			rollback(params.db);
			if (isBusy(error)) continue;
			return { kind: "FAILURE", cause: error, lockEpochMs };
		}
		params.dependencies.onFaultPoint?.("AFTER_COMMIT_BEFORE_HANDLE");
		return { kind: "COMMITTED", value };
	}
}
