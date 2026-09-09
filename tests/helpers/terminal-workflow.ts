import assert from "node:assert/strict";
import type { BootstrapNewRunResult } from "../../src/persistence/sqlite/run-bootstrap.js";
import {
	commitState,
	type StateRecord,
} from "../../src/persistence/sqlite/run-state-store.js";
import type { SqliteConnection } from "../../src/persistence/sqlite/sqlite-driver.js";

export function commitTerminalDone(
	db: SqliteConnection,
	bootstrap: Extract<BootstrapNewRunResult, { readonly kind: "BOOTSTRAPPED" }>,
	terminalAtEpochMs: number,
): void {
	const terminalState = {
		...bootstrap.committed.state,
		phasesExecuted: 1,
		terminalResult: {
			kind: "done" as const,
			outputArtifact: {
				kind: "terminal-output" as const,
				digestAlgorithm: "sha256" as const,
				digest: `sha256:${"0".repeat(64)}` as const,
				relativePath: `artifacts/sha256/00/${"0".repeat(62)}.json`,
				mediaType: "application/json" as const,
				sizeBytes: 0,
			},
			completedAt: new Date(terminalAtEpochMs).toISOString(),
			completedAtEpochMs: terminalAtEpochMs,
		},
	};
	const committed = commitState({
		db,
		handle: bootstrap.handle,
		expectedRevision: bootstrap.committed.stateRevision,
		nextState: terminalState as StateRecord<object>,
		nowEpochMs: terminalAtEpochMs,
		nowIso: new Date(terminalAtEpochMs).toISOString(),
		leaseClockEpochMs: () => terminalAtEpochMs,
		terminalKind: "DONE",
	});
	assert.strictEqual(committed.kind, "COMMITTED");
}
