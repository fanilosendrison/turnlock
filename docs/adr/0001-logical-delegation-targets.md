# ADR-0001 — Separate Logical Delegation Targets from Runtime Execution

- **Status:** accepted
- **Date:** 2026-09-03
- **Deciders:** turnlock maintainers
- **Affected:** `src/types/delegation.ts`, `src/bindings/*`, delegation manifests (MANIFEST_VERSION 3), `delegation_emit` events, retry/re-emission paths, public API, README, `docs/architecture/delegation-model.md`

## Context

Turnlock historically evolved from semantic delegation kinds such as
`skill` / `agent` / `agent-batch` toward the better `prompt | batch` shape
taxonomy (see commit `c071836`, July 2026). The current public API still
contains:

```ts
worker?: string
```

which leaves an ambiguity:

- a worker can be named;
- if it is absent, the logical destination is not explicitly defined;
- consumers can also interpret a worker as different physical execution
  mechanisms (child agent session, direct LLM call, subprocess, service).

This ambiguity conflicts with Turnlock's goal of explicit orchestration:
every delegation should state *what shape* of work it is, *who logically
owns* that work, and leave *how* that logical owner is physically executed
to the surrounding runtime.

## Decision

Turnlock owns:

- workflow topology
- delegation timing
- delegation shape (`prompt | batch`)
- logical target (`host | worker(name)`)
- result contract
- persistence
- retry/resume semantics

Consumers/runtimes own:

- worker registry
- worker-to-provider resolution
- model selection
- session selection
- provider configuration
- credentials
- physical execution mechanism

The logical target is:

```ts
export type DelegationTarget =
  | { readonly kind: "host" }
  | { readonly kind: "worker"; readonly name: string };
```

`target` is **mandatory** on every delegation request. There is no implicit
default logical destination. The legacy `worker?: string` field is removed
from the public request API.

### Meaning of host

`host` means the principal semantic actor of the host/harness that launched
the workflow, operating in the relevant current host context (conversation
history, project context, tools). It is not merely a worker named `"host"`.

### Meaning of worker

`worker(name)` identifies a logical execution capability. It does **not**
imply:

- subprocess
- child agent
- direct LLM API
- Pi session
- particular model
- particular provider

A consumer runtime may resolve `worker("reviewer")` to a Pi child session,
another may resolve it to a direct model call, a remote service, or
anything else. Turnlock core never encodes that resolution.

## Rejected alternatives

### Rejected: `target = host | worker | direct`

`direct` describes a physical execution mechanism rather than a logical
destination. Encoding it would couple Turnlock core to consumer
implementation details.

### Rejected: `worker?: string` (status quo)

An omitted worker leaves the destination semantic implicit. Two different
delegations with identical bytes could mean "host" in one consumer and
"some default worker" in another. Explicit orchestration requires explicit
targets.

### Rejected: physical execution fields inside Turnlock

For example `executionClass`, `provider`, `agentSession`, `modelCall`,
`pi-subagents`, `llm-runtime`. These would couple Turnlock to consumer
implementation and break host-agnosticism.

### Rejected: encoding host/worker into delegation kind

`prompt | batch` describes work shape. Logical target is an orthogonal
axis. Folding the two axes together would multiply the taxonomy
(`host-prompt`, `worker-prompt`, …) without adding information and would
re-introduce the kind explosion this project already removed once.

## Consequences

### Positive

- Every delegation carries an explicit, inspectable logical destination.
- Consumers get a clean seam: read `target`, resolve it in the runtime,
  execute by any mechanism.
- Observability records the logical target on every emission and
  re-emission, without leaking physical runtime details.

### Negative / costs

- Breaking change for all existing orchestrators: every `io.delegate` /
  `io.delegateBatch` call site must add a `target`.
- Manifest schema change: `MANIFEST_VERSION` bumps 2 → 3.

## Migration implications

- **`PROTOCOL_VERSION` stays 3.** The stdout protocol block already points
  to a delegation manifest; the runtime reads the manifest to discover the
  target. The wire contract does not change incompatibly.
- **`STATE_SCHEMA_VERSION` stays 4.** The state schema does not embed
  worker/target directly; it stores the immutable manifest artifact
  reference. No state shape change is required.
- **New manifests are v3 and always carry `target`.** There is no
  newly-written manifest whose destination depends on field absence.
- **Legacy v2 manifests with `worker` present** migrate deterministically
  on re-emission: `worker: "reviewer"` becomes
  `target: { "kind": "worker", "name": "reviewer" }`. The historical name
  is preserved byte-for-byte (v2 imposed no naming constraints; migration
  does not retroactively reject what v2 accepted).
- **Legacy v2 manifests without `worker` are never guessed to mean
  `host`.** If Turnlock only needs to consume already-written result
  files, resume completes without resolving the historical target. If the
  delegation must be retried/re-emitted/re-executed, the logical target is
  ambiguous and Turnlock fails closed with
  `ambiguous_legacy_delegation_target` rather than inventing a destination.
- **Worker name validation** (fail-closed, see
  `docs/architecture/delegation-model.md`) applies to new input only:
  non-empty, `^[a-z][a-z0-9-]*$`, at most `MAX_WORKER_NAME_LENGTH`
  characters.
- Package identity: this is the third breaking contract batch since the
  last published release (`v0.9.1`); the package version is bumped to
  `0.11.0` so that two materially different persistence/public-API
  contracts cannot masquerade under one released identity (see Phase 16 of
  the migration notes and `backlog.md`).
