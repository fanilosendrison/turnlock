---
okf_version: "1.0"
kind: "RuntimeArtifact"
format: "cubits-design-doc"
workspace: "turnlock"
date: "2026-07-21"
step_id: 0
id: "CDD-O-TURNLOCK-RUNNER-EXECUTION"
version: "0.3.0"
scope: "runner-execution"
status: "draft"
consumers:
  - "agent-generator"
superseded_by: []
---

# CDD-O: Turnlock Runner Execution

## 1. Objectif & Position

This document defines the harness-neutral Runner orchestration for one committed
Turnlock delegation attempt. It replaces the former broad Runner CDD-I, whose
operational admission, handoff, intake, coordination, resume, delivery, and
cleanup pathways were incompatible with interface typology.

The parent
[CDD-O Turnlock Delegation Attempt Execution](../cdd-o-turnlock-delegation-attempt-execution.md)
owns core authority, end-to-end identities, final failure classification, retry,
and workflow progression. This CDD owns the Runner DAG, `WorksetRecord`, current
owner, terminal selection, and delegation to child nodes and one external
execution strategy.

The Runner is not a workflow engine. It coordinates one external projection of
one already committed Turnlock attempt and returns terminal evidence to the
core.

### Actors

- A short Runner invocation starts or resumes the core and durably hands off its
  protocol result.
- A resident controller holds the current owner lease and drives the Runner DAG.
- A host session can execute at most one independent host job.
- An external strategy executes the worker subset through the narrow strategy
  interface.
- A delivery bridge transfers immutable events into the harness session.
- An operator can inspect quarantine but cannot fabricate Runner terminal
  evidence.

## 2. Goals & Non-Goals

### Goals

The Runner orchestration provides:

- deterministic attempt-to-workset selection;
- one authoritative workset snapshot per attempt;
- complete preflight before any external side effect;
- fenced current-owner transitions;
- one mutex contract for workset transactions and submission publication;
- parallel host and external-strategy branches;
- immutable host and worker submissions;
- explicit outcome provenance;
- recoverable partial outcome commitment;
- mutually exclusive outcome, rejection, and quarantine routes;
- durable terminal publication and restart-safe resume;
- sequential at-least-once host delivery;
- explicit graceful ownership handoff;
- reference-aware cleanup after terminal disposition.

### Non-goals

The Runner does not provide:

- Turnlock FSM progression or retry decisions;
- strategy-specific launch or model scheduling;
- business payload validation;
- exactly-once external execution;
- simultaneous branch start;
- distributed coordination;
- automatic strategy fallback;
- multiple external strategy groups;
- multiple host jobs;
- automatic repair of ambiguous authority;
- a shell command execution surface;
- reconstruction of authority from audit events.

## 3. Data Contracts (Inputs & Outputs)

### Attempt input

The Runner consumes `DelegationAttemptInputSketch` from the parent CDD. It
requires manifest version 3, typed core-run targets, resource and environment
commitments, workspace commitment, and a structured resume operation.

The Runner never accepts an absolute result path or arbitrary resume command.

### Workset snapshot

```typescript
interface WorksetRecordSketch {
  readonly version: 1;
  readonly worksetId: string;
  readonly runnerId: string;
  readonly turnlockRunId: string;
  readonly delegationId: string;
  readonly attemptId: string;
  readonly attempt: number;

  readonly manifestCommitment: ArtifactCommitmentV2;
  readonly manifestDigest: PayloadDigestV1;
  readonly attemptTerminalTarget: ArtifactTargetRefV1;
  readonly deadlineAtEpochMs: number;
  readonly resourcePolicyDigest: PayloadDigestV1;
  readonly environmentProfileDigest: PayloadDigestV1;
  readonly workspaceInputCommitment: WorkspaceInputCommitmentV1;
  readonly resumeOperation: ResumeOperationSpecSketch;
  readonly resumeOperationDigest: PayloadDigestV1;

  readonly state: WorksetStateSketch;
  readonly ownerGeneration: number;
  readonly intake: IntakeRecordSketch;
  readonly jobs: readonly WorksetJobRecordSketch[];
  readonly hostTicketCommitment?: ArtifactCommitmentV2;
  readonly strategyState: StrategyStateSelectionSketch;
  readonly terminal: AttemptTerminalSelectionSketch;
  readonly resume: ResumeRecordSketch;
  readonly quarantine: QuarantineRecordSketch;
  readonly createdAt: string;
  readonly updatedAt: string;
}

type WorksetStateSketch =
  | "admitted"
  | "prepared"
  | "active"
  | "intake-closed"
  | "outcomes-committed"
  | "attempt-rejected"
  | "resuming"
  | "resumed"
  | "quarantined"
  | "quarantine-resolved";
```

`WorksetRecord` is atomically replaced and is the only mutable Runner authority.
Events and mutable convenience indexes are not authoritative.

### Strategy-state selection

```typescript
type StrategyStateSelectionSketch =
  | { readonly state: "none" }
  | {
      readonly state: "selected";
      readonly strategyId: string;
      readonly revision: number;
      readonly commitment: ArtifactCommitmentV2;
    };

interface StrategyStateCandidateHeaderSketch {
  readonly version: 1;
  readonly worksetId: string;
  readonly strategyId: string;
  readonly revision: number;
  readonly previousCommitment?: ArtifactCommitmentV2;
  readonly operationId: string;
}
```

A strategy publishes an immutable candidate first. Only an atomic workset
transition under the current fence can select it. No independently replaced
strategy snapshot is authoritative.

### Workset jobs

```typescript
interface WorksetJobRecordSketch {
  readonly jobId: string;
  readonly targetKind: "host" | "worker" | "direct";
  readonly resultTarget: ArtifactTargetRefV1;
  readonly executorSpecDigest?: PayloadDigestV1;
  readonly submission:
    | { readonly state: "awaiting" }
    | {
        readonly state: "adopted";
        readonly commitment: ArtifactCommitmentV2;
      };
  readonly outcome:
    | { readonly state: "absent" }
    | {
        readonly state: "committed";
        readonly commitment: ArtifactCommitmentV2;
        readonly provenance: OutcomeProvenanceSketch;
      };
}
```

An executor digest is mandatory after preparation on the outcome route. It may
be absent only when preflight selected a trusted rejection before complete
executor resolution.

### Intake

```typescript
interface IntakeRecordSketch {
  readonly state: "open" | "closed";
  readonly closedAtEpochMs?: number;
  readonly closeReason?:
    | "all-submissions-received"
    | "deadline-reached"
    | "cancelled-by-user"
    | "attempt-rejected"
    | "quarantined";
  readonly terminalCauseCommitment?: ArtifactCommitmentV2;
}
```

Intake closure is irreversible. Deadline and cancellation closures commit an
immutable terminal-cause artifact before owner-generated outcomes reference it.

### Terminal selection and publication

```typescript
type AttemptTerminalSelectionSketch =
  | { readonly kind: "pending" }
  | {
      readonly kind: "outcomes-complete" | "attempt-rejected";
      readonly envelope: RunnerAttemptTerminalEnvelopeSketch;
      readonly terminalDigest: PayloadDigestV1;
      readonly publication:
        | { readonly state: "not-published" }
        | {
            readonly state: "published";
            readonly commitment: ArtifactCommitmentV2;
          };
      readonly selectedAtEpochMs: number;
    };
```

Terminal selection is atomic with the workset. Publication at the core target
is a later idempotent projection of the exact selected bytes.

### Resume

```typescript
type ResumeRecordSketch =
  | { readonly state: "not-started" }
  | {
      readonly state: "in-progress";
      readonly invocationId: string;
      readonly invocationIntentCommitment: ArtifactCommitmentV2;
    }
  | {
      readonly state: "completed";
      readonly invocationId: string;
      readonly processObservationCommitment: ArtifactCommitmentV2;
      readonly protocolResultCommitment: ArtifactCommitmentV2;
    };
```

### Quarantine and disposition

```typescript
interface QuarantineRecordSketch {
  readonly state: "none" | "open" | "resolved-by-core";
  readonly reasonCode?: string;
  readonly evidenceCommitment?: ArtifactCommitmentV2;
  readonly openedAtEpochMs?: number;
  readonly alertEventId?: string;
  readonly operatorAbortProofCommitment?: ArtifactCommitmentV2;
  readonly resolvedAtEpochMs?: number;
}
```

An open quarantine keeps terminal selection pending and blocks automatic resume.
Only a validated core disposition proof changes it to `resolved-by-core`.

### Delivery events

Every delivery event carries `sessionKey`, monotonic `sequence`, predecessor
digest, semantic digest, payload commitment, and immutable event identity. Claim
metadata is separate and follows the Runner coordination standard.

## 4. Pipeline

### Runner DAG

```text
1. Admission and durable handoff node
   -> 2a. External strategy side-effect-free preflight
      -> 2b. Workset preparation node
         -> 3. Activation
            -> 4a. Host intake node ─────────────┐
            -> 4b. External execution strategy ─┤
                                                -> 5. Outcome node
                                                   -> 6a. Resume node
                                                   -> 6b. Quarantine node
                                                      -> 7. Cleanup node
1, 3, 5, 6 -> Delivery bridge node as durable event projection
```

### 1. Admission and handoff

The admission node validates one core protocol result and commits an admitted
workset namespace plus durable handoff evidence. It performs no external
execution and no terminal decision.

### 2. Preflight and preparation

The Runner orchestrator obtains the external strategy's side-effect-free
capability verdict, then delegates generic, host, result-contract, workspace,
policy, environment, topology, and candidate validation to the
[workset preparation node](cdd-n-turnlock-workset-preparation.md).

That node produces one complete prepared snapshot, trusted rejection request, or
ambiguity request. The Runner routes trusted rejection to the outcome node and
ambiguity to quarantine disposition without performing raw preflight work.

### 3. Activation

The current owner verifies the prepared snapshot and opens intake. It commits
host-ticket evidence before host delivery and selects the initial strategy-state
candidate before external spawn authority exists.

### 4. Production branches

The host node validates and publishes host submissions through opaque tickets.
The strategy implements the worker subset, selects technical state through
workset candidate transitions, and publishes worker submissions. Both use the
same intake mutex and workspace boundary.

### 5. Coordination and terminal selection

The outcome node closes intake, adopts submissions, creates missing terminal
cause evidence, commits final outcomes, and selects exactly one terminal route.
It never classifies core retry policy.

### 6. Resume or quarantine disposition

The terminal resume node publishes the selected terminal envelope, starts the
fixed core resume operation, captures the process observation, and recovers the
core outbox when needed.

The quarantine disposition node provides read-only inspection and validates a
signed core-owned operator abort. No Runner node repairs ambiguous evidence into
authority.

### 7. Cleanup

After terminal resume or verified quarantine disposition, the Runner delegates
reference derivation, retention checks, and safe deletion to the workset cleanup
node. When that node outputs a dependency-retention request, the Runner invokes
the selected strategy, obtains a receipt, and reinvokes cleanup with that receipt.

### Delivery projection

Every host continuation, terminal result, Runner error, and abort notification
is an immutable sequenced event. The delivery node transfers only the next
undelivered sequence and records durable delivered evidence.

## 5. Invariants

1. One deterministic namespace exists per `runnerId` and `attemptId`.
2. Multiple matching worksets quarantine; discovery order never selects one.
3. `WorksetRecord` is the sole mutable Runner and strategy-state selector.
4. Every stable workset references only already published commitments.
5. Owner-only transitions require current generation and token under the mutex.
6. Mutex acquisition alone grants no owner authority.
7. Complete preflight precedes host delivery and external spawn.
8. At most one host job and one external strategy group exist in version 1.
9. Host and worker producers publish proposals only.
10. Strategy candidates have no authority before workset selection.
11. A strategy launch cannot be replaced after any submission from it is
    adopted.
12. Intake closure is irreversible.
13. Every outcome has one valid discriminated provenance branch.
14. All-terminal means exactly one committed outcome per manifest job.
15. Terminal outcome and rejection routes are mutually exclusive.
16. Quarantine leaves terminal selection pending.
17. Resume uses structured operation identity and fixed executable policy.
18. Delivery sequence is contiguous per session.
19. Graceful controller shutdown changes ownership, not attempt semantics.
20. Cleanup never deletes evidence needed by pending state or disposition.

## 6. Internal Operations

### Workset selection

Derive one namespace from `runnerId` and `attemptId`. Validate the workset's
independent identifier and complete attempt identity. A derived convenience
index may accelerate lookup but cannot duplicate manifest, resume, terminal, or
quarantine state.

### Candidate selection

A strategy-state transition follows:

```text
publish immutable candidate
  -> acquire transaction mutex
  -> verify current owner fence
  -> verify candidate.previousCommitment equals current selection
  -> verify revision increments by one
  -> atomically replace WorksetRecord with candidate commitment
```

A crash before the final step leaves a non-authoritative candidate. Recovery
may regenerate or collect it; it may not infer that associated external side
effects were authorized. External spawn begins only after the dispatch-intent
candidate is selected.

### Owner recovery

Takeover follows
[STD-TURNLOCK-RUNNER-COORDINATION](../../../standards/std-turnlock-runner-coordination.md).
Lease expiry without definite process-instance absence is insufficient.
Indeterminate process or clock evidence stops automatic recovery.

### Submission adoption

Adoption verifies attempt, workset, executor intent, source identity, workspace,
intake publication boundary, artifact integrity, and provenance eligibility.
Identical evidence converges. Divergence quarantines.

### Deadline and cancellation

The current owner performs a final submission scan while holding the mutex,
commits closure and terminal-cause evidence, then releases the mutex before any
external stop request. Already receivable submissions remain adoptable. Missing
jobs receive owner-generated outcomes referencing the same immutable cause.

### Attempt rejection

A trusted rejection can be selected before dispatch or after partial evidence
while terminal selection remains pending. It closes intake first, retains prior
outcomes as audit evidence, and never fabricates job outcomes. User cancellation
already selected through a terminal cause cannot be replaced by rejection.

### Quarantine

Quarantine closes intake, stops new owner transitions except inspection and
disposition, requests bounded external reconciliation when safe, publishes a
persistent alert, and retains evidence. It does not publish an attempt terminal
envelope.

### Resume recovery

A duplicate or interrupted resume converges by `invocationId`, current owner,
core run lock, process observation, and core outbox commitment. If core pending
state advanced, the node obtains the exact outbox result before marking the old
request complete. Missing or divergent outbox identity quarantines.

### Cleanup orchestration

The Runner invokes the cleanup node only after a terminal or disposition
boundary makes some artifacts potentially collectible. It supplies scope,
current policy, and any strategy retention receipts but performs no raw
reference traversal or deletion. Open
quarantine, pending delivery, unresolved orphan execution, and incomplete resume
remain cleanup blockers.

### Failure behavior

| Condition | Runner response |
| --------- | --------------- |
| Attempt identity mismatch before workset | Reject admission |
| Workset collision or duplicate namespace | Quarantine evidence |
| Active owner conflict | Reject takeover |
| Stale owner transition | Commit nothing |
| Mutex recovery indeterminate | Stop automatic progress |
| Snapshot corruption | Quarantine; do not replay events |
| Trusted preflight failure | Select attempt rejection |
| Dispatch before selected intent | Quarantine protocol violation |
| Submission after closure | Reject publication |
| Divergent submission or outcome | Quarantine and preserve both |
| Workspace drift with trusted identity | Select configuration-drift rejection |
| Deadline with missing jobs | Commit owner-generated deadline outcomes |
| Terminal artifact without selection | Quarantine; never adopt it |
| Selection before publication crash | Republish selected bytes only |
| Core output capture lost | Inspect or re-emit core outbox |
| Delivery sequence gap | Stop at the gap and alert |
| Core operator abort verified | Resolve quarantine and prevent late resume |
| Cleanup crash | Repeat from current reference set |

## 7. Cross-Cutting Concerns

### Canonical data and artifacts

Canonical JSON, semantic digests, artifact targets, commitments, safe opens,
and publication ordering come exclusively from the permanent standards. No
Runner node defines a local variant.

### Idempotence

Attempt, workset, candidate revision, ticket, submission, outcome, terminal,
resume invocation, delivery event, and operator disposition identities are
stable. Repetition compares complete canonical digests.

### Security

Paths and executable identity resolve from trusted records. Owner tokens never
enter host, worker, strategy, event, outcome, or diagnostic content. The threat
model remains cooperative for same-user processes.

### Observability

Every stable transition emits bounded audit facts and commitment references.
Long evidence remains in confined artifacts. Quarantine alerts persist until a
core disposition is verified.

### Schema evolution

Runner-owned records are strict and versioned. Active worksets do not silently
adopt new resource, environment, artifact, or coordination semantics.

## 8. Infrastructure & Environment

The Runner consumes:

- [Delegation Execution Environment](../../../standards/std-turnlock-delegation-execution-environment.md);
- [Delegation Resource Policy](../../../standards/std-turnlock-delegation-resource-policy.md);
- [Artifact Reference and Integrity](../../../standards/std-turnlock-artifact-reference-and-integrity.md);
- [Canonical JSON and Digest](../../../standards/std-turnlock-canonical-json-and-digest.md);
- [Workspace Input Commitment](../../../standards/std-turnlock-workspace-input-commitment.md);
- [Runner Coordination](../../../standards/std-turnlock-runner-coordination.md).

Version 1 uses one local certified host, local APFS roots, native processes,
process-local Pi integration, exact executable commitments, and closed provider
profiles. All limits and timing relationships come from the committed resource
policy.

## 9. Dependencies

### Parent

The parent CDD owns end-to-end terminal semantics, core resume outbox, failure
classification, retry, and manifest-v2 migration.

### Child nodes

- [Attempt Admission and Handoff](cdd-n-turnlock-attempt-admission-and-handoff.md);
- [Workset Preparation](cdd-n-turnlock-workset-preparation.md);
- [Host Intake](cdd-n-turnlock-host-intake.md);
- [Outcome and Terminal Coordination](cdd-n-turnlock-outcome-and-terminal-coordination.md);
- [Terminal Resume](cdd-n-turnlock-terminal-resume.md);
- [Quarantine Disposition](cdd-n-turnlock-quarantine-disposition.md);
- [Delivery Bridge](cdd-n-turnlock-delivery-bridge.md);
- [Workset Cleanup](cdd-n-turnlock-workset-cleanup.md).

### Strategy interface

[CDD-I Turnlock External Execution Strategy](cdd-i-turnlock-external-execution-strategy.md)
defines the worker subset only. The Pi strategy implements it without inheriting
Runner admission, ownership, intake adoption, terminal selection, resume, or
delivery responsibilities.

### External contracts

Each concrete strategy requires an exact Dependency Contract. The Pi strategy
is disabled while the current
[pi-subagents contract](../../../dependencies/dc-pi-subagents.md) records an
incompatible dependency surface.

## 10. Testing Strategy

Acceptance and property tests cover:

- deterministic namespace selection and collision quarantine;
- strategy verdict followed by complete workset-preparation-node preflight;
- zero side effects before the prepared snapshot;
- owner lease, PID reuse, clock anomaly, takeover, and stale-fence behavior;
- mutex crash recovery around every candidate and snapshot boundary;
- strategy candidate publication before selection and orphan collection;
- host-only, worker-only, and mixed worksets;
- every submission, adoption, and outcome provenance branch;
- normal, deadline, cancellation, rejection, and quarantine closure;
- partial outcome-set recovery without rewriting committed outcomes;
- mutually exclusive terminal selection;
- crash after selection and before publication;
- crash after core state advance and before Runner capture;
- duplicate resume and exact outbox re-emission;
- contiguous delivery sequence and claim recovery;
- graceful ownership handoff without stop or cancellation;
- operator abort and retention-gated quarantine cleanup;
- cleanup reference derivation and dependency retention acknowledgement;
- policy, environment, workspace, path, and dependency drift.

Permutation tests prove that completion, publication, event, and discovery order
cannot change final manifest ordering, outcome-set digest, terminal route, or
resume identity.

The document remains `draft` until every child CDD, strategy contract, permanent
standard, Dependency Contract, and crash fixture passes a fresh hostile review.

## 11. Glossary

### Current owner

Resident controller generation and secret token authorized to perform
owner-only transitions.

### Delivery sequence

Contiguous per-session ordering committed into each immutable semantic event.

### Intake gate

Irreversible publication gate deciding whether a new submission is receivable.

### Strategy-state candidate

Immutable technical-state proposal selected only through an atomic workset
transition.

### Terminal cause

Immutable evidence authorizing owner-generated deadline or cancellation
outcomes for jobs without adopted submissions.

### Terminal selection

Atomic workset decision choosing outcomes-complete or attempt-rejected. Open
quarantine deliberately chooses neither.

### Workset

Authoritative Runner snapshot and namespace for one Turnlock attempt.
