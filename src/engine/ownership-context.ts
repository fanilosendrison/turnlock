import {
	AuthorityLostError,
	PersistenceFailureError,
} from "../errors/concrete.js";
import {
	type LockHandle,
	refreshOwnership,
	releaseOwnership,
} from "../persistence/sqlite/ownership.js";
import { clock as defaultClock } from "../services/clock.js";
import {
	assertAuthoritativeResultHandled,
	stateOperationErrorOptions,
} from "./authoritative-operation-errors.js";
import type {
	OwnershipContextWithLogger,
	OwnershipMutationContext,
	OwnershipReleaseContext,
} from "./state-commit-contracts.js";

/** Refresh the ownership lease and update the context handle on success. */
export function refreshOwnershipFromContext(
	ctx: OwnershipMutationContext,
): LockHandle {
	const now = defaultClock.nowEpochMs();
	const result = refreshOwnership({
		db: ctx.runDb.connection,
		handle: ctx.handle,
		nowEpochMs: now,
		leaseDurationMs: 30 * 60 * 1000,
		leaseClockEpochMs: () => defaultClock.nowEpochMs(),
	});
	switch (result.kind) {
		case "SUCCESS": {
			ctx.handle = result.handle;
			return result.handle;
		}
		case "STALE_HANDLE":
			throw new AuthorityLostError(
				"Ownership refresh rejected because the handle is stale",
				{
					operation: "refresh",
					reason: "STALE_HANDLE",
					...stateOperationErrorOptions(ctx),
				},
			);
		case "EXPIRED_HANDLE":
			throw new AuthorityLostError(
				"Ownership refresh rejected because the lease expired",
				{
					operation: "refresh",
					reason: "EXPIRED_HANDLE",
					...stateOperationErrorOptions(ctx),
				},
			);
		case "DB_FAILURE":
			throw new PersistenceFailureError("SQLite ownership refresh failed", {
				operation: "refresh",
				cause: result.cause,
				...stateOperationErrorOptions(ctx),
			});
		default:
			return assertAuthoritativeResultHandled(result);
	}
}

/** Release ownership strictly. Signal handlers must use the best-effort form. */
export function releaseOwnershipFromContext(
	ctx: OwnershipReleaseContext,
): void {
	const result = releaseOwnership({
		db: ctx.runDb.connection,
		handle: ctx.handle,
	});
	switch (result.kind) {
		case "SUCCESS":
			return;
		case "STALE_HANDLE":
			throw new AuthorityLostError(
				"Ownership release rejected because the handle is stale",
				{
					operation: "release",
					reason: "STALE_HANDLE",
					...stateOperationErrorOptions(ctx),
				},
			);
		case "EXPIRED_HANDLE":
			throw new AuthorityLostError(
				"Ownership release rejected because the lease expired",
				{
					operation: "release",
					reason: "EXPIRED_HANDLE",
					...stateOperationErrorOptions(ctx),
				},
			);
		case "DB_FAILURE":
			throw new PersistenceFailureError("SQLite ownership release failed", {
				operation: "release",
				cause: result.cause,
				...stateOperationErrorOptions(ctx),
			});
		default:
			assertAuthoritativeResultHandled(result);
	}
}

/** Release ownership on a best-effort basis. Never throws. */
export function releaseOwnershipBestEffort(
	ctx: OwnershipContextWithLogger,
): void {
	try {
		const result = releaseOwnership({
			db: ctx.runDb.connection,
			handle: ctx.handle,
		});
		if (result.kind !== "SUCCESS") {
			try {
				ctx.logger.emit({
					eventType: "ownership_release_failed",
					runId: ctx.runId,
					reason: result.kind,
					timestamp: defaultClock.nowWallIso(),
				});
			} catch {
				// Logger emission is best-effort during cleanup.
			}
		}
	} catch {
		// Cleanup is best-effort and never propagates from signal handlers.
	}
}
