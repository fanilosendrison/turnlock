---
okf_version: "1.0"
kind: "RuntimeArtifact"
format: "cubits-design-doc"
workspace: "turnlock"
date: "2026-07-21"
step_id: 0
id: "CDD-O-TURNLOCK-DELEGATION-ATTEMPT-EXECUTION"
version: "0.3.0"
scope: "delegation-attempt-execution"
status: "draft"
consumers:
  - "agent-generator"
superseded_by: []
---

# CDD-O: Turnlock Delegation Attempt Execution

## 1. Objectif & Position

This document defines the end-to-end execution graph for one durable Turnlock
delegation attempt. It is the umbrella orchestrator above the core process, the
Runner orchestration, harness-neutral execution strategies, and external
workers.

The Turnlock core remains neutral. It commits a delegation attempt, emits one
protocol result, releases its run lock, and terminates. It does not create a
Runner workset, schedule a host session, launch a Pi child, or supervise live
execution.

The child
[CDD-O Turnlock Runner Execution](runner/cdd-o-turnlock-runner-execution.md)
owns durable external coordination. The
[CDD-I Turnlock External Execution Strategy](runner/cdd-i-turnlock-external-execution-strategy.md)
defines the replaceable worker-execution capability. The first strategy is
[CDD-S Pi Subagents Execution](strategies/pi-subagents/cdd-s-pi-subagents-execution.md).

The feature is a breaking extension of the current manifest version 2 runtime.
All documents remain `draft` until the dependency, migration, coordination, and
crash-window contracts pass a new hostile review.

### System position

```text
Turnlock phase
  -> core commits attempt and durable resume operation
  -> core emits DELEGATE and exits
  -> Runner admits and coordinates the attempt
  -> host and external strategy may overlap
  -> Runner selects one terminal route
  -> Runner invokes fixed core resume operation
  -> core consumes terminal evidence
  -> core resumes the FSM or creates a new attempt
```

### Scoped authorities

One mutable authority exists per concern:

- `state.json`: Turnlock workflow progression, pending attempt, migration gate,
  and core resume outbox commitment;
- `WorksetRecord`: Runner coordination, strategy-state selection, intake,
  terminal-route selection, resume, and quarantine disposition;
- strategy-state commitment selected by `WorksetRecord`: technical external
  launch lifecycle;
- immutable submissions: unprivileged proposals;
- immutable outcomes and attempt-terminal artifacts: Runner-to-core delivery;
- delivery journal: host-session delivery order;
- external dependency artifacts: technical evidence only.

An event stream is audit evidence and never reconstructs missing authority.

## 2. Goals & Non-Goals

### Goals

The design provides:

- stable delegation, attempt, workset, launch, job, and invocation identities;
- complete preflight before host delivery or external spawn;
- one host job and one external strategy group at most in version 1;
- durable collect-all execution with success and failure terminality;
- unprivileged submissions followed by fenced adoption;
- one immutable outcome per manifest job on the execution route;
- a separate trusted attempt-rejection route;
- deterministic, order-independent failure aggregation;
- a shell-free, restart-safe core resume operation;
- explicit quarantine and core-owned operator abandonment;
- a mechanical manifest-v2 drain gate before manifest-v3 activation;
- recovery from every stable crash boundary without guessing.

### Non-goals

Version 1 does not provide:

- live worker state inside core `state.json`;
- child scheduling by Turnlock core;
- multiple host jobs or multiple external strategy groups;
- nested, dependent, quorum, race, or fail-fast job graphs;
- targeted job retry or successful-peer result reuse;
- exactly-once model execution;
- write-capable concurrent workspace access;
- adversarial isolation from a same-user shell process;
- distributed multi-host coordination;
- automatic executor fallback;
- business payload validation before the resumed phase;
- automatic repair and continuation of quarantined authority;
- in-place conversion of a suspended manifest-v2 attempt.

## 3. Data Contracts (Inputs & Outputs)

### Delegation attempt

The core commits one manifest-version-3 attempt:

```typescript
interface DelegationAttemptInputSketch {
  readonly turnlockRunId: string;
  readonly delegationId: string;
  readonly attemptId: string;
  readonly attempt: number;
  readonly orchestratorName: string;
  readonly label: string;
  readonly kind: "prompt" | "batch";

  readonly protocolVersion: 3;
  readonly manifestVersion: 3;
  readonly manifestCommitment: ArtifactCommitmentV2;
  readonly manifestDigest: PayloadDigestV1;
  readonly resultEnvelopeVersion: 1;
  readonly attemptTerminalTarget: ArtifactTargetRefV1;

  readonly deadlineAtEpochMs: number;
  readonly resourcePolicyDigest: PayloadDigestV1;
  readonly environmentProfileDigest: PayloadDigestV1;
  readonly workspaceInputCommitment: WorkspaceInputCommitmentV1;
  readonly jobs: readonly ManifestJobSketch[];
  readonly resumeOperation: ResumeOperationSpecSketch;
  readonly resumeOperationDigest: PayloadDigestV1;
}

interface ManifestJobSketch {
  readonly id: string;
  readonly prompt: string;
  readonly target:
    | { readonly kind: "host" }
    | { readonly kind: "worker"; readonly profile: string }
    | { readonly kind: "direct"; readonly profile: string };
  readonly resultTarget: ArtifactTargetRefV1;
  readonly resultContractId?: string;
}
```

Every job target is `turnlock-run-relative` with purpose `core-job-result`; the
terminal target uses purpose `attempt-terminal`. The core allocates them as
write-once, attempt-scoped, pairwise distinct locations. No absolute path crosses
the boundary.

### Protocol version

The breaking delegation-attempt contract uses protocol version 3. Its closed
actions remain `DELEGATE`, `DONE`, `ERROR`, and `ABORTED`. Version-3 `ABORTED`
uses one discriminated cause:

```typescript
type AbortedCauseSketch =
  | {
      readonly kind: "signal";
      readonly signal: "SIGINT" | "SIGTERM";
    }
  | {
      readonly kind: "operator-abort";
      readonly attemptId: string;
      readonly operatorAbortProofCommitment: ArtifactCommitmentV2;
    };
```

Protocol version 2 remains readable only by the pinned v2 drain runtime. A v3
admission never coerces a v2 block.

### Resume operation contract

The core commits data, not a command string:

```typescript
interface ResumeOperationSpecSketch {
  readonly version: 1;
  readonly operation: "resume-delegation-attempt";
  readonly invocationId: string;
  readonly turnlockRunId: string;
  readonly delegationId: string;
  readonly attemptId: string;
  readonly expectedPendingStateDigest: PayloadDigestV1;
  readonly protocolVersion: 3;
}
```

The Runner resolves one fixed trusted core entry point from the committed
environment profile and passes structured arguments without a shell. Executable
selection, working directory, environment allowlist, and process-capture policy
are deployment commitments, not worker-controlled fields.

### Submission and outcome

A submission proposes a result and grants no adoption authority. Core identity,
failure taxonomy, and JSON payload domain are:

```typescript
interface CoreOutcomeIdentitySketch {
  readonly turnlockRunId: string;
  readonly delegationId: string;
  readonly attemptId: string;
  readonly attempt: number;
  readonly jobId: string;
  readonly manifestVersion: 3;
  readonly manifestDigest: PayloadDigestV1;
  readonly resultEnvelopeVersion: 1;
}

type ExecutionFailureCodeSketch =
  | "executor-unavailable"
  | "provider-exhausted"
  | "deadline-exceeded"
  | "invalid-executor-output"
  | "budget-exceeded"
  | "protocol-failure"
  | "cancelled-by-user"
  | "unknown";

type JsonValueSketch =
  | null
  | boolean
  | number
  | string
  | readonly JsonValueSketch[]
  | { readonly [key: string]: JsonValueSketch };

interface JobSubmissionHeaderSketch {
  readonly version: 1;
  readonly turnlockRunId: string;
  readonly delegationId: string;
  readonly attemptId: string;
  readonly worksetId: string;
  readonly jobId: string;
  readonly executorSpecDigest: PayloadDigestV1;
  readonly publishedAtEpochMs: number;
}
```

Every final outcome identifies its provenance:

```typescript
type OutcomeProvenanceSketch =
  | {
      readonly kind: "adopted-host-submission";
      readonly submissionCommitment: ArtifactCommitmentV2;
      readonly ticketCommitment: ArtifactCommitmentV2;
    }
  | {
      readonly kind: "adopted-worker-submission";
      readonly submissionCommitment: ArtifactCommitmentV2;
      readonly executionEvidenceCommitment: ArtifactCommitmentV2;
    }
  | {
      readonly kind: "owner-generated-terminal";
      readonly cause: "deadline-exceeded" | "cancelled-by-user";
      readonly terminalCauseCommitment: ArtifactCommitmentV2;
    };

interface RunnerOutcomeIdentitySketch {
  readonly worksetId: string;
  readonly executorSpecDigest: PayloadDigestV1;
  readonly provenance: OutcomeProvenanceSketch;
}

type JobOutcomeEnvelopeSketch<T> =
  | {
      readonly version: 1;
      readonly status: "success";
      readonly coreIdentity: CoreOutcomeIdentitySketch;
      readonly runnerIdentity: RunnerOutcomeIdentitySketch;
      readonly payload: T;
      readonly payloadDigest: PayloadDigestV1;
      readonly completedAt: string;
    }
  | {
      readonly version: 1;
      readonly status: "failure";
      readonly coreIdentity: CoreOutcomeIdentitySketch;
      readonly runnerIdentity: RunnerOutcomeIdentitySketch;
      readonly failureCode: ExecutionFailureCodeSketch;
      readonly message: string;
      readonly diagnosticRef?: ArtifactRefV2;
      readonly completedAt: string;
    };
```

`executorSpecDigest` is the universal identity of intended execution. It is not
misrepresented as evidence that execution occurred. Only the worker provenance
branch requires external execution evidence.

### Terminal selection

The Runner selects exactly one route:

```typescript
type RunnerAttemptTerminalEnvelopeSketch =
  | {
      readonly version: 1;
      readonly kind: "outcomes-complete";
      readonly identity: AttemptTerminalIdentitySketch;
      readonly outcomeSetDigest: PayloadDigestV1;
      readonly committedAt: string;
    }
  | {
      readonly version: 1;
      readonly kind: "attempt-rejected";
      readonly identity: AttemptTerminalIdentitySketch;
      readonly rejection: AttemptRejectionSketch;
      readonly rejectionDigest: PayloadDigestV1;
      readonly committedAt: string;
    };
```

Terminal identity and rejection evidence are:

```typescript
type AttemptRejectionCodeSketch =
  | "unsupported-topology"
  | "capability-mismatch"
  | "invalid-execution-configuration"
  | "dependency-unavailable"
  | "insufficient-deadline-margin"
  | "configuration-drift";

interface AttemptTerminalIdentitySketch {
  readonly turnlockRunId: string;
  readonly delegationId: string;
  readonly attemptId: string;
  readonly attempt: number;
  readonly manifestVersion: 3;
  readonly manifestDigest: PayloadDigestV1;
  readonly runnerId: string;
  readonly worksetId: string;
}

interface AttemptRejectionSketch {
  readonly version: 1;
  readonly rejectionCode: AttemptRejectionCodeSketch;
  readonly message: string;
  readonly diagnosticRef?: ArtifactRefV2;
  readonly rejectedAt: string;
}
```

Authority or identity ambiguity selects neither route. It quarantines the
workset and requires an independently authorized core disposition.

### Core resume outbox contract

Before publishing a resume result, the core commits:

```typescript
interface CoreResumeOutboxSketch {
  readonly version: 1;
  readonly invocationId: string;
  readonly operationDigest: PayloadDigestV1;
  readonly priorPendingStateDigest: PayloadDigestV1;
  readonly protocolResultCommitment: ArtifactCommitmentV2;
  readonly processExpectation: "exit-zero-after-protocol";
}
```

The core first publishes one immutable `turnlock:core-transition` candidate
containing the prior state digest, complete next state, every new manifest or terminal
commitment, protocol bytes, and invocation identity. It then atomically
replaces `state.json` from the expected prior digest with the next state and
outbox commitment. `inspect-or-reemit-current-result` returns
only an outbox selected by current authoritative state.

A crash before state replacement leaves an unselected candidate that cannot be
emitted. Recovery may select exactly one fully valid candidate whose prior state
and invocation still match, or regenerate byte-identical content from the same
committed operation. Multiple or divergent candidates fail closed.

### Operator abort

A quarantined attempt may be abandoned only through a core operation:

```typescript
interface OperatorAbortRequestSketch {
  readonly version: 1;
  readonly operation: "abort-quarantined-attempt";
  readonly protocolVersion: 3;
  readonly turnlockRunId: string;
  readonly delegationId: string;
  readonly attemptId: string;
  readonly expectedPendingStateDigest: PayloadDigestV1;
  readonly quarantineEvidenceCommitment: ArtifactCommitmentV2;
  readonly boundedReason: string;
  readonly authorization: {
    readonly algorithm: "ed25519";
    readonly keyId: string;
    readonly signature: string;
  };
}
```

The signature covers the domain-separated canonical request excluding the
`authorization` field. The core resolves `keyId` through the committed trusted
operator public-key registry, verifies Ed25519 before mutation, applies a
compare-and-set against authoritative pending state, commits an operator-abort
proof, and advances the core lifecycle. Private keys remain outside Runner and
core process storage. The Runner cannot invoke this route as an ordinary
terminalization shortcut.

## 4. Pipeline

### DAG

```text
A. Core attempt commitment
  -> B. Runner admission and durable handoff
      -> C. Complete workset preflight
          -> D1. Host intake branch ───────┐
          -> D2. External strategy branch ├─> E. Intake closure and adoption
                                           ┘      -> F1. Outcome join
                                                  -> F2. Attempt rejection
                                                  -> F3. Quarantine
F1 or F2 -> G. Terminal publication
          -> H. Fixed resume invocation
          -> I. Core terminal consumption
          -> J1. Resume phase on all success
          -> J2. Retry resolver on aggregate failure or rejection
F3       -> K. Read-only inspection
          -> L. Core operator abort or retained quarantine
```

### A. Core attempt commitment

The core validates the neutral topology, allocates stable identities and typed
artifact targets, commits manifest version 3 and pending state, emits one
`DELEGATE` block, releases its lock, and exits.

### B. Runner admission and handoff

The admission node cross-validates protocol, manifest, core state, target
allocations, resource policy, environment profile, and resume operation. It
publishes durable handoff evidence before the short invocation releases
responsibility.

### C. Complete workset preflight

The Runner obtains a side-effect-free strategy verdict, then the workset
preparation node validates generic, host, environment, policy, workspace,
result-contract, and strategy commitments. A complete valid set becomes one
prepared workset. A trustworthy deterministic failure selects attempt
rejection. Untrusted identity or integrity fails admission or quarantines an
existing workset.

### D. Parallel production

The host branch and external strategy branch may overlap without a simultaneous
start guarantee. Each branch can publish immutable unprivileged submissions
only while intake is open. Neither branch writes final core targets.

### E. Closure and adoption

The current owner closes intake after all expected terminal submissions, at the
core deadline, on user cancellation, or before a trusted rejection. It adopts
eligible submissions under the current fence and creates immutable terminal
cause evidence for unresolved jobs after deadline or cancellation.

### F. Terminal selection

The outcome route commits one final outcome per manifest job and selects the
all-terminal envelope. The rejection route selects one attempt-level cause
without fabricating job outcomes. Quarantine preserves evidence and selects no
automatic core terminal route.

### G–I. Publication and resume

The Runner publishes the already selected terminal envelope at the exact core
target, then starts the fixed resume operation. The core publishes its protocol
result to the resume outbox before advancing `state.json` and emitting stdout.
Runner recovery uses the outbox when process output was not durably captured.

### J. Success or retry

The core validates terminal identity and all expected outcomes in manifest
order. All-success payloads resume the phase directly. Only a non-empty failure
set or valid attempt rejection enters classification and retry resolution.

A retry preserves `delegationId` and creates a new `attemptId`, workset,
deadline, targets, commitments, and profile resolution. Version 1 retries the
complete delegation.

### K–L. Quarantine disposition

The quarantine disposition node keeps inspection read-only and automatic
progress stopped. An operator with a valid Ed25519 authorization over the exact
request may direct the core to abandon the pending attempt through a
state-digest compare-and-set. The Runner records the core proof, prevents late
terminal publication, and delegates retention-bound deletion to the cleanup
node.

## 5. Invariants

1. `state.json` is the sole authority for core workflow progression.
2. `WorksetRecord` is the sole mutable selector of Runner and strategy state.
3. Every stable snapshot references already published immutable artifacts.
4. One attempt maps to exactly one deterministic workset namespace.
5. One current owner generation authorizes owner-only transitions.
6. Workers, host sessions, and strategies never receive owner or resume
   authority.
7. Every result and terminal target is core-allocated and write-once.
8. Intake publication and closure are serialized by one recoverable mutex.
9. Submission, completion, event, and file-discovery order cannot affect join or
   failure reduction.
10. A strategy-state candidate is not authoritative until selected by
    `WorksetRecord.strategyStateCommitment`.
11. Outcome and rejection terminal routes are mutually exclusive.
12. Quarantine is containment and has an explicit operator disposition path.
13. A graceful controller shutdown is ownership handoff, not cancellation.
14. A resume result is recoverable from core authoritative state after stdout
    loss.
15. Manifest-v2 pending attempts never execute through manifest-v3 semantics.

## 6. Internal Operations

### Failure classification

Per-job failure classification is core-owned:

```text
executor-unavailable      -> transient
provider-exhausted        -> transient
deadline-exceeded         -> transient
invalid-executor-output   -> transient
budget-exceeded           -> permanent
protocol-failure          -> permanent
cancelled-by-user         -> abort
unknown                   -> permanent
```

Attempt rejections classify as:

```text
dependency-unavailable          -> transient
unsupported-topology            -> permanent
capability-mismatch              -> permanent
invalid-execution-configuration  -> permanent
insufficient-deadline-margin     -> permanent
configuration-drift             -> permanent
```

### Aggregate reduction

Reduce the complete manifest-ordered outcome set as follows:

```text
no failures
  -> success; resume the phase; do not invoke the retry resolver

otherwise any abort
  -> aggregate abort

otherwise any permanent
  -> aggregate permanent

otherwise
  -> aggregate transient
```

Select primary diagnostics separately by stable classification, failure-code,
and job-identity ordering. Never classify only the first failure to finish.

### Resume result recovery

The Runner commits invocation intent and capture targets before process start.
It captures exit status, signal, stdout, and stderr as bounded immutable process
observation. The core publishes a complete transition candidate before its
single authoritative `state.json` replacement; only the selected outbox can be
emitted. When Runner capture is missing or incomplete, it asks the fixed core
API to inspect or re-emit the outbox for the same `invocationId`.

A core state advanced beyond the attempt is not archived blindly. Recovery first
requires either the exact committed outbox result or a core proof that no result
was selected. Divergence quarantines the workset.

### Manifest-v2 upgrade gate

The breaking release follows this sequence:

1. close protocol-v2 and manifest-v2 admission under an upgrade lock;
2. inventory every configured Turnlock run root;
3. drain each pending v2 delegation with the pinned v2 runtime or apply an
   explicit v2 operator abandonment;
4. repeat the inventory while old controllers remain stopped;
5. activate protocol-v3 and manifest-v3 admission only when zero pending v2
   records remain.

A protocol-v3 runtime encountering pending protocol-v2 or manifest-v2 state
reports an incompatible-state error and performs no mutation. Completed v2 runs
remain read-only historical data. No v3 migration invents missing delegation,
attempt, digest, terminal-target, or resume identities.

### Quarantine recovery

Quarantine emits a durable alert and retains evidence. Read-only inspection may
export bounded evidence but may not rewrite it. Core operator abort rejects an
unknown key, malformed signature, signature mismatch, state-digest mismatch, or
evidence mismatch before mutation. It is idempotent for the same authorized
request digest and conflicting for a different request.
Cleanup becomes eligible only after the Runner verifies the core disposition
proof and the minimum quarantine retention period expires.

## 7. Cross-Cutting Concerns

### Canonical data and artifacts

All semantic JSON follows
[STD-TURNLOCK-CANONICAL-JSON-AND-DIGEST](../../standards/std-turnlock-canonical-json-and-digest.md).
All targets, references, commitments, root bindings, and publication ordering
follow
[STD-TURNLOCK-ARTIFACT-REFERENCE-AND-INTEGRITY](../../standards/std-turnlock-artifact-reference-and-integrity.md).

### Idempotence and determinism

Stable identities exist for every attempt, workset, launch, submission, outcome,
terminal selection, delivery event, resume invocation, outbox, and operator
abort. Repetition converges only for identical canonical content. Divergence is
never resolved by timestamp or arrival order.

### Security and privacy

The design protects against stale processes, accidental path mistakes, replay,
crashes, and ordinary races. Secrets, owner tokens, credentials, raw model
context, unrestricted paths, and unbounded provider text are excluded from
portable commitments and human-facing messages. Messages remain bounded to 200
characters; larger evidence is referenced by commitment.

### Observability

Every stable transition emits bounded audit facts. Audit events are not replay
authority. Quarantine and operator disposition generate persistent alerts until
acknowledged.

### Cleanup

Cleanup is reference-aware, fenced, idempotent, and subordinate to pending
resume, delivery, quarantine, operator proof, and diagnostic retention.

## 8. Infrastructure & Environment

The corpus consumes the exact certified profile in
[STD-TURNLOCK-DELEGATION-EXECUTION-ENVIRONMENT](../../standards/std-turnlock-delegation-execution-environment.md)
and the complete limits in
[STD-TURNLOCK-DELEGATION-RESOURCE-POLICY](../../standards/std-turnlock-delegation-resource-policy.md).

Version 1 is local, native, APFS-backed, and cooperative. It requires exact
runtime and dependency commitments, local process identity probes, local IPC,
and a closed provider/network profile. No NIB may broaden this environment or
choose missing limits.

Cross-process deadlines use epoch milliseconds. In-process durations use a
monotonic clock. Ownership, mutex, clock anomaly, and delivery ordering follow
[STD-TURNLOCK-RUNNER-COORDINATION](../../standards/std-turnlock-runner-coordination.md).

## 9. Dependencies

### Child conception documents

- [CDD-O Turnlock Runner Execution](runner/cdd-o-turnlock-runner-execution.md);
- [CDD-N Turnlock Attempt Admission and Handoff](runner/cdd-n-turnlock-attempt-admission-and-handoff.md);
- [CDD-N Turnlock Workset Preparation](runner/cdd-n-turnlock-workset-preparation.md);
- [CDD-N Turnlock Host Intake](runner/cdd-n-turnlock-host-intake.md);
- [CDD-N Turnlock Outcome and Terminal Coordination](runner/cdd-n-turnlock-outcome-and-terminal-coordination.md);
- [CDD-N Turnlock Terminal Resume](runner/cdd-n-turnlock-terminal-resume.md);
- [CDD-N Turnlock Quarantine Disposition](runner/cdd-n-turnlock-quarantine-disposition.md);
- [CDD-N Turnlock Delivery Bridge](runner/cdd-n-turnlock-delivery-bridge.md);
- [CDD-N Turnlock Workset Cleanup](runner/cdd-n-turnlock-workset-cleanup.md);
- [CDD-I Turnlock External Execution Strategy](runner/cdd-i-turnlock-external-execution-strategy.md);
- [CDD-S Pi Subagents Execution](strategies/pi-subagents/cdd-s-pi-subagents-execution.md).

### Permanent standards

- canonical JSON and digest;
- artifact reference and integrity;
- workspace input commitment;
- Runner coordination;
- delegation resource policy;
- delegation execution environment.

### External dependencies

Pi execution requires an active compatible
[pi-subagents Dependency Contract](../../dependencies/dc-pi-subagents.md).
The currently inspected fork commit is incompatible and therefore cannot
satisfy Pi strategy preflight.

Strict parsing and RFC 8785 are pinned by
[DC jsonc-parser](../../dependencies/dc-jsonc-parser.md) and
[DC canonicalize](../../dependencies/dc-canonicalize.md). Their
runtime-dependency ADR remains a construction gate.

### Historical briefs

Existing NIBs describe the current runtime and remain immutable historical
artifacts. The future manifest-v3 construction lot supersedes behavior only
after this corpus is baselined and new NIBs are extracted.

## 10. Testing Strategy

Acceptance coverage must prove:

- all-success outcomes bypass failure classification and retry resolution;
- every permutation of completion and discovery yields the same outcome digest;
- each non-empty aggregate branch has a closed oracle;
- result and terminal targets reject absolute, foreign-run, colliding, and
  divergent publication;
- host, worker, and owner-generated provenance branches validate independently;
- strategy-state candidates are powerless before workset selection;
- terminal outcome and rejection routes are exclusive;
- crash before core transition-candidate selection never emits unselected
  output;
- crash after core state advance but before Runner output commit recovers the
  exact outbox result;
- duplicate resume converges on one `invocationId`;
- quarantine cannot publish or resume automatically;
- operator abort is authenticated, state-digest-fenced, audited, and idempotent;
- cleanup derives the full reference set and remains blocked until disposition
  and retention gates pass;
- graceful handoff creates no cancellation or stop;
- upgrade admission cannot race creation of a new v2 attempt;
- v3 refuses pending v2 state without mutation;
- dependency incompatibility rejects before any external side effect.

Mandatory proof vectors include:

```text
[success, success] -> success -> zero retry-resolver calls
[success, transient] -> transient
[permanent, transient] -> permanent
[abort, permanent] -> abort
[] -> invalid manifest; no execution
```

Crash fixtures cover every edge before and after artifact publication, snapshot
advancement, handoff, submission, adoption, terminal selection, terminal
publication, resume outbox commitment, stdout emission, delivery claim,
operator abort, and cleanup.

The corpus remains `draft` until these vectors, the compatible pi-subagents
contract, the strict JSON dependency contract, and a fresh hostile review all
pass.

## 11. Glossary

### Attempt

One ordered execution under a stable logical delegation. A retry creates a new
attempt identity and never adopts older-attempt evidence.

### Attempt rejection

Trusted attempt-level terminal route used when per-job outcomes would falsely
claim execution.

### Core resume outbox

Immutable protocol result committed in core authoritative state before stdout
emission, allowing exact re-emission after a crash.

### Delegation

Stable logical request that can own multiple complete attempts.

### Outcome provenance

Discriminated evidence identifying whether an outcome came from an adopted host
submission, adopted worker submission, or owner-generated terminal cause.

### Quarantine

Containment state for unresolved authority or integrity. It halts automatic
terminalization and requires explicit core disposition.

### Resume operation

Structured, shell-free request executed through one trusted fixed core entry
point.

### Strategy-state candidate

Immutable proposed strategy snapshot that has no authority until selected by the
current `WorksetRecord` commitment.

### Workset

Runner-owned durable execution projection of exactly one Turnlock attempt.
