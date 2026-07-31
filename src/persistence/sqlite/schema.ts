// SQLite schema — authoritative tables for run incarnation, ownership, and
// state.  All mutations happen inside transactions fenced by the owner's
// fence token.
//
// Schema version history:
//   1 — initial (TL-F-001 fix)

export const CURRENT_SCHEMA_VERSION = 1;

// DDL is executed inside a single transaction at database creation.
export const SCHEMA_DDL = `
CREATE TABLE IF NOT EXISTS schema_metadata (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    schema_version INTEGER NOT NULL
);

-- Placeholder — tables will be added in Lot 1 (incarnation, ownership, state).
`;
