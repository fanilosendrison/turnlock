// SQLite schema — authoritative tables for run incarnation, ownership,
// retention eligibility, and state.  All mutations happen inside
// transactions fenced by the owner's fence token (or by the retention
// retirement claim).
//
// Schema version history:
//   1 — initial (TL-F-001 fix)
//   2 — added run_retention: durable, irreversible retirement claim that
//       serializes retention deletion against ownership acquisition.
export const CURRENT_SCHEMA_VERSION = 2;
// DDL is idempotent (CREATE TABLE IF NOT EXISTS) and executed at every
// database open.  The schema_metadata version check/migration itself runs
// inside a dedicated BEGIN IMMEDIATE ... COMMIT transaction in
// `run-database.ts` (v1 → v2 migration).  The atomicity of the very first
// concurrent schema initialization on a nonexistent database is tracked
// separately in the backlog (atomic cold-start schema init).
export const SCHEMA_DDL = `
CREATE TABLE IF NOT EXISTS schema_metadata (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    schema_version INTEGER NOT NULL
);

-- Exactly one row per run.  incarnationId is immutable once created.
CREATE TABLE IF NOT EXISTS run_incarnation (
    singleton     INTEGER PRIMARY KEY CHECK (singleton = 1),
    run_id        TEXT    NOT NULL,
    incarnation_id TEXT   NOT NULL UNIQUE,
    orchestrator_name TEXT NOT NULL,
    created_at_epoch_ms INTEGER NOT NULL,
    created_at_iso      TEXT    NOT NULL
);

-- Exactly one row per run.  Ownership state machine: FREE ↔ HELD.
-- The fence_token is monotonic and never decremented or reused.
CREATE TABLE IF NOT EXISTS run_ownership (
    singleton          INTEGER PRIMARY KEY CHECK (singleton = 1),
    incarnation_id     TEXT    NOT NULL,
    ownership_status   TEXT    NOT NULL
        CHECK (ownership_status IN ('FREE', 'HELD')),
    owner_token        TEXT,
    owner_pid          INTEGER,
    fence_token        INTEGER NOT NULL DEFAULT 0,
    acquired_at_epoch_ms   INTEGER,
    lease_until_epoch_ms   INTEGER,
    FOREIGN KEY (incarnation_id)
        REFERENCES run_incarnation(incarnation_id)
);

-- Exactly one row per run.  Retention eligibility state machine:
-- ACTIVE → RETIRING.  The transition is IRREVERSIBLE: once a retention
-- cleanup has committed RETIRING, no future ownership may ever be
-- acquired for this run and only retention deletion may proceed (the
-- cleanup may crash and a later cleanup resumes the deletion).
-- "run_ownership" answers "who owns the run now?"; "run_retention"
-- answers "is this run still admissible to future ownership?".
CREATE TABLE IF NOT EXISTS run_retention (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    retention_status TEXT NOT NULL
        CHECK (retention_status IN ('ACTIVE', 'RETIRING')),
    retirement_token TEXT,
    retirement_claimed_at_epoch_ms INTEGER
);

-- Exactly one row per run.  The authoritative state snapshot.
-- Every commit CAS on state_revision + fence_token + active lease.
CREATE TABLE IF NOT EXISTS run_state (
    singleton              INTEGER PRIMARY KEY CHECK (singleton = 1),
    incarnation_id         TEXT    NOT NULL,
    state_revision         INTEGER NOT NULL DEFAULT 0,
    state_schema_version   INTEGER NOT NULL,
    state_json             TEXT    NOT NULL,
    state_digest           TEXT    NOT NULL,
    committed_by_owner_token TEXT  NOT NULL,
    committed_by_fence_token INTEGER NOT NULL,
    committed_at_epoch_ms  INTEGER NOT NULL,
    committed_at_iso       TEXT    NOT NULL,
    FOREIGN KEY (incarnation_id)
        REFERENCES run_incarnation(incarnation_id)
);
`;
