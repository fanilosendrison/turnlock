export const COMMIT_STATE_SQL = `
UPDATE run_state
SET
    state_revision = state_revision + 1,
    state_schema_version = :schema_version,
    state_json = :state_json,
    state_digest = :state_digest,
    committed_by_owner_token = :owner_token,
    committed_by_fence_token = :fence_token,
    committed_at_epoch_ms = :now_epoch,
    committed_at_iso = :now_iso
WHERE singleton = 1
  AND incarnation_id = :incarnation_id
  AND state_revision = :expected_revision
  AND EXISTS (
      SELECT 1
      FROM run_ownership
      WHERE run_ownership.singleton = 1
        AND run_ownership.incarnation_id = :incarnation_id
        AND run_ownership.ownership_status = 'HELD'
        AND run_ownership.owner_token = :owner_token
        AND run_ownership.fence_token = :fence_token
        AND run_ownership.lease_until_epoch_ms > :now_epoch
  )
  AND EXISTS (
      SELECT 1
      FROM run_workflow_lifecycle
      WHERE run_workflow_lifecycle.singleton = 1
        AND run_workflow_lifecycle.incarnation_id = :incarnation_id
        AND run_workflow_lifecycle.lifecycle_status = 'NONTERMINAL'
  )
RETURNING
    state_revision,
    state_json,
    state_digest,
    committed_by_fence_token
`;

export const READ_STATE_SQL = `
SELECT
    rs.state_schema_version,
    rs.state_json,
    rs.state_digest,
    rs.state_revision,
    rs.committed_by_fence_token,
    ri.run_id,
    ri.orchestrator_name,
    ri.incarnation_id,
    ri.created_at_iso AS started_at,
    ri.created_at_epoch_ms AS started_at_epoch_ms
FROM run_state rs
JOIN run_incarnation ri ON ri.incarnation_id = rs.incarnation_id
WHERE rs.singleton = 1
`;

export const READ_RAW_STATE_JSON_SQL = `
SELECT state_json
FROM run_state
WHERE singleton = 1
`;

export const INITIALIZE_STATE_SQL = `
INSERT INTO run_state (
    singleton,
    incarnation_id,
    state_revision,
    state_schema_version,
    state_json,
    state_digest,
    committed_by_owner_token,
    committed_by_fence_token,
    committed_at_epoch_ms,
    committed_at_iso
)
SELECT
    1,
    :incarnation_id,
    0,
    :schema_version,
    :state_json,
    :state_digest,
    :owner_token,
    :fence_token,
    :now_epoch,
    :now_iso
WHERE EXISTS (
    SELECT 1
    FROM run_ownership
    WHERE singleton = 1
      AND incarnation_id = :incarnation_id
      AND ownership_status = 'HELD'
      AND owner_token = :owner_token
      AND fence_token = :fence_token
      AND lease_until_epoch_ms > :now_epoch
)
  AND EXISTS (
      SELECT 1
      FROM run_workflow_lifecycle
      WHERE run_workflow_lifecycle.singleton = 1
        AND run_workflow_lifecycle.incarnation_id = :incarnation_id
        AND run_workflow_lifecycle.lifecycle_status = 'NONTERMINAL'
  )
  AND NOT EXISTS (
    SELECT 1 FROM run_state WHERE singleton = 1
  )
RETURNING
    state_revision,
    state_json,
    state_digest,
    committed_by_fence_token
`;
