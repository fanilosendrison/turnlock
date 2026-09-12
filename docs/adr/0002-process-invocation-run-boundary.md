---
okf_version: "1.0"
kind: "RuntimeArtifact"
format: "markdown-adr"
title: "Bind Each Process Invocation to One Run"
status: accepted
workspace: "turnlock"
date: "2026-09-12"
step_id: 6
supersedes: "None"
author: "turnlock maintainers"
tags:
  - architecture
  - runtime
  - multi-run
---

# ADR-0002 — Bind Each Process Invocation to One Run

## Context

Turnlock already persists authority, recovery state, ownership, and artifacts per
run identity. Initial execution and resume are process-oriented: a run may yield,
the executing process may exit, and a later process may resume the same durable
run by its `runId`.

The architecture has not previously stated the relationship between operating
system processes, durable runs, coding-agent sessions, and agent identities
explicitly enough.

That ambiguity creates two risks.

First, future multi-run work could evolve `runOrchestrator()` into an
in-process scheduler that owns several independent runs simultaneously, despite
the existing runtime and ownership substrate being organized around one run at a
time.

Second, callers could incorrectly treat a coding-agent session, an agent
identity, or an operating-system process as the authority or locking scope of a
run.

The durable run must remain the unit around which authority and recovery are
defined, while the surrounding consumer runtime remains responsible for
physical process execution and session association.

## Decision

A Turnlock **run is the durable authority and recovery unit**.

Each Turnlock operating-system process invocation MUST be bound to exactly one
run identity.

Turnlock Core MUST NOT multiplex execution of multiple independent runs within
one process invocation. `runOrchestrator()` remains a single-run execution
primitive and MUST NOT become an in-process multi-run scheduler.

Independent runs MAY execute concurrently when the consumer or runtime launches
them in distinct operating-system processes.

A single durable run MAY be executed by multiple successive process invocations
over its lifetime. In particular, an initial invocation may yield and exit, and
a later invocation may resume the same run using the same `runId`.

At any instant, at most one process invocation may hold authoritative ownership
of a given run. Ownership, locking, fencing, persistence, and recovery remain
scoped to that run rather than to an agent session or process lineage.

A coding-agent session MAY contain zero, one, or many Turnlock runs. Session
identity does not define a lock scope, authority scope, or recovery scope.

Agent identity, session identity, process identity, and run identity are
orthogonal concepts:

```text
session != lock scope
agent   != run
process != session

run = durable authority and recovery unit
```

No identity in that set may be inferred solely from another.

The surrounding consumer or runtime owns:

- launching operating-system processes;
- routing a process invocation to an initial or resumed run;
- associating Turnlock runs with coding-agent sessions;
- deciding when independent runs execute concurrently.

Turnlock Core owns execution and durable authority only for the single run bound
to the current process invocation.

This ADR does not define parent-run, child-run, or other run-composition
semantics. Such relationships may be specified separately without changing the
process-to-run boundary defined here.

## Alternatives Considered

- **Treat one operating-system process as the lifetime of one run.** Rejected
  because a durable run may already span multiple successive process invocations
  across yield and resume. Process lifetime is therefore not run lifetime.

- **Allow `runOrchestrator()` to multiplex multiple runs in one process.**
  Rejected because it would make Turnlock Core responsible for process-local
  scheduling and introduce shared lifecycle, signal-handling, and authority
  concerns across otherwise independent runs.

- **Use the coding-agent session as the run or lock scope.** Rejected because a
  session may legitimately contain multiple independent Turnlock runs and is a
  consumer-runtime concept rather than durable Turnlock authority.

- **Use agent identity as run identity.** Rejected because one agent may
  participate in multiple runs, and a run may persist across different physical
  execution contexts. Agent identity therefore cannot define durable run
  authority.

## Consequences

### Pros

- The durable authority boundary is explicit: the run, not the session, agent,
  or process lineage, owns recovery semantics.
- Independent runs can execute concurrently without requiring an in-process
  scheduler in Turnlock Core.
- Existing yield-and-resume behavior remains coherent because one durable run
  may span several successive process invocations.
- `runOrchestrator()` retains a narrow responsibility as a single-run execution
  primitive.
- Future run-composition features can be designed above this boundary without
  conflating composition with process multiplexing.

### Cons

- Consumers that want several runs active concurrently must manage multiple
  operating-system processes rather than relying on Turnlock Core to multiplex
  them.
- Session-to-run association remains a consumer-runtime responsibility and is
  not represented as Turnlock ownership.
- Future composition work must preserve this boundary or explicitly supersede
  this ADR.

## References

- [Turnlock Issue #9 — Formalize the process-per-run and many-runs-per-session contract](https://github.com/fanilosendrison/turnlock/issues/9)
- [ADR-0001 — Separate Logical Delegation Targets from Runtime Execution](0001-logical-delegation-targets.md)
