// ⚠️ UNSAFE — DO NOT IMPORT IN PRODUCTION CODE ⚠️
//
// This module provides the legacy blind INSERT OR IGNORE primitive for test
// fixtures that predate the fenced initialization protocol
// (initializeStateUnderFence).  It writes fake metadata (empty owner_token,
// fence_token = 0) and performs NO lease check.
//
// Production code MUST use initializeStateUnderFence instead.

import { createHash } from "node:crypto";
import type { SqliteConnection } from "../../src/persistence/sqlite/sqlite-driver";

function computeDigest(jsonStr: string): string {
	return `sha256:${createHash("sha256").update(jsonStr).digest("hex")}`;
}

const ENSURE_STATE_ROW_SQL = `
INSERT OR IGNORE INTO run_state
    (singleton, incarnation_id, state_schema_version,
     state_json, state_digest,
     committed_by_owner_token, committed_by_fence_token,
     committed_at_epoch_ms, committed_at_iso)
VALUES (1, :incarnation_id, :schema_version,
        :state_json, :state_digest,
        '', 0,
        :now_epoch, :now_iso)
`;

/**
 * ⚠️ Blind INSERT OR IGNORE — does NOT fence on the current ownership lease.
 *
 * Writes fake metadata (empty owner_token, fence_token = 0).  Only for test
 * fixtures that need to bypass fencing (e.g. legacy migration simulation,
 * crash-recovery setup).
 *
 * @deprecated Use the fenced {@link initializeStateUnderFence} in production
 *             code.  This helper exists ONLY in tests/helpers/.
 */
export function unsafeEnsureInitialStateRow(
	db: SqliteConnection,
	incarnationId: string,
	schemaVersion: number,
	initialJson: string,
	nowEpochMs: number,
	nowIso: string,
): void {
	const digest = computeDigest(initialJson);
	db.prepare(ENSURE_STATE_ROW_SQL).run({
		":incarnation_id": incarnationId,
		":schema_version": schemaVersion,
		":state_json": initialJson,
		":state_digest": digest,
		":now_epoch": nowEpochMs,
		":now_iso": nowIso,
	});
}
