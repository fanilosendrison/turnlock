// Pre-filesystem ownership fencing for runtime artifact installation.
//
// A runtime phase installs immutable artifacts through
// `installPreparedArtifact(runDir, ...)`.  That primitive alone cannot
// know whether the caller still owns the run.  A stale runtime whose
// lease expired and whose ownership was fenced by retention could
// otherwise:
//   - recreate the canonical RUN_DIR pathname after the old incarnation
//     was detached (recursive mkdir resurrection), or
//   - install an artifact into a NEW incarnation already occupying the
//     canonical pathname.
//
// `installPreparedArtifactFenced` closes both: the filesystem write runs
// INSIDE a BEGIN IMMEDIATE write transaction on the run-local SQLite
// authority, after the single shared live-ownership predicate confirms
// retention = ACTIVE, ownership = HELD with matching
// incarnation/owner/fence, and a live lease (clock captured AFTER lock
// acquisition).
//
// Serialization with retention cleanup:
//   - artifact write wins the lock → cleanup waits → the artifact becomes
//     part of the OLD incarnation and is later renamed away safely;
//   - cleanup wins the lock → RETIRING/fencing is committed → the stale
//     install sees no authority → NO filesystem write.
//
// A stale/expired/retiring handle therefore never performs filesystem
// artifact installation.
import {
	ArtifactIntegrityError,
	AuthorityLostError,
	PersistenceFailureError,
} from "../errors/concrete.js";
import {
	beginImmediate,
	commit,
	type LockHandle,
	rollback,
	verifyLiveOwnershipInTransaction,
} from "../persistence/sqlite/ownership.js";
import type { RunDatabase } from "../persistence/sqlite/run-database.js";
import { installPreparedArtifact } from "../services/artifact-store.js";
import { clock as defaultClock } from "../services/clock.js";
import type { PreparedArtifact } from "../types/artifacts.js";

export interface FencedArtifactInstallContext {
	readonly runDb: RunDatabase;
	readonly handle: LockHandle;
	readonly runDir: string;
	readonly runId: string;
	readonly config?: {
		readonly name?: string;
	};
	readonly currentPhase?: string | null;
	/** Optional clock captured AFTER BEGIN IMMEDIATE for the lease check. */
	readonly leaseClockEpochMs?: () => number;
}

/** Install a prepared immutable artifact under RUN_DIR, but ONLY if the
 *  caller still holds the single live ownership of the run.
 *
 *  Protocol (all inside BEGIN IMMEDIATE on ctx.runDb):
 *    1. Capture the lease clock AFTER lock acquisition.
 *    2. Verify the shared live-ownership predicate: retention ACTIVE,
 *       ownership HELD, incarnation/owner/fence match, lease live.
 *    3. Stale/expired/retiring → ROLLBACK, throw AuthorityLostError,
 *       NO filesystem mutation.
 *    4. Authoritative → installPreparedArtifact(ctx.runDir, artifact)
 *       (the filesystem write runs inside the DB write transaction),
 *       COMMIT.
 *
 *  Throws:
 *    - AuthorityLostError      on STALE_HANDLE / EXPIRED_HANDLE / RETIRING
 *    - PersistenceFailureError on DB_FAILURE */
export function installPreparedArtifactFenced(
	ctx: FencedArtifactInstallContext,
	preparedArtifact: PreparedArtifact,
): void {
	const db = ctx.runDb.connection;
	try {
		beginImmediate(db);
	} catch (error) {
		throw new PersistenceFailureError(
			"fenced artifact install: BEGIN IMMEDIATE failed",
			{
				operation: "state_commit",
				cause: error,
				runId: ctx.runId,
				...(ctx.config?.name !== undefined
					? { orchestratorName: ctx.config.name }
					: {}),
			},
		);
	}
	// Clock AFTER lock acquisition — the wait for BEGIN IMMEDIATE must not
	// produce a stale lease decision.
	const lockEpochMs = (ctx.leaseClockEpochMs ?? defaultClock.nowEpochMs)();
	try {
		const verification = verifyLiveOwnershipInTransaction(
			db,
			ctx.handle,
			lockEpochMs,
		);
		if (verification.kind !== "LIVE") {
			rollback(db);
			throw new AuthorityLostError(
				`Fenced artifact install rejected: ${
					verification.kind === "EXPIRED_HANDLE"
						? "ownership lease expired"
						: verification.kind === "RETIRING"
							? "run is retired by retention cleanup"
							: "ownership handle is stale"
				}`,
				{
					operation: "state_commit",
					reason:
						verification.kind === "EXPIRED_HANDLE"
							? "EXPIRED_HANDLE"
							: "STALE_HANDLE",
					runId: ctx.runId,
					...(ctx.config?.name !== undefined
						? { orchestratorName: ctx.config.name }
						: {}),
					...(ctx.currentPhase !== null && ctx.currentPhase !== undefined
						? { phase: ctx.currentPhase }
						: {}),
				},
			);
		}
		// The filesystem write happens while the run-DB write transaction
		// is held: a concurrent retention claim (also BEGIN IMMEDIATE on
		// the same database) is linearized against this install.
		installPreparedArtifact(ctx.runDir, preparedArtifact);
		commit(db);
	} catch (error) {
		rollback(db);
		if (
			error instanceof AuthorityLostError ||
			error instanceof ArtifactIntegrityError
		) {
			throw error;
		}
		throw new PersistenceFailureError(
			`fenced artifact install failed: ${error instanceof Error ? error.message : String(error)}`,
			{
				operation: "state_commit",
				cause: error,
				runId: ctx.runId,
				...(ctx.config?.name !== undefined
					? { orchestratorName: ctx.config.name }
					: {}),
			},
		);
	}
}
