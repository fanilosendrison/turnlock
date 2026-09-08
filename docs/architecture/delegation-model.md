# Delegation model (current architecture)

> Why these boundaries exist: see [ADR-0001](../adr/0001-logical-delegation-targets.md).

Turnlock separates three orthogonal axes of delegation:

| Axis               | Meaning                               | Examples                            |
| ------------------ | ------------------------------------- | ----------------------------------- |
| Delegation shape   | structure of semantic work            | `prompt`, `batch`                   |
| Logical target     | who logically owns the semantic work  | `host`, `worker("reviewer")`        |
| Physical execution | how this runtime satisfies the target | Pi child, LLM API, service, process |

## The contract in one picture

```text
TURNLOCK
─────────────────────────────

kind
= shape of delegation
= prompt | batch

target
= logical destination
= host | worker(name)

              ↓

RUNTIME / CONSUMER
─────────────────────────────

resolves target

              ↓

physical execution
= model-call
= agent-session
= service
= process
= anything else
```

Turnlock specifies the logical destination of semantic work; the
surrounding runtime resolves that destination to a physical execution
mechanism. Turnlock core must not know or encode that physical
implementation.

## Invariants

```text
worker != subagent
worker != LLM API
worker != process
worker = named logical execution capability
```

Physical execution vocabulary (`direct`, `agent-session`, `model-call`,
`pi-subagents`, `llm-runtime`, `provider`, `executionClass`) is forbidden
in Turnlock core types, manifests, and events. Those belong to
consumers/runtimes.

## Public API

```ts
export type DelegationTarget =
  | { readonly kind: "host" }
  | { readonly kind: "worker"; readonly name: string };

export interface PromptDelegationRequest {
  readonly kind: "prompt";
  readonly target: DelegationTarget;   // mandatory
  readonly prompt: string;
  readonly label: string;
  readonly retry?: RetryPolicy;
  readonly timeout?: TimeoutPolicy;
}

export interface BatchDelegationRequest {
  readonly kind: "batch";
  readonly target: DelegationTarget;   // mandatory
  readonly jobs: ReadonlyArray<{ readonly id: string; readonly prompt: string }>;
  readonly label: string;
  readonly retry?: RetryPolicy;
  readonly timeout?: TimeoutPolicy;
}
```

There is no implicit default logical destination: `target` is mandatory and
the legacy `worker?: string` field no longer exists in the public API.

## Manifest contract (MANIFEST_VERSION 3)

Every delegation manifest serializes an explicit target:

```json
{
  "manifestVersion": 3,
  "target": { "kind": "host" },
  "...": "..."
}
```

```json
{
  "manifestVersion": 3,
  "target": { "kind": "worker", "name": "reviewer" },
  "...": "..."
}
```

No newly-authored manifest derives its destination from field absence.
A v3 manifest produced by migrating a v2 worker also carries the closed
compatibility marker:

```json
{
  "manifestVersion": 3,
  "target": { "kind": "worker", "name": "Commit Msg [old]!" },
  "targetCompatibility": "legacy-v2",
  "...": "..."
}
```

The marker records only the historical validation regime. It is not part of
the logical target and does not describe physical execution.

## Target validation (fail-closed)

Worker names obey a deterministic contract:

- non-empty string
- matches `^[a-z][a-z0-9-]*$` (same shape as delegation labels)
- at most `MAX_WORKER_NAME_LENGTH` (200) characters

Rejected shapes include `{ kind: "worker", name: "" }`,
`{ kind: "unknown" }`, and `{ kind: "host", name: "x" }` (extra fields on
`host`). Invalid target input fails closed with a Turnlock error
(`invalid_config`) instead of producing an ambiguous manifest. These
constraints apply to new input and unmarked v3 manifests.

A v3 manifest marked `targetCompatibility: "legacy-v2"` uses the historical
v2 name rule: the name may contain any characters and have any length, but it
must remain a non-empty string in an exact worker target object. The marker is
accepted only on worker targets. Unknown markers, host targets with a marker,
empty names, and extra target fields fail closed. Provenance is explicit and
is never inferred from whether a name happens to violate current syntax.

## Retry and re-emission

The logical target is immutable across attempts:

```text
attempt 0: worker("reviewer")
attempt 1: worker("reviewer")
attempt 2: worker("reviewer")
```

Only attempt-specific fields may change: `attempt`, `emittedAt`,
`emittedAtEpochMs`, `deadlineAtEpochMs`, `resultPath`, `jobs[].resultPath`.
Before announcing a retry or waiting for backoff, retry re-emission reads and
digest-verifies the stored manifest artifact, parses it, and resolves the
logical target. Only an executable retry produces `retry_scheduled`.
Reconstruction preserves `target` exactly and also preserves an explicit
`legacy-v2` compatibility marker across every descendant retry. The durable
write, fenced state commit, canonical projection, and `delegation_emit`
announcement still occur after backoff in that order.

## Legacy manifest v2 compatibility

- **v2 with `worker` present** — deterministic migration:
  `worker: "reviewer"` → `target: { "kind": "worker", "name": "reviewer" }`
  plus `targetCompatibility: "legacy-v2"`. The name is preserved
  byte-for-byte and the marker survives later retries, so serialization into
  v3 cannot make the same accepted destination invalid.
- **v2 without `worker`** — never interpreted as `host`.
  - If Turnlock only consumes already-written result files, resume
    completes without resolving the historical target (the result-consumption
    path never reads the manifest).
  - If the delegation must be retried/re-emitted/re-executed, the logical
    target is ambiguous: Turnlock fails closed with
    `ambiguous_legacy_delegation_target` and emits no replacement attempt.

## Observability

`delegation_emit` events record the logical execution decision:

```json
{
  "eventType": "delegation_emit",
  "runId": "01HX...",
  "phase": "review",
  "label": "rev",
  "kind": "prompt",
  "target": { "kind": "worker", "name": "reviewer" },
  "attempt": 0,
  "jobCount": 1,
  "timestamp": "2026-09-03T12:00:00.000Z"
}
```

Both the initial emission and every retry re-emission include `target` and
the (incremented) `attempt`. Physical runtime details (`provider`, `model`,
`executionClass`, `piSession`, `subagent`) must not appear in Turnlock
events; those belong to consumer/runtime observability.

## Consumer resolution examples

A Pi-based runtime may interpret a delegation as:

```text
worker("reviewer")
    ↓
Pi runtime
    ↓
executionClass = agent-session
provider = pi-subagents
    ↓
fresh Pi child session
```

Another consumer may interpret a different worker as:

```text
worker("git-commit-generator")
    ↓
consumer runtime
    ↓
executionClass = model-call
provider = llm-runtime
    ↓
LLM API
```

Those physical details live in the consumer; Turnlock only ever writes and
reads the logical target.

## Examples

Host delegation (the principal semantic actor of the launching harness):

```ts
return io.delegate(
  {
    kind: "prompt",
    target: { kind: "host" },
    prompt: "Review these findings and decide whether to proceed.",
    label: "host-decision",
  },
  "continue",
  state,
);
```

Worker delegation:

```ts
return io.delegateBatch(
  {
    kind: "batch",
    target: {
      kind: "worker",
      name: "reviewer",
    },
    jobs,
    label: "parallel-reviews",
  },
  "consolidate",
  state,
);
```

## stdout protocol

The protocol block stays conceptually unchanged:

```text
@@TURNLOCK@@
version: 3
action: DELEGATE
manifest: ...
kind: prompt|batch
resume_cmd: ...
@@END@@
```

The runtime reads the manifest to discover the logical target. The protocol
carries no execution implementation.
