// ⚠️ UNSAFE — DO NOT IMPORT IN PRODUCTION CODE ⚠️
//
// Provides the legacy unfenced state.json writer for test fixtures.
// Production code MUST use projectAuthoritativeStateFenced instead,
// which re-reads the state from SQLite inside a transaction and
// verifies ownership + lease + revision + digest before writing.

import * as fs from "node:fs";
import * as path from "node:path";
import type { StateRecord } from "../../src/persistence/sqlite/run-state-store";

/** Write state.json without any fencing check.
 *
 *  Only for tests that verify the projection format directly. */
export function unsafeWriteStateJson(
	runDir: string,
	state: StateRecord<object>,
	digest: string,
): void {
	const projection: Record<string, unknown> = {
		schemaVersion: state.schemaVersion,
		runId: state.runId,
		orchestratorName: state.orchestratorName,
		startedAt: state.startedAt,
		startedAtEpochMs: state.startedAtEpochMs,
		lastTransitionAt: state.lastTransitionAt,
		lastTransitionAtEpochMs: state.lastTransitionAtEpochMs,
		currentPhase: state.currentPhase,
		phasesExecuted: state.phasesExecuted,
		accumulatedDurationMs: state.accumulatedDurationMs,
		data: state.data,
		usedLabels: state.usedLabels,
		runIncarnationId: state.runIncarnationId,
		stateRevision: String(state.stateRevision),
		committedFenceToken: String(state.committedFenceToken),
		stateDigest: digest,
	};
	if (state.pendingDelegation !== undefined) {
		projection.pendingDelegation = state.pendingDelegation;
	}
	if (state.pendingExternalRequest !== undefined) {
		projection.pendingExternalRequest = state.pendingExternalRequest;
	}
	if (state.terminalResult !== undefined) {
		projection.terminalResult = state.terminalResult;
	}

	const json = JSON.stringify(projection);
	const tmpPath = path.join(runDir, "state.json.tmp");
	const statePath = path.join(runDir, "state.json");

	fs.writeFileSync(tmpPath, json, { encoding: "utf-8" });
	fs.renameSync(tmpPath, statePath);
}
