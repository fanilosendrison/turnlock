import { createHash } from "node:crypto";
import { DbIntegrityError } from "./errors.js";
import {
	acquireOwnershipDirectInTransaction,
	ensureIncarnationInTransaction,
	ensureOwnershipRowInTransaction,
	type LockHandle,
} from "./ownership.js";
import type {
	BootstrapFaultPoint,
	CommittedState,
} from "./run-bootstrap-contracts.js";
import type { SqliteConnection } from "./sqlite-driver.js";
import {
	ensureWorkflowLifecycleRowInTransaction,
	readWorkflowLifecycleRow,
	WORKFLOW_STATUS_TERMINAL,
} from "./workflow-lifecycle.js";

function bigintFromRow(value: unknown): bigint {
	if (typeof value === "bigint") return value;
	if (typeof value === "number") return BigInt(value);
	throw new DbIntegrityError(`expected bigint, got ${typeof value}`);
}

export function computeDigest(json: string): string {
	return `sha256:${createHash("sha256").update(json).digest("hex")}`;
}

export function isBusy(error: unknown): boolean {
	const message = String(error);
	return (
		message.includes("SQLITE_BUSY") || message.includes("database is locked")
	);
}

interface RunDatabaseSnapshot {
	readonly incarnation:
		| {
				readonly runId: string;
				readonly incarnationId: string;
				readonly orchestratorName: string;
		  }
		| undefined;
	readonly workflowIncarnationId: string | null;
	readonly workflowIsTerminal: boolean;
	readonly ownershipIncarnationId: string | null;
	readonly stateIncarnationId: string | null;
	readonly ownershipStatus: string | null;
	readonly leaseUntilEpochMs: number | null;
}

function readRunDatabaseSnapshot(db: SqliteConnection): RunDatabaseSnapshot {
	const incarnation = db
		.prepare(`SELECT run_id, incarnation_id, orchestrator_name
			 FROM run_incarnation WHERE singleton = 1`)
		.get() as
		| {
				readonly run_id: string;
				readonly incarnation_id: string;
				readonly orchestrator_name: string;
		  }
		| undefined;
	const workflowLifecycle = readWorkflowLifecycleRow(db);
	const ownership = db
		.prepare(`SELECT incarnation_id, ownership_status, lease_until_epoch_ms
			 FROM run_ownership WHERE singleton = 1`)
		.get() as
		| {
				readonly incarnation_id: string;
				readonly ownership_status: string;
				readonly lease_until_epoch_ms: number | null;
		  }
		| undefined;
	const state = db
		.prepare("SELECT incarnation_id FROM run_state WHERE singleton = 1")
		.get<{ readonly incarnation_id: string }>();
	return {
		incarnation:
			incarnation === undefined
				? undefined
				: {
						runId: incarnation.run_id,
						incarnationId: incarnation.incarnation_id,
						orchestratorName: incarnation.orchestrator_name,
					},
		workflowIncarnationId: workflowLifecycle?.incarnationId ?? null,
		workflowIsTerminal: workflowLifecycle?.status === WORKFLOW_STATUS_TERMINAL,
		ownershipIncarnationId: ownership?.incarnation_id ?? null,
		stateIncarnationId: state?.incarnation_id ?? null,
		ownershipStatus: ownership?.ownership_status ?? null,
		leaseUntilEpochMs: ownership?.lease_until_epoch_ms ?? null,
	};
}
export interface EstablishResult {
	readonly incarnationId: string;
	readonly ownerToken: string;
	readonly fenceToken: bigint;
	readonly leaseUntilEpochMs: number;
	readonly stateDigest: string;
	readonly stateRevision: string;
	readonly committedFenceToken: string;
	readonly normalizedState: Record<string, unknown>;
}

export interface EstablishedRunPublication {
	readonly handle: LockHandle;
	readonly committed: CommittedState;
}

export function buildEstablishedRunPublication(
	established: EstablishResult,
): EstablishedRunPublication {
	return {
		handle: {
			ownerToken: established.ownerToken,
			incarnationId: established.incarnationId,
			fenceToken: established.fenceToken,
			leaseUntilEpochMs: established.leaseUntilEpochMs,
		},
		committed: {
			state: {
				...established.normalizedState,
				runIncarnationId: established.incarnationId,
				stateRevision: established.stateRevision,
				committedFenceToken: established.committedFenceToken,
			},
			stateDigest: established.stateDigest,
			stateRevision: established.stateRevision,
			committedFenceToken: established.committedFenceToken,
			incarnationId: established.incarnationId,
		},
	};
}

export type PartialRecoveryPolicy = "FORBIDDEN" | "FROM_VALIDATED_LEGACY_STATE";

export interface EstablishRunParams {
	readonly runId: string;
	readonly orchestratorName: string;
	readonly nowEpochMs: number;
	readonly nowIso: string;
	readonly leaseDurationMs: number;
	readonly ownerToken: string;
	readonly ownerPid: number;
	readonly initialStateJson: string;
	readonly stateSchemaVersion: number;
	readonly partialRecovery: PartialRecoveryPolicy;
	readonly incarnationCandidate: string;
	readonly legacyStartedAtEpochMs?: number;
	readonly legacyStartedAt?: string;
	readonly legacyLastTransitionAtEpochMs?: number;
	readonly legacyLastTransitionAt?: string;
	readonly onFaultPoint?: (point: BootstrapFaultPoint) => void;
}

function isCompleteSnapshot(snapshot: RunDatabaseSnapshot): boolean {
	return (
		snapshot.incarnation !== undefined &&
		snapshot.workflowIncarnationId !== null &&
		snapshot.ownershipIncarnationId !== null &&
		snapshot.stateIncarnationId !== null
	);
}

function assertCompleteSnapshotIdentity(
	snapshot: RunDatabaseSnapshot,
	runId: string,
	orchestratorName: string,
): void {
	if (!isCompleteSnapshot(snapshot) || snapshot.incarnation === undefined) {
		throw new DbIntegrityError("run authority snapshot is incomplete");
	}
	const incarnationId = snapshot.incarnation.incarnationId;
	if (
		snapshot.incarnation.runId !== runId ||
		snapshot.incarnation.orchestratorName !== orchestratorName ||
		snapshot.workflowIncarnationId !== incarnationId ||
		snapshot.ownershipIncarnationId !== incarnationId ||
		snapshot.stateIncarnationId !== incarnationId
	) {
		throw new DbIntegrityError(
			"established run authority identity is incoherent",
		);
	}
}

function assertRecoverableSnapshot(
	snapshot: RunDatabaseSnapshot,
	partialRecovery: PartialRecoveryPolicy,
	nowEpochMs: number,
): void {
	const hasIncarnation = snapshot.incarnation !== undefined;
	const hasWorkflowLifecycle = snapshot.workflowIncarnationId !== null;
	const hasOwnership = snapshot.ownershipIncarnationId !== null;
	const hasState = snapshot.stateIncarnationId !== null;
	const hasAnyRow =
		hasIncarnation || hasWorkflowLifecycle || hasOwnership || hasState;
	const isComplete = isCompleteSnapshot(snapshot);
	if (!hasAnyRow || isComplete) return;
	if (partialRecovery === "FORBIDDEN") {
		throw new DbIntegrityError(
			"INCOMPLETE_BOOTSTRAP: partial DB detected — recovery forbidden without validated legacy state",
		);
	}
	if (snapshot.workflowIsTerminal && !hasState) {
		throw new DbIntegrityError(
			"INCOMPLETE_BOOTSTRAP: terminal lifecycle cannot accept replacement state",
		);
	}
	if (
		hasOwnership &&
		!hasState &&
		snapshot.ownershipStatus === "HELD" &&
		snapshot.leaseUntilEpochMs !== null &&
		nowEpochMs < snapshot.leaseUntilEpochMs
	) {
		throw new DbIntegrityError(
			"INCOMPLETE_BOOTSTRAP: ownership held but no state row — no recovery source",
		);
	}
	if (hasState && !hasOwnership) {
		throw new DbIntegrityError(
			"INCOMPLETE_BOOTSTRAP: state exists but no ownership row",
		);
	}
}

function insertInitialState(
	db: SqliteConnection,
	params: {
		readonly incarnationId: string;
		readonly stateSchemaVersion: number;
		readonly stateJson: string;
		readonly stateDigest: string;
		readonly ownerToken: string;
		readonly fenceToken: bigint;
		readonly nowEpochMs: number;
		readonly nowIso: string;
	},
):
	| {
			readonly state_revision: number | bigint;
			readonly state_digest: string;
			readonly committed_by_fence_token: number | bigint;
	  }
	| undefined {
	return db
		.prepare(`INSERT INTO run_state (
		    singleton, incarnation_id, state_revision, state_schema_version,
		    state_json, state_digest, committed_by_owner_token,
		    committed_by_fence_token, committed_at_epoch_ms, committed_at_iso
		)
		SELECT 1, :incarnation_id, 0, :schema_version, :state_json,
		       :state_digest, :owner_token, :fence_token, :now_epoch, :now_iso
		WHERE NOT EXISTS (SELECT 1 FROM run_state WHERE singleton = 1)
		RETURNING state_revision, state_digest, committed_by_fence_token`)
		.get({
			":incarnation_id": params.incarnationId,
			":schema_version": params.stateSchemaVersion,
			":state_json": params.stateJson,
			":state_digest": params.stateDigest,
			":owner_token": params.ownerToken,
			":fence_token": params.fenceToken,
			":now_epoch": params.nowEpochMs,
			":now_iso": params.nowIso,
		}) as
		| {
				readonly state_revision: number | bigint;
				readonly state_digest: string;
				readonly committed_by_fence_token: number | bigint;
		  }
		| undefined;
}

export function establishRunInTransaction(
	db: SqliteConnection,
	params: EstablishRunParams,
): EstablishResult | null {
	const startedAtEpochMs = params.legacyStartedAtEpochMs ?? params.nowEpochMs;
	const startedAt = params.legacyStartedAt ?? params.nowIso;
	const lastTransitionAtEpochMs =
		params.legacyLastTransitionAtEpochMs ?? params.nowEpochMs;
	const lastTransitionAt = params.legacyLastTransitionAt ?? params.nowIso;
	const normalizedState = JSON.parse(params.initialStateJson) as Record<
		string,
		unknown
	>;
	normalizedState.startedAt = startedAt;
	normalizedState.startedAtEpochMs = startedAtEpochMs;
	normalizedState.lastTransitionAt = lastTransitionAt;
	normalizedState.lastTransitionAtEpochMs = lastTransitionAtEpochMs;
	const stateJson = JSON.stringify(normalizedState);

	const snapshot = readRunDatabaseSnapshot(db);
	if (isCompleteSnapshot(snapshot)) {
		assertCompleteSnapshotIdentity(
			snapshot,
			params.runId,
			params.orchestratorName,
		);
		if (
			snapshot.ownershipStatus === "HELD" &&
			snapshot.leaseUntilEpochMs !== null &&
			params.nowEpochMs < snapshot.leaseUntilEpochMs
		) {
			throw new DbIntegrityError(
				"ACTIVE_CONFLICT: ownership held by another process",
			);
		}
		return null;
	}
	assertRecoverableSnapshot(
		snapshot,
		params.partialRecovery,
		params.nowEpochMs,
	);

	const incarnationId = ensureIncarnationInTransaction(
		db,
		params.runId,
		params.incarnationCandidate,
		params.orchestratorName,
		startedAtEpochMs,
		startedAt,
	);
	params.onFaultPoint?.("AFTER_INCARNATION_WRITE");
	ensureWorkflowLifecycleRowInTransaction(db, incarnationId);
	params.onFaultPoint?.("AFTER_LIFECYCLE_WRITE");
	ensureOwnershipRowInTransaction(db, incarnationId);
	const acquired = acquireOwnershipDirectInTransaction(
		db,
		incarnationId,
		params.ownerToken,
		params.ownerPid,
		params.nowEpochMs,
		params.leaseDurationMs,
	);
	if (acquired.kind === "RUN_RETIRING") {
		throw new DbIntegrityError(
			"RUN_RETIRING: retention retirement consumed — no ownership may be published",
		);
	}
	if (acquired.kind === "ACTIVE_CONFLICT") {
		throw new DbIntegrityError(
			"ACTIVE_CONFLICT: ownership held by another process",
		);
	}
	params.onFaultPoint?.("AFTER_OWNERSHIP_WRITE");

	const digest = computeDigest(stateJson);
	const inserted = insertInitialState(db, {
		incarnationId,
		stateSchemaVersion: params.stateSchemaVersion,
		stateJson,
		stateDigest: digest,
		ownerToken: params.ownerToken,
		fenceToken: acquired.fenceToken,
		nowEpochMs: params.nowEpochMs,
		nowIso: params.nowIso,
	});
	if (inserted === undefined) {
		const existingState = db
			.prepare("SELECT 1 FROM run_state WHERE singleton = 1")
			.get();
		if (existingState !== undefined) {
			throw new DbIntegrityError(
				"INCOMPLETE_BOOTSTRAP: state pre-existed an incomplete authority",
			);
		}
		throw new DbIntegrityError(
			"Failed to insert initial state row — unknown reason",
		);
	}
	params.onFaultPoint?.("AFTER_STATE_WRITE");
	const finalSnapshot = readRunDatabaseSnapshot(db);
	if (!isCompleteSnapshot(finalSnapshot)) {
		throw new DbIntegrityError(
			"Post-insert coherence check failed — partial state detected",
		);
	}
	assertCompleteSnapshotIdentity(
		finalSnapshot,
		params.runId,
		params.orchestratorName,
	);
	return {
		incarnationId,
		ownerToken: params.ownerToken,
		fenceToken: acquired.fenceToken,
		leaseUntilEpochMs: acquired.leaseUntilEpochMs,
		stateDigest: inserted.state_digest,
		stateRevision: String(bigintFromRow(inserted.state_revision)),
		committedFenceToken: String(
			bigintFromRow(inserted.committed_by_fence_token),
		),
		normalizedState,
	};
}
