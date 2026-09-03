export const PROTOCOL_VERSION = 3 as const;
export const STATE_SCHEMA_VERSION = 4 as const;
export const EXTERNAL_REQUEST_MANIFEST_VERSION = 1 as const;
/**
 * Internal SQLite state_json marker; never included in state.json projections.
 *
 * The field name was deliberately changed from the original
 * "__turnlockPendingInitialDispatch" (v0.10.0) so that builds predating the
 * durable-claim protocol (commits 8cca8357..0c4bd3fa) cannot recognise it.
 * Those builds executed the initial phase directly when they saw the old
 * boolean marker, without first consuming a durable claim — a downgrade from
 * a current build to one of those builds would replay the phase.
 *
 * By writing only the new field name, downgrades fail closed: the old binary
 * sees no marker and refuses resume with "no pending delegation".
 */
export const PENDING_INITIAL_DISPATCH_STATE_FIELD =
	"__turnlockInitialDispatchClaimV1" as const;
/**
 * Paired version field for the V1 dispatch-claim marker.
 * Also renamed from the original "__turnlockPendingInitialDispatchVersion".
 */
export const PENDING_INITIAL_DISPATCH_VERSION_STATE_FIELD =
	"__turnlockInitialDispatchClaimV1Version" as const;
export const PENDING_INITIAL_DISPATCH_VERSION = 1 as const;
/**
 * Original field names from v0.10.0 (before the durable-claim protocol).
 * Reads must recognise these for backward compatibility with databases
 * created before the rename.  New writes never use them.
 */
export const LEGACY_PENDING_INITIAL_DISPATCH_STATE_FIELD =
	"__turnlockPendingInitialDispatch" as const;
export const LEGACY_PENDING_INITIAL_DISPATCH_VERSION_STATE_FIELD =
	"__turnlockPendingInitialDispatchVersion" as const;
export const MAX_EVENT_FIELD_LENGTH = 200;
export const MAX_EXTERNAL_LABEL_LENGTH = 173;
/** Maximum length of a logical worker name (mirrors event-field cap). */
export const MAX_WORKER_NAME_LENGTH = 200 as const;
export const DEFAULT_MAX_ATTEMPTS = 3;
export const DEFAULT_BACKOFF_BASE_MS = 1000;
export const DEFAULT_MAX_BACKOFF_MS = 30000;
export const DEFAULT_TIMEOUT_MS = 600000;
export const DEFAULT_RETENTION_DAYS = 7;
export const DEFAULT_IDLE_LEASE_MS = 30 * 60 * 1000;
export const MANIFEST_VERSION = 3 as const;
/** Filename of the per-run SQLite authority, one per RUN_DIR. */
export const RUN_DB_FILENAME = "turnlock.sqlite3" as const;
