export const PROTOCOL_VERSION = 3 as const;
export const STATE_SCHEMA_VERSION = 4 as const;
export const EXTERNAL_REQUEST_MANIFEST_VERSION = 1 as const;

/** Internal SQLite state_json marker; never included in state.json projections. */
export const PENDING_INITIAL_DISPATCH_STATE_FIELD =
	"__turnlockPendingInitialDispatch" as const;

export const MAX_EVENT_FIELD_LENGTH = 200;
export const MAX_EXTERNAL_LABEL_LENGTH = 173;

export const DEFAULT_MAX_ATTEMPTS = 3;
export const DEFAULT_BACKOFF_BASE_MS = 1000;
export const DEFAULT_MAX_BACKOFF_MS = 30_000;
export const DEFAULT_TIMEOUT_MS = 600_000;
export const DEFAULT_RETENTION_DAYS = 7;
export const DEFAULT_IDLE_LEASE_MS = 30 * 60 * 1000;

export const MANIFEST_VERSION = 2 as const;
