import * as fs from "node:fs";
import * as path from "node:path";
import {
	ArtifactIntegrityError,
	AuthorityLostError,
	PersistenceFailureError,
} from "../errors/concrete.js";
import {
	beginImmediate,
	commit,
	rollback,
	verifyLiveOwnershipInTransaction,
} from "../persistence/sqlite/ownership.js";
import { readAndVerifyArtifact } from "../services/artifact-store.js";
import { clock as defaultClock } from "../services/clock.js";
import { ensureDirectoryPathWithoutSymlinks } from "../services/durable-fs.js";
import type { ArtifactRef } from "../types/artifacts.js";
import { stateOperationErrorOptions } from "./authoritative-operation-errors.js";
import type {
	CanonicalArtifactProjectionContext,
	ExpectedArtifactPlacement,
} from "./state-commit-contracts.js";

/** Project an immutable artifact as a canonical file only while the caller
 *  owns the live authority and current state still references that artifact. */
export function projectCanonicalArtifactFenced(
	ctx: CanonicalArtifactProjectionContext,
	expectedPlacement: ExpectedArtifactPlacement,
	canonicalPath: string,
): void {
	const db = ctx.runDb.connection;
	try {
		beginImmediate(db);
	} catch (error) {
		throw new PersistenceFailureError(
			"canonical projection: BEGIN IMMEDIATE failed",
			{
				operation: "state_commit",
				cause: error,
				...stateOperationErrorOptions(ctx),
			},
		);
	}
	// Capture the lease clock only after acquiring the transaction lock.
	const nowEpochMs = defaultClock.nowEpochMs();
	try {
		const verification = verifyLiveOwnershipInTransaction(
			db,
			ctx.handle,
			nowEpochMs,
		);
		if (verification.kind !== "LIVE") {
			rollback(db);
			throw new AuthorityLostError(
				`Canonical projection rejected: ${verification.kind === "EXPIRED_HANDLE" ? "lease expired" : "ownership not live"}`,
				{
					operation: "state_commit",
					reason:
						verification.kind === "RETIRING"
							? "STALE_HANDLE"
							: verification.kind,
					...stateOperationErrorOptions(ctx),
				},
			);
		}
		const stateRow = db
			.prepare(`SELECT state_json, state_revision
				 FROM run_state WHERE singleton = 1`)
			.get() as
			| {
					state_json: string;
					state_revision: number | bigint;
			  }
			| undefined;
		if (stateRow === undefined) {
			rollback(db);
			throw new PersistenceFailureError(
				"canonical projection: state row missing",
				{
					operation: "state_commit",
					...stateOperationErrorOptions(ctx),
				},
			);
		}
		let parsedState: Record<string, unknown>;
		try {
			parsedState = JSON.parse(stateRow.state_json) as Record<string, unknown>;
		} catch (error) {
			rollback(db);
			throw new PersistenceFailureError(
				"canonical projection: state_json is not valid JSON",
				{
					operation: "state_commit",
					cause: error,
					...stateOperationErrorOptions(ctx),
				},
			);
		}
		const segments = expectedPlacement.pointer
			.split("/")
			.filter((segment) => segment.length > 0);
		let current: unknown = parsedState;
		for (const segment of segments) {
			if (
				typeof current !== "object" ||
				current === null ||
				Array.isArray(current)
			) {
				rollback(db);
				throw new PersistenceFailureError(
					`canonical projection: cannot navigate pointer ${expectedPlacement.pointer} at segment ${segment}`,
					{
						operation: "state_commit",
						...stateOperationErrorOptions(ctx),
					},
				);
			}
			current = (current as Record<string, unknown>)[segment];
		}
		if (!isArtifactRefEqual(current, expectedPlacement.artifact)) {
			rollback(db);
			throw new AuthorityLostError(
				"Canonical projection rejected: state no longer references this artifact",
				{
					operation: "state_commit",
					reason: "STALE_HANDLE",
					...stateOperationErrorOptions(ctx),
				},
			);
		}
		const bytes = readAndVerifyArtifact(ctx.runDir, expectedPlacement.artifact);
		const parentDir = path.dirname(canonicalPath);
		ensureDirectoryPathWithoutSymlinks(parentDir, ctx.runDir);
		const temporaryPath = `${canonicalPath}.tmp-${process.pid}`;
		fs.writeFileSync(temporaryPath, bytes);
		fs.renameSync(temporaryPath, canonicalPath);
		commit(db);
	} catch (error) {
		rollback(db);
		if (
			error instanceof AuthorityLostError ||
			error instanceof ArtifactIntegrityError ||
			error instanceof PersistenceFailureError
		) {
			throw error;
		}
		throw new PersistenceFailureError(
			`canonical projection failed: ${error instanceof Error ? error.message : String(error)}`,
			{
				operation: "state_commit",
				cause: error,
				...stateOperationErrorOptions(ctx),
			},
		);
	}
}

function isArtifactRefEqual(value: unknown, expected: ArtifactRef): boolean {
	if (typeof value !== "object" || value === null) return false;
	const reference = value as Record<string, unknown>;
	return (
		reference.kind === expected.kind &&
		reference.digestAlgorithm === expected.digestAlgorithm &&
		reference.digest === expected.digest &&
		reference.relativePath === expected.relativePath &&
		reference.mediaType === expected.mediaType &&
		reference.sizeBytes === expected.sizeBytes
	);
}
