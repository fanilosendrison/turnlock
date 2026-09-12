---
okf_version: "1.0"
kind: "RuntimeArtifact"
format: "markdown-adr"
title: "Separate Run Authority from Shared Resource Safety"
status: accepted
workspace: "turnlock"
date: "2026-09-12"
supersedes: "None"
author: "turnlock maintainers"
tags:
  - architecture
  - multi-run
  - filesystem
  - external-effects
---

# ADR-0003 — Separate Run Authority from Shared Resource Safety

## Context

Turnlock isolates durable workflow authority by run. A run owns its persisted
state, ownership record, fencing transitions, artifacts, events, and `RUN_DIR`.
ADR-0002 also makes independent runs explicitly concurrent-capable when the
consumer launches them in distinct operating-system processes.

Those guarantees do not imply isolation of the resources that workflow phases or
consumers mutate outside Turnlock's run-local authority.

Two correctly isolated runs may still target the same:

- working tree or workspace;
- file or directory;
- Git index;
- Git repository or ref;
- remote branch;
- database row or transaction domain;
- deployment target;
- API resource;
- or any other mutable external resource.

A run can therefore remain perfectly consistent from Turnlock's point of view
while concurrent external mutations produce an incorrect business result.

The required distinction is:

```text
multi-run state-safe
!=
shared-resource mutation-safe
```

Turnlock already treats External Requests as opaque transport. Core persists the
request and accepted resolution but does not execute, retry, reconcile,
compensate, or interpret the external business effect. Shared-resource safety
must preserve the same authority boundary rather than turning run ownership into
an implicit general-purpose resource lock.

## Decision

Turnlock run ownership authorizes mutation of **Turnlock-managed run authority
only**.

It does not authorize, serialize, lease, fence, or otherwise coordinate mutation
of an external mutable resource.

The following identities and authorities are distinct:

```text
run ownership      != resource ownership
run fencing        != resource fencing
run-state safety   != external-effect safety
```

Losing Turnlock run ownership prevents a stale process from performing a later
authoritative Turnlock state transition. It does not revoke operating-system,
Git, network, database, or service capabilities that process may already hold.
A stale process may therefore still be capable of producing an external effect
unless the external resource domain supplies its own authority mechanism.

### Turnlock Core responsibility

Turnlock Core owns only the guarantees within the run boundary, including:

- run-local durable state and recovery;
- execution ownership and fencing for that run;
- run-local artifacts, manifests, events, and accepted resolutions;
- durable workflow transitions and yield/resume semantics;
- opaque transport of delegation and External Request data.

Turnlock Core MUST NOT:

- infer resource identity from `cwd`, request payloads, Git metadata, paths, or
  other domain-specific data;
- automatically lock a workspace, repository, index, ref, file, or arbitrary
  external object;
- interpret a Turnlock ownership token or fence as authority over an external
  resource;
- claim that concurrent runs are safe to mutate a shared resource merely because
  their run-local state is isolated;
- treat `requestExternal()` as exactly-once execution, resource locking, or
  external-effect fencing.

Core MAY durably transport an opaque request whose consumer-defined meaning is
"acquire resource", "release resource", "perform fenced mutation", or similar.
The semantics, validity, lifetime, and enforcement of that resource authority
remain outside Turnlock Core.

### Consumer/runtime responsibility

The surrounding consumer or runtime owns the physical execution context in
which a Turnlock process runs. Depending on the integration, that includes:

- selecting the working directory, workspace, sandbox, or worktree;
- launching the process with the intended environment and credentials;
- carrying any external lease, capability, fencing token, or resource-manager
  context required by the domain;
- relaunching a resumed run into a context that still satisfies the domain's
  resource-safety preconditions.

The consumer MUST NOT infer that a resumable Turnlock run still owns an external
resource merely because the run remains nonterminal or resumable.

### Domain orchestrator responsibility

The domain orchestrator owns knowledge of which external resources a workflow
needs and which operations conflict. It is responsible for defining the
appropriate concurrency policy, including when resources are:

- disjoint by construction;
- safe for concurrent mutation by the resource's own semantics; or
- required to use explicit external coordination.

For Git workflows, domain policy is responsible for understanding distinctions
such as working-tree files, per-worktree indexes, repository-wide refs, remotes,
and higher-level integration rules. Turnlock does not encode those Git-specific
conflict semantics.

### External resource-management responsibility

When external coordination is required, the resource-owning system must provide
and enforce the relevant mechanism. Depending on the domain, that may include:

- isolated workspaces or Git worktrees;
- leases;
- resource-specific fencing tokens;
- compare-and-swap or optimistic concurrency checks;
- transactions;
- native file or database locks;
- branch/ref protections;
- remote preconditions;
- or another domain-specific serialization mechanism.

The resource manager may be implemented by the consumer, the domain
orchestrator, a dedicated service, or another component. These are logical
responsibilities, not a requirement for separate processes or products.

### Safety rule for concurrent runs

Concurrent Turnlock runs may mutate external resources safely only when at least
one of the following is established outside Turnlock Core:

1. the mutations target resources that are disjoint by construction;
2. the resource's own semantics make the concurrent mutations safe; or
3. an external coordination mechanism establishes and enforces the required
   authority and ordering.

Turnlock Core neither proves nor supplies those conditions.

### Yield and process-lifetime implications

Turnlock may durably yield and exit, then resume the same run in a later process
invocation. Therefore, any external-resource protection that must survive a
Turnlock yield MUST NOT depend solely on a process-scoped mutex, open file
descriptor, or other authority that disappears with the yielding process.

Such protection must instead be durable in the resource domain, or be safely
reacquired and revalidated before the next protected mutation.

## Failure modes outside the Turnlock run boundary

Without appropriate external isolation or coordination, independently valid
Turnlock runs can cause failures including:

- lost or overwritten file updates;
- mixed edits in one working tree;
- staging the wrong changes into a shared Git index;
- creating a commit containing another run's mutations;
- racing repository ref updates;
- acting on stale ref or remote state;
- rejected or semantically stale pushes;
- duplicate non-idempotent external effects;
- mutation by a process that has already lost Turnlock run ownership;
- successful Turnlock terminalization whose external business result is
  nevertheless incorrect.

Accordingly:

```text
Turnlock state correctness
!=
external business-effect correctness
```

## Alternatives Considered

- **Make Turnlock Core a general-purpose resource-lock manager.** Rejected
  because Core cannot know the conflict semantics, identity, lifetime, or
  fencing requirements of arbitrary files, Git resources, databases, APIs, or
  deployment targets. Encoding them would expand Core beyond durable workflow
  authority into domain-specific resource management.

- **Automatically lock the current workspace, repository, or `cwd`.** Rejected
  because physical paths are not a reliable universal resource identity, a
  repository contains several resources with different concurrency semantics,
  and many workflows legitimately operate on disjoint resources under one
  directory.

- **Treat the Turnlock run fence as an external-resource fence.** Rejected
  because the Turnlock fence is enforced only by Turnlock's own authoritative
  persistence transitions. External systems do not observe or enforce it, and
  stale processes may retain external capabilities after losing run ownership.

- **Serialize all runs globally or per coding-agent session.** Rejected because
  it would destroy valid independent concurrency, conflate session identity with
  resource authority, and still fail to model resources shared across sessions
  or hosts.

- **Treat External Requests as exactly-once external effects.** Rejected because
  External Requests durably identify requests and pin accepted resolution bytes;
  they deliberately do not execute, deduplicate, reconcile, or fence the
  external effect itself.

## Consequences

### Pros

- Turnlock's authority boundary stays precise and host-agnostic.
- Multi-run concurrency does not silently acquire a false workspace-safety
  guarantee.
- Git-specific and other domain-specific coordination can use mechanisms that
  actually understand and enforce the relevant resources.
- Run fencing remains meaningful because it is not overloaded with unenforceable
  external semantics.
- Future parent/child run composition can rely on the same separation between
  workflow correctness and resource coordination.

### Cons

- Consumers and domain orchestrators must explicitly establish external-resource
  safety when workflows can conflict.
- A Turnlock run reaching `DONE` is not, by itself, proof that every external
  business effect was correctly serialized or reconciled.
- Integrations that require durable resource ownership across Turnlock yields
  need a resource manager whose authority outlives an individual Turnlock
  process invocation.

## References

- [Turnlock Issue #7 — Define shared workspace and resource safety boundaries](https://github.com/fanilosendrison/turnlock/issues/7)
- [ADR-0002 — Bind Each Process Invocation to One Run](0002-process-invocation-run-boundary.md)
- [Shared resource safety boundary](../architecture/resource-safety-boundary.md)
