# SQLite Ownership Migration — Upgrade Guide

## Scope

Migration from the legacy file-lock protocol (`.lock`) to the SQLite
ownership protocol (`turnlock.sqlite3` + fenced CAS acquisition).

This guide covers the **operational procedure** required to migrate a
Turnlock run directory from a legacy binary (v0.9.x and earlier, using
`.lock` file) to a SQLite-capable binary (v0.10.0+).

## Contract

1. **Mixed-version concurrent access is unsupported.**
   The legacy file-lock protocol and the SQLite ownership protocol
   MUST NOT operate concurrently on the same run directory.

2. **Migration requires an exclusive upgrade window** in which every
   legacy Turnlock process is stopped and prevented from restarting.

3. The presence of `.lock` blocks migration **fail-closed**.

4. The **absence** of `.lock` is **not proof** that the upgrade window
   is exclusive. Exclusivity is an operational precondition supplied
   by the deployment, supervisor, operator, or upgrade procedure.

5. After `turnlock.sqlite3` has been established for a run, only
   SQLite-capable Turnlock binaries may access that run directory.

6. **Downgrade** to a legacy binary after SQLite migration is
   **unsupported**.

7. Turnlock **never** automatically deletes, expires, overrides, or
   reinterprets a legacy `.lock` during migration.

## Preconditions

- All legacy Turnlock processes **stopped**.
- Services, cron jobs, agents, and supervisors that could restart a
  legacy Turnlock binary **disabled**.
- No rolling upgrade mixed-version window.
- **Backup** of the affected `RUN_DIR` recommended.

## Procedure

### 1. Stop all legacy processes

Ensure every Turnlock process that uses the legacy `.lock` protocol
on the target run directories is stopped.

### 2. Disable automatic restart

Disable any mechanism that could restart a legacy binary:

- systemd services
- cron jobs
- supervisor daemons
- agent automation (Claude Code skills, Codex jobs, Pi scripts, etc.)

### 3. Verify no legacy process can act

Confirm that no legacy process is running and that none can be
started. Turnlock cannot perform this verification for you.

### 4. Inspect RUN_DIR/.lock

For each run directory being migrated:

```bash
ls -la /path/to/runs/<orchestrator>/<runId>/.lock
```

### 5. Remove .lock

**Only after human confirmation of exclusivity**, remove the legacy
lock file:

```bash
rm /path/to/runs/<orchestrator>/<runId>/.lock
```

Do NOT remove `state.json` or any other file.

### 6. Launch the new binary

Launch the SQLite-capable Turnlock binary with `--resume`:

```bash
node pipeline.js --run-id <runId> --resume
```

### 7. Verify SQLite establishment

Confirm that `turnlock.sqlite3` was created:

```bash
ls -la /path/to/runs/<orchestrator>/<runId>/turnlock.sqlite3
```

### 8. Verify correct resume

Check that the run resumed correctly:
- Output (stdout) contains a valid protocol block
- `state.json` projection matches the authoritative SQLite state
- The workflow continues from the expected phase

### 9. Reactivate automation

Reactivate only **SQLite-compatible** binaries and automation.

## Blocked States

### Ownership storage compatibility guards

The compatibility guard (`assertOwnershipStorageCompatibility`) runs
**before** any SQLite ownership acquisition, DB creation, fence token
increment, state projection, or phase execution.  When it blocks, **no
authoritative mutation occurs** and **no new ownership is granted**.

| State | Error | Description |
|-------|-------|-------------|
| DB absent + `.lock` present | `legacy_lock_migration_blocked` | Migration blocked — legacy lock exists before SQLite establishment |
| DB present + `.lock` present | `mixed_ownership_protocol_detected` | Protocol contract violated — both artifacts coexist after SQLite establishment |

### State-schema migration failure

A `state_migration_blocked` error is a separate concern: it occurs
during v3→v4 manifest conversion.  This failure happens **after**
ownership acquisition in the resume path.  Turnlock releases that
ownership before propagating the error, and no workflow-state
transition is committed.  However, the ownership row itself may have
seen a fence-token increment and release cycle during the attempt.

| State | Error | Description |
|-------|-------|-------------|
| Migration of `state.json` impossible | `state_migration_blocked` | v3→v4 manifest conversion failed |

## Non-Guarantees

```
existsSync(".lock") is a defensive guard, not an atomic inter-version lock.
Turnlock does not support a legacy process starting concurrently with migration.
The deployment is responsible for excluding that situation.
```

The runtime cannot:

- Prevent a legacy process from starting after the check passes
- Verify that all legacy processes have been stopped
- Guarantee atomic exclusion between legacy and SQLite protocols
- Recover from a mixed-state condition automatically

## Downgrade

```
UNSUPPORTED
```

Once `turnlock.sqlite3` has been established for a run directory,
downgrading to a legacy binary is unsupported. The legacy binary
does not understand SQLite ownership and may:

- Create a `.lock` file that coexists with `turnlock.sqlite3`
- Fail to detect the SQLite-based owner
- Produce a mixed-protocol state

The presence of `turnlock.sqlite3` is the durable protocol marker:
`this RUN_DIR belongs to the SQLite protocol` — as long as the run
lives.  Retention cleanup is a separate lifecycle: once a run is
retired, its `turnlock.sqlite3` is deliberately deleted together with
the retired RUN_DIR, and a new incarnation may later create a fresh
`turnlock.sqlite3` at the same canonical pathname.

## Recovery from a residual `.lock`

### Before SQLite establishment

If `.lock` is present before SQLite has been established (i.e. no
`turnlock.sqlite3` exists in the run directory), Turnlock blocks with
`LegacyLockMigrationBlockedError`.

### After SQLite establishment

If `.lock` coexists with an already established `turnlock.sqlite3`,
Turnlock blocks with `MixedOwnershipProtocolError`.  This indicates
a deployment or downgrade contract violation — the run directory
already belongs to the SQLite protocol, and a legacy artifact must
not be present.

### Removal procedure

In either case, the `.lock` must be removed **only after external
confirmation** that no legacy process holds it:

```bash
# Operator verification (external to Turnlock):
# - Check process table for legacy Turnlock binaries
# - Confirm no automation will restart them
# - Only then:
rm /path/to/runs/<orchestrator>/<runId>/.lock
```

Turnlock will never perform this removal automatically.

## Technical details

### Guard implementation

The compatibility check is centralized in `assertOwnershipStorageCompatibility`
(`src/engine/ownership-storage-compatibility.ts`). It is invoked before any
authoritative operation (DB creation, ownership acquisition, fence token
increment, state projection, phase execution) in both `runInitialMode()` and
`runResumeMode()`.

### Why `existsSync`

The guard uses `fs.existsSync(".lock")` — a single `stat` call. This is
deliberately NOT an atomic inter-version lock. It is a best-effort defensive
check that catches the static case (`.lock` already present at migration time).
The dynamic case (legacy process starts after the check) is excluded by the
operational precondition.

### Protocol marker vs retired/deleted run lifecycle

The `turnlock.sqlite3` file (and its `schema_metadata` table) is the
durable marker that a run directory belongs to the SQLite protocol
while that run exists.  Legacy binaries do not understand this marker —
it serves as documentation for operators and new tooling, not as an
active exclusion mechanism.

This marker is about **protocol migration**, not about retention:

- The SQLite → legacy downgrade remains a no-return decision.
- Retention retirement is a different, later lifecycle stage: the
  durable retirement claim (`run_retention` ACTIVE → RETIRING in the
  same database) is the no-return marker for **ownership**.  After the
  claim, the retired RUN_DIR is atomically renamed into the `.retired`
  area of its orchestrator namespace and then deleted; the deleted
  `turnlock.sqlite3` does not undo the downgrade no-return rule, because
  a legacy binary must still never run against a run directory that has
  ever been SQLite-authoritative.
- A NEW incarnation may later occupy the same canonical pathname with a
  fresh `turnlock.sqlite3` — it is a new run, not a migration of the
  retired one.  Retirement tombstoning and protocol migration are
  therefore distinct: the former lives in `run_retention` (deleted with
  the retired incarnation, which is fine because the retired incarnation
  is permanently non-resumable), the latter is a deployment-level rule
  documented here.
