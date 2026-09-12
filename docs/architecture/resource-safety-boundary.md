# Shared Resource Safety Boundary

Turnlock isolates durable workflow authority by run. It does **not** make the
workspace or any other external mutable resource exclusive to that run.

The normative decision is recorded in
[ADR-0003](../adr/0003-shared-resource-safety-boundary.md).

## Core invariant

```text
multi-run state-safe
!=
shared-resource mutation-safe

run ownership
!=
resource ownership

run fencing
!=
resource fencing
```

A Turnlock process may hold authoritative ownership of its run while another
independent run holds authoritative ownership of a different run. Both may still
have operating-system or network access to the same external resource.

Turnlock's ownership and fencing mechanisms protect Turnlock-managed run state.
They do not authorize or serialize mutations to files, worktrees, Git refs,
databases, services, deployment targets, or other external resources.

## Responsibility model

| Responsibility | Owner |
| --- | --- |
| Durable run state, recovery, ownership, run fencing, artifacts, manifests, events | Turnlock Core |
| Physical process context, `cwd`, environment, workspace/worktree assignment, carrying external authority | Consumer/runtime |
| Knowing which resources an operation needs, which operations conflict, and what concurrency policy is valid | Domain orchestrator |
| Enforcing isolation, leases, resource fencing, CAS, transactions, locks, or other domain-specific coordination | External resource manager |

These are logical responsibilities. One integration component may implement more
than one of them.

## Concurrent mutation rule

Two runs may safely mutate external resources concurrently only when the
integration establishes at least one of these conditions:

1. the resources are disjoint by construction;
2. the resource's native semantics make the concurrent mutations safe; or
3. an external coordination mechanism establishes and enforces the required
   authority and ordering.

Turnlock Core neither proves nor supplies these conditions.

## Repository and workspace examples

### Working-tree files

Separate Turnlock runs do not receive separate working trees automatically. If
two runs write the same working-tree path, Turnlock does not prevent one write
from overwriting or interleaving with the other.

Use isolated workspaces/worktrees or another filesystem-aware coordination
mechanism when concurrent mutation would conflict.

### Git index

Turnlock does not own or lock a Git index. Two processes operating on the same
worktree/index can stage incompatible sets of changes or cause a commit to
contain mutations from the wrong run.

If a workflow relies on isolated Git authoring, that isolation belongs to the
Git/workspace layer, not to Turnlock run ownership.

### Git refs and remotes

Separate worktrees do not turn repository-wide refs or remote branches into
Turnlock-owned resources. Ref updates and pushes need their own Git-aware
preconditions, CAS/lease semantics, branch protections, or higher-level
coordination as appropriate.

A run fence must never be interpreted as a Git ref fence.

## External Requests do not change this boundary

`requestExternal()` provides a durable workflow yield and preserves the exact
request identity and accepted resolution bytes. It does not perform or fence the
business effect.

An integration may define an opaque External Request such as:

```text
acquire workspace lease
perform fenced push
release resource
```

but Turnlock treats those meanings as consumer-defined payloads. The resource
system remains responsible for validating, granting, renewing, fencing, and
releasing that authority.

Re-publication of an External Request is not an instruction from Turnlock to
repeat the external effect.

## Yield and resume

A Turnlock run can yield, the process can exit, and a later process can resume
the same durable run.

Therefore an external lock that must remain valid across the yield cannot rely
only on process-local state such as a mutex or open file descriptor. The
integration must either:

- use authority that remains durable in the resource domain across process
  lifetimes; or
- safely reacquire and revalidate authority before each protected mutation.

A nonterminal or resumable Turnlock run does not prove that an earlier external
lease is still valid.

## Stale-process boundary

Turnlock fencing protects later authoritative Turnlock state transitions. It
cannot revoke capabilities already held outside Turnlock.

If a process loses run ownership, external systems must independently prevent
that process from making stale protected mutations when such prevention is
required. This normally requires a resource-specific fence, lease generation,
CAS precondition, transaction, or equivalent mechanism enforced by the resource
owner.

## Failure modes when the integration does not coordinate

Turnlock may remain internally correct while the external result is wrong. For
example:

- one run overwrites another run's file update;
- two runs mix edits in one working tree;
- staging crosses run boundaries in a shared index;
- a commit contains another run's changes;
- two operations race a Git ref or act on stale remote state;
- a non-idempotent API mutation is duplicated;
- a stale process mutates an external resource after losing Turnlock ownership;
- a run reaches `DONE` after receiving a syntactically valid external resolution
  even though domain-level serialization was incorrect.

The safety statement is therefore deliberately narrow:

```text
Turnlock state correctness
!=
external business-effect correctness
```
