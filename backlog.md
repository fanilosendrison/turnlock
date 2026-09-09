# Backlog

Items triaged by loop-clean. Resolved items archived in `backlog.archive.md`.

## Open items

### [architecture] Specify the multi-run composition model

Turnlock can already host structurally independent runs, but no normative model
specifies how those runs compose. A specification and ADR are required before
implementing parent/child run composition.

The model must preserve these boundaries:

```text
Session
≠ Turnlock authority unit

Run
= durable state, ownership, and recovery unit

Process
= one run invocation

A session MAY contain multiple concurrent runs.
```

The decision must distinguish at least these two relationships:

1. **Explicit child run:** a parent durably requests a child, knows the child's
   identity, depends on its result or terminal state, and resumes according to
   a defined join rule.
2. **Encapsulated nested run:** a parent delegates to a worker or subagent, that
   worker uses Turnlock internally, and the parent depends only on the
   delegation result. The nested run need not become an explicit child in the
   parent's workflow.

The specification must define the semantics of `rootRunId`, `parentRunId`,
provenance, child identity, spawn identity, and joins. It must also state which
relationships are authoritative workflow state and which are observational
metadata only. The design must build composition above the process-per-run
substrate rather than making `runOrchestrator()` a multi-run worker pool,
global scheduler, or general-purpose DAG engine.

### [test gap] Prove distinct runs can execute concurrently end to end

Current concurrency coverage primarily proves authority exclusion among
contenders for the same `runId`. It does not explicitly prove the inverse
contract:

```text
same orchestrator
same runDirRoot
different runIds
→ concurrent execution is isolated and valid
```

Add a process-level E2E test that launches several complete
`runOrchestrator()` invocations, such as four or eight real subprocesses, with
distinct run IDs under the same orchestrator and run-directory root.

The test must prove that:

- every run progresses normally;
- no run receives an inter-run `run_locked` result;
- every run has a distinct `RUN_DIR` and SQLite authority;
- authoritative state does not cross run boundaries;
- artifacts and events do not cross run boundaries;
- cleanup or retirement does not target another run incorrectly; and
- process output and protocol blocks remain correlated with the correct
  `runId`.

Coverage limited to SQLite primitives is insufficient; the proof must exercise
complete orchestrator executions through real process boundaries.

### [architecture] Define durable child-spawn identity and idempotence

Explicit parent-to-child composition requires a durable logical spawn identity.
A crash and retry after a parent requests a child must not create two logically
different children for the same request:

```text
Parent requests Child
Runner crashes
spawn is retried

logical spawn identity
→ stable child identity
→ retry attaches to or resumes the same child
```

The design must study:

- the semantics and scope of a `spawnId`;
- when child identity becomes durable;
- the durable mapping from a spawn to `childRunId`;
- idempotent child creation;
- concurrent retries of the same spawn; and
- retry behavior when the child already exists but is suspended, terminal, or
  retiring.

This item concerns spawn semantics, not database-schema creation. Concurrent,
atomic SQLite cold start is already resolved and must not be reopened as part
of this work.

### [architecture] Define durable join semantics for explicit child runs

A parent with explicit children must be able to suspend durably until a defined
condition is satisfied, then resume without losing or duplicating the join
outcome.

Potential future policies include:

```text
ALL
ANY
FAIL_FAST
COLLECT_ALL
QUORUM
```

The initial design should identify the smallest sufficient primitive and may be
limited to spawning one child, awaiting its terminal result, and resuming the
parent. Fan-out and broader join policies can be added only when their required
semantics are understood. The design must not prematurely turn Turnlock Core
into a general-purpose DAG engine.

### [architecture] Define shared workspace and resource safety boundaries

Turnlock isolates run state, ownership, artifacts, and `RUN_DIR`, but this does
not isolate external business effects. Two independently authoritative runs can
still mutate the same repository file, Git index, workspace, or other shared
resource concurrently.

Expected invariant:

```text
multi-run state-safe
does not imply
shared-workspace mutation-safe
```

An architectural decision must define responsibility boundaries for workspaces,
worktrees, repositories, Git indexes, files, and other shared resources. It
must determine which guarantees belong to Turnlock Core, the runner or
consumer, the domain orchestrator, or an external worktree/lease system. The
decision must not assume without analysis that Turnlock Core should become a
general resource-lock manager.

### [spec] Formalize the process-per-run and many-runs-per-session contract

The existing implementation follows a process-per-run model, but that model is
not yet explicit enough as a normative architectural contract. Create a spec or
ADR that establishes:

```text
A Turnlock process executes one run invocation.

Independent runs MAY execute concurrently
in distinct operating-system processes.

A coding-agent session MAY contain multiple Turnlock runs.

Turnlock Core does not multiplex several runs inside one process.

The runtime or consumer is responsible for launching and routing processes.

Turnlock ownership is scoped to one run.
```

The contract must also make these distinctions explicit:

```text
session
≠ lock scope

agent
≠ run

process
≠ session

run
= durable authority and recovery unit
```

This specification must preserve `one process per run, many runs per session`.
It must not redefine `runOrchestrator()` as an in-process multi-run scheduler,
worker pool, or general-purpose workflow engine.
