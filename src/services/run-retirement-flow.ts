import * as path from "node:path";
import { RUN_DB_FILENAME } from "../constants.js";
import { claimRunForRetentionDeletion } from "../persistence/sqlite/retention-claim.js";
import type { SqliteDriver } from "../persistence/sqlite/sqlite-driver.js";
import {
	captureRetiredPayloadIdentity,
	publishRetirementReadyMarker,
	RETIREMENT_READY_MARKER_VERSION,
	type RetirementReadyMarkerV1,
	removeRetirementReadyMarkerDurably,
	retiredDirectoryName,
} from "./retirement-journal.js";
import { isValidRunId } from "./run-id.js";
import {
	acquireRunNamespaceMutex,
	NAMESPACE_MUTEX_BUSY_TIMEOUT_MS,
	resolveNamespaceMutexPath,
} from "./run-namespace-mutex.js";
import type {
	RetireRunDirectoryParams,
	RetireUnderMutexResult,
	RunDirRetirement,
	RunRetirementInternalDependencies,
	RunRetirementOutcome,
} from "./run-retirement-contracts.js";
import { RETIRED_DIR_NAME } from "./run-retirement-layout.js";
import { renameRunDirectoryToRetiredInternal } from "./run-retirement-rename.js";
import {
	deleteRetiredRunDirectory,
	sweepRetiredRunDirectories,
} from "./run-retirement-sweep.js";

const productionRetirementDependencies: RunRetirementInternalDependencies = {};

/** Claim, verify, rename, fsync, post-check, and publish READY while the
 *  per-run namespace mutex is held. Never performs recursive deletion. */
function retireUnderMutex(params: {
	readonly driver: SqliteDriver;
	readonly runDir: string;
	readonly runId: string;
	readonly orchestratorName?: string;
	readonly orchestratorBaseDir: string;
	readonly dependencies: RunRetirementInternalDependencies;
}): RetireUnderMutexResult {
	const { driver, runDir, runId, orchestratorBaseDir, dependencies } = params;
	const claim = claimRunForRetentionDeletion({
		driver,
		dbPath: path.join(runDir, RUN_DB_FILENAME),
		runId,
		...(params.orchestratorName !== undefined
			? { expectedOrchestratorName: params.orchestratorName }
			: {}),
		busyTimeoutMs: 2000,
		contentionDeadlineMs: 5000,
	});
	switch (claim.kind) {
		case "LIVE_OWNER":
			return { kind: "KEPT", reason: "LIVE_OWNER" };
		case "UNKNOWN":
			return { kind: "KEPT", reason: "UNKNOWN" };
		case "DB_FAILURE":
			return { kind: "KEPT", reason: "DB_FAILURE" };
		case "DB_CONTENTION_TIMEOUT":
			return { kind: "KEPT", reason: "DB_CONTENTION_TIMEOUT" };
		case "CLAIMED":
		case "ALREADY_RETIRING":
			break;
	}
	const rename = renameRunDirectoryToRetiredInternal(
		{
			driver,
			runDir,
			runId,
			retirementToken: claim.retirementToken,
			incarnationId: claim.incarnationId,
			...(params.orchestratorName !== undefined
				? { expectedOrchestratorName: params.orchestratorName }
				: {}),
			databaseIdentity: claim.databaseIdentity,
		},
		dependencies,
	);
	if (rename.kind === "MISMATCH") {
		return { kind: "KEPT", reason: "IDENTITY_MISMATCH" };
	}
	if (rename.kind === "DETACHED_UNREADY") {
		return {
			kind: "DETACHED",
			retiredPath: rename.retiredPath,
			retirementToken: claim.retirementToken,
			readyPublished: false,
		};
	}
	const payloadIdentity = captureRetiredPayloadIdentity(rename.retiredPath);
	if (payloadIdentity === null) {
		return {
			kind: "DETACHED",
			retiredPath: rename.retiredPath,
			retirementToken: claim.retirementToken,
			readyPublished: false,
		};
	}
	const marker: RetirementReadyMarkerV1 = {
		version: RETIREMENT_READY_MARKER_VERSION,
		orchestratorName: claim.orchestratorName,
		runId: claim.runId,
		incarnationId: claim.incarnationId,
		retirementToken: claim.retirementToken,
		retirementClaimedAtEpochMs: claim.retirementClaimedAtEpochMs,
		retiredEntryName: retiredDirectoryName(runId, claim.retirementToken),
		payloadIdentity,
	};
	const publish = publishRetirementReadyMarker({
		retiredRoot: path.join(orchestratorBaseDir, RETIRED_DIR_NAME),
		marker,
	});
	return {
		kind: "DETACHED",
		retiredPath: rename.retiredPath,
		retirementToken: claim.retirementToken,
		readyPublished:
			publish.kind === "PUBLISHED" ||
			publish.kind === "ALREADY_PUBLISHED_IDENTICAL",
	};
}

/** Retire and delete one canonical RUN_DIR candidate. */
export function retireRunDirectory(
	params: RetireRunDirectoryParams,
): RunRetirementOutcome {
	return retireRunDirectoryInternal(params, productionRetirementDependencies);
}

/** Internal retirement variant with test-only fault injection. */
export function retireRunDirectoryInternal(
	params: RetireRunDirectoryParams,
	dependencies: RunRetirementInternalDependencies,
): RunRetirementOutcome {
	const { driver, runDir, runId } = params;
	if (!isValidRunId(runId)) {
		return { kind: "KEPT", reason: "UNKNOWN" };
	}
	const orchestratorBaseDir = path.dirname(runDir);
	const mutexPath = resolveNamespaceMutexPath(orchestratorBaseDir, runId);
	const acquired = acquireRunNamespaceMutex({
		driver,
		mutexPath,
		busyTimeoutMs: NAMESPACE_MUTEX_BUSY_TIMEOUT_MS,
	});
	if (acquired.kind !== "ACQUIRED") {
		return {
			kind: "KEPT",
			reason:
				acquired.kind === "CONTENTION_TIMEOUT"
					? "DB_CONTENTION_TIMEOUT"
					: "NAMESPACE_MUTEX_FAILURE",
		};
	}
	let underMutex: RetireUnderMutexResult;
	try {
		underMutex = retireUnderMutex({
			driver,
			runDir,
			runId,
			...(params.orchestratorName !== undefined
				? { orchestratorName: params.orchestratorName }
				: {}),
			orchestratorBaseDir,
			dependencies,
		});
	} catch (error) {
		acquired.handle.rollbackAndRelease();
		throw error;
	}
	// Release before recursive deletion so a new incarnation may establish
	// the canonical pathname independently of old-payload removal.
	acquired.handle.release();
	switch (underMutex.kind) {
		case "KEPT":
			return { kind: "KEPT", reason: underMutex.reason };
		case "DETACHED": {
			if (!underMutex.readyPublished) {
				return {
					kind: "DETACHED_PENDING_SWEEP",
					retirementToken: underMutex.retirementToken,
				};
			}
			const deletion = deleteRetiredRunDirectory(underMutex.retiredPath);
			if (deletion.kind !== "DELETED") {
				return {
					kind: "DETACHED_PENDING_SWEEP",
					retirementToken: underMutex.retirementToken,
				};
			}
			removeRetirementReadyMarkerDurably({
				retiredRoot: path.join(orchestratorBaseDir, RETIRED_DIR_NAME),
				entryName: retiredDirectoryName(runId, underMutex.retirementToken),
			});
			return { kind: "DELETED" };
		}
	}
}

/** Build the production filesystem-retirement delegate for a driver. */
export function buildRunRetirement(driver: SqliteDriver): RunDirRetirement {
	return {
		retireRunDirectory: (runDir, runId, orchestratorName) =>
			retireRunDirectory({
				driver,
				runDir,
				runId,
				...(orchestratorName !== undefined ? { orchestratorName } : {}),
			}),
		sweepRetiredDirectories: (retiredRoot, orchestratorName) =>
			sweepRetiredRunDirectories({ driver, retiredRoot, orchestratorName }),
	};
}
