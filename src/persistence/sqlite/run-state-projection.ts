import * as fs from "node:fs";
import * as path from "node:path";
import {
	AuthorityLostError,
	PersistenceFailureError,
} from "../../errors/concrete.js";
import type { LockHandle } from "./ownership-contracts.js";
import { verifyLiveOwnershipInTransaction } from "./ownership-live-verification.js";
import { beginImmediate, commit, rollback } from "./ownership-transactions.js";
import type {
	ProjectionInternalDependencies,
	StateRecord,
} from "./run-state-contracts.js";
import { readAuthoritativeState } from "./run-state-read.js";
import type { SqliteConnection } from "./sqlite-driver.js";

const productionProjectionDependencies: ProjectionInternalDependencies = {};

/** Write the repairable filesystem projection with durable rename ordering. */
function writeStateJsonProjection(
	runDir: string,
	state: StateRecord<object>,
	digest: string,
	dependencies: ProjectionInternalDependencies,
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
	const temporaryFile = fs.openSync(tmpPath, "w", 0o600);
	try {
		fs.writeFileSync(temporaryFile, json, { encoding: "utf-8" });
		dependencies.onFaultPoint?.("AFTER_TEMP_FILE_WRITE");
		fs.fsyncSync(temporaryFile);
		dependencies.onFaultPoint?.("AFTER_TEMP_FILE_FSYNC");
	} finally {
		fs.closeSync(temporaryFile);
	}
	fs.renameSync(tmpPath, statePath);
	dependencies.onFaultPoint?.("AFTER_RENAME");
	const directory = fs.openSync(runDir, fs.constants.O_RDONLY);
	try {
		dependencies.onFaultPoint?.("BEFORE_DIRECTORY_FSYNC");
		fs.fsyncSync(directory);
	} finally {
		fs.closeSync(directory);
	}
}

/** Project the SQLite-authoritative state.json under the ownership fence. */
export function projectAuthoritativeStateFenced(
	db: SqliteConnection,
	handle: LockHandle,
	runDir: string,
	expectedRevision: string,
	expectedDigest: string,
	leaseClockEpochMs?: () => number,
	dependencies: ProjectionInternalDependencies = productionProjectionDependencies,
): void {
	try {
		beginImmediate(db);
	} catch (error) {
		throw new PersistenceFailureError(
			"fenced state.json projection: BEGIN IMMEDIATE failed",
			{ operation: "state_commit", cause: error },
		);
	}
	const nowEpochMs = (leaseClockEpochMs ?? Date.now)();
	try {
		const verification = verifyLiveOwnershipInTransaction(
			db,
			handle,
			nowEpochMs,
		);
		if (verification.kind !== "LIVE") {
			rollback(db);
			throw new AuthorityLostError(
				`Fenced state.json projection rejected: ${verification.kind === "EXPIRED_HANDLE" ? "lease expired" : "ownership not live"}`,
				{
					operation: "state_commit",
					reason:
						verification.kind === "RETIRING"
							? "STALE_HANDLE"
							: verification.kind,
				},
			);
		}
		const readResult = readAuthoritativeState(db);
		if (readResult.state === null) {
			rollback(db);
			throw new PersistenceFailureError(
				"fenced state.json projection: state row missing",
				{ operation: "state_commit" },
			);
		}
		if (readResult.state.stateRevision !== expectedRevision) {
			rollback(db);
			throw new AuthorityLostError(
				`Fenced state.json projection rejected: revision mismatch (expected ${expectedRevision}, got ${readResult.state.stateRevision})`,
				{ operation: "state_commit", reason: "STALE_HANDLE" },
			);
		}
		if ((readResult.digest ?? "") !== expectedDigest) {
			rollback(db);
			throw new PersistenceFailureError(
				"fenced state.json projection: digest mismatch",
				{ operation: "state_commit" },
			);
		}
		writeStateJsonProjection(
			runDir,
			readResult.state,
			readResult.digest ?? expectedDigest,
			dependencies,
		);
		commit(db);
	} catch (error) {
		rollback(db);
		if (
			error instanceof AuthorityLostError ||
			error instanceof PersistenceFailureError
		) {
			throw error;
		}
		throw new PersistenceFailureError(
			`fenced state.json projection failed: ${error instanceof Error ? error.message : String(error)}`,
			{ operation: "state_commit", cause: error },
		);
	}
}
