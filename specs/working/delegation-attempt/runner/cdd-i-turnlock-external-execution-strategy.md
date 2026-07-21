---
okf_version: "1.0"
kind: "RuntimeArtifact"
format: "cubits-design-doc"
workspace: "turnlock"
date: "2026-07-21"
step_id: 0
id: "CDD-I-TURNLOCK-EXTERNAL-EXECUTION-STRATEGY"
version: "0.1.0"
scope: "external-execution-strategy"
status: "draft"
consumers:
  - "agent-generator"
superseded_by: []
---

# CDD-I: Turnlock External Execution Strategy

## 1. Objectif & Position

This document defines the harness-neutral capability contract through which the
[Runner orchestration](cdd-o-turnlock-runner-execution.md) executes the worker
subset of one prepared workset.

It replaces the former broad Runner interface. Admission, handoff, owner leases,
intake ownership, adoption, final outcomes, terminal selection, core resume,
delivery, quarantine disposition, and cleanup remain generic Runner concerns and
are not implemented by a strategy.

A strategy translates committed neutral worker profiles into one concrete
execution mechanism. Mutually exclusive implementations can satisfy this
contract. The first implementation is
[CDD-S Pi Subagents Execution](../strategies/pi-subagents/cdd-s-pi-subagents-execution.md).

As a CDD-I, this document intentionally omits the Pipeline section. It defines
operations, boundaries, and invariants without prescribing their operational
sequence.

## 2. Goals & Non-Goals

### Goals

The interface provides:

- side-effect-free capability and profile preflight;
- complete pre-dispatch group and job commitments;
- one cross-strategy executor digest per worker job;
- immutable strategy-state candidate publication;
- exact external launch correlation and recovery;
- per-job technical observation;
- generic worker submission proposals;
- bounded stop and reconciliation;
- explicit digest-scoped retention release;
- explicit ambiguity reporting for Runner quarantine;
- dependency capability proof before dispatch.

### Non-goals

A strategy does not:

- admit core attempts or create workset identity;
- own the Runner lease, fence, or transaction mutex;
- execute host jobs;
- open or close intake;
- adopt submissions;
- commit final outcomes or terminal causes;
- select attempt rejection or quarantine state;
- classify retryability;
- publish at core result or terminal targets;
- invoke or inspect core resume;
- deliver host-session events;
- mutate `WorksetRecord` directly;
- claim exactly-once external execution.

## 3. Data Contracts (Inputs & Outputs)

### Preflight input

```typescript
interface ExternalStrategyPreflightInputSketch {
  readonly runnerId: string;
  readonly turnlockRunId: string;
  readonly delegationId: string;
  readonly attemptId: string;
  readonly attempt: number;
  readonly worksetId: string;
  readonly manifestDigest: PayloadDigestV1;
  readonly deadlineAtEpochMs: number;
  readonly resourcePolicyDigest: PayloadDigestV1;
  readonly environmentProfileDigest: PayloadDigestV1;
  readonly workspaceInputCommitment: WorkspaceInputCommitmentV1;
  readonly workerJobs: readonly ExternalWorkerJobInputSketch[];
}

interface ExternalWorkerJobInputSketch {
  readonly jobId: string;
  readonly prompt: string;
  readonly profileName: string;
  readonly resultContractDigest?: PayloadDigestV1;
}
```

The Runner proves attempt and workset identity before constructing this
projection. Preflight input grants no dispatch authority.

### Capability verdict output

```typescript
type StrategyCapabilityVerdictSketch =
  | {
      readonly kind: "supported";
      readonly strategyId: string;
      readonly dependencyContractId: string;
      readonly groupSpecCommitment: ArtifactCommitmentV2;
      readonly jobs: readonly StrategyJobCommitmentSketch[];
      readonly initialStateCandidate: ArtifactCommitmentV2;
    }
  | {
      readonly kind: "rejected";
      readonly proposedCode:
        | "unsupported-topology"
        | "capability-mismatch"
        | "invalid-execution-configuration"
        | "dependency-unavailable"
        | "insufficient-deadline-margin";
      readonly evidenceCommitment: ArtifactCommitmentV2;
    }
  | {
      readonly kind: "ambiguous";
      readonly evidenceCommitment: ArtifactCommitmentV2;
    };

interface StrategyJobCommitmentSketch {
  readonly jobId: string;
  readonly executorSpecDigest: PayloadDigestV1;
}
```

The Runner validates the verdict and decides whether to prepare, reject, or
quarantine. A strategy does not make that authoritative transition.

### Activation authorization

```typescript
interface StrategyActivationAuthorizationSketch {
  readonly worksetId: string;
  readonly attemptId: string;
  readonly ownerGeneration: number;
  readonly strategyId: string;
  readonly selectedStateCommitment: ArtifactCommitmentV2;
  readonly groupSpecDigest: PayloadDigestV1;
  readonly executorSpecDigests: Readonly<Record<string, PayloadDigestV1>>;
}
```

The authorization is valid only while the Runner's current workset and owner
generation still match. The owner token itself is never exposed.

### State candidate contract

```typescript
interface ExternalStrategyStateCandidateSketch<TState> {
  readonly version: 1;
  readonly strategyId: string;
  readonly worksetId: string;
  readonly revision: number;
  readonly previousCommitment?: ArtifactCommitmentV2;
  readonly operationId: string;
  readonly state: TState;
}
```

The strategy publishes candidates as immutable artifacts. The Runner alone
selects a candidate by advancing `WorksetRecord.strategyState` under the current
fence and mutex.

### Execution observation and evidence

```typescript
interface ExternalJobObservationSketch {
  readonly strategyId: string;
  readonly worksetId: string;
  readonly launchId: string;
  readonly jobId: string;
  readonly terminalState: "completed" | "failed" | "stopped";
  readonly observedAtEpochMs: number;
  readonly evidenceCommitment: ArtifactCommitmentV2;
}
```

A paused, queued, or running job is non-terminal. An observation describes
validated technical evidence; it is not a cryptographic attestation.

### Submission proposal output

```typescript
interface WorkerSubmissionProposalSketch {
  readonly strategyId: string;
  readonly worksetId: string;
  readonly attemptId: string;
  readonly jobId: string;
  readonly executorSpecDigest: PayloadDigestV1;
  readonly executionEvidenceCommitment: ArtifactCommitmentV2;
  readonly result:
    | {
        readonly status: "success";
        readonly payload: JsonValueSketch;
        readonly payloadDigest: PayloadDigestV1;
      }
    | {
        readonly status: "failure";
        readonly failureCode: ExecutionFailureCodeSketch;
        readonly message: string;
        readonly diagnosticRef?: ArtifactRefV2;
      };
}
```

The generic Runner publisher revalidates intake, deadline, workspace,
eligibility, and conflict under its mutex. The strategy cannot bypass that
publisher.

### Stop and reconciliation

```typescript
interface StrategyReconciliationRequestSketch {
  readonly worksetId: string;
  readonly attemptId: string;
  readonly strategyId: string;
  readonly selectedStateCommitment: ArtifactCommitmentV2;
  readonly cause:
    | "deadline-reached"
    | "cancelled-by-user"
    | "attempt-rejected"
    | "quarantined";
  readonly stopRequested: boolean;
  readonly reconciliationDeadlineAtEpochMs: number;
}

interface StrategyReconciliationReportSketch {
  readonly strategyId: string;
  readonly stateCandidateCommitment: ArtifactCommitmentV2;
  readonly completedObservationCommitments: readonly ArtifactCommitmentV2[];
  readonly unresolvedExecutionCommitments: readonly ArtifactCommitmentV2[];
  readonly evidenceCommitment: ArtifactCommitmentV2;
}
```

Graceful controller handoff is not a stop cause.

### Retention release

```typescript
interface StrategyRetentionReleaseRequestSketch {
  readonly strategyId: string;
  readonly worksetId: string;
  readonly callerExecutionKey: string;
  readonly evidenceDigests: Readonly<Record<string, string>>;
}

interface StrategyRetentionReleaseReceiptSketch {
  readonly strategyId: string;
  readonly callerExecutionKey: string;
  readonly acknowledgedEvidenceDigests: Readonly<Record<string, string>>;
  readonly earliestCleanupAtEpochMs: number;
  readonly receiptCommitment: ArtifactCommitmentV2;
}
```

The strategy acknowledges only exact evidence no longer referenced by generic
Runner state. Reading or observing evidence never implies release.

## 5. Invariants

1. Preflight has no external execution side effect.
2. Every requested worker is either completely supported or the whole strategy
   projection is rejected.
3. Group and executor commitments contain only pre-dispatch known inputs.
4. Runtime identities, paths, timestamps, fallback observations, and provider
   results do not alter executor commitments.
5. A state candidate has no authority until selected by the workset.
6. External side effects require a selected dispatch-intent candidate.
7. Exactly one strategy-defined launch can be eligible to publish for a worker
   consistency unit.
8. A strategy never receives an owner token, final core target, or resume
   operation.
9. Raw external output is not a generic submission.
10. A worker submission reports facts and never carries `retryable`.
11. Identity or eligibility ambiguity requests quarantine rather than an
    ordinary execution failure.
12. Stop and reconciliation are bounded by the committed resource policy.
13. Graceful controller shutdown does not stop strategy execution.
14. External evidence remains retained until an exact release request receives
    a durable receipt.
15. Dependency behavior is accepted only through an active compatible
    Dependency Contract.

## 6. Internal Operations

### Capability evaluation

The capability operation evaluates exact dependency contract identity,
operation classes, durable launch correlation, result retention, status, stop,
profile resolution, topology, resource bounds, workspace compatibility, and
provider readiness. It returns one closed verdict without mutating Runner state.

### Commitment production

The commitment operation produces one group commitment and one executor digest
per job. Equal committed inputs converge. Any changed profile, task, model
selector, permission, tool, workspace, environment, policy, or result contract
changes the applicable digest.

### Candidate proposal

A proposal names the expected prior commitment and next revision. The operation
cannot overwrite an existing candidate or select itself. A divergent candidate
for one operation identity is a strategy conflict.

### Dispatch

Dispatch requires a fresh Runner authorization proving that the dispatch-intent
candidate is selected. The strategy must obtain durable caller-correlated
acknowledgement before reporting a launch as bound.

### Observation

Observation combines live hints with durable dependency evidence. Live events
alone cannot establish stable terminality. Missing required output, malformed
output, provider exhaustion, and technical failure map to closed factual
failure codes. Authority ambiguity remains distinct.

### Submission publication operation

The proposal operation constructs immutable strategy evidence and asks the
Runner publisher to publish. A late or closed-intake response does not reopen
intake or become strategy-local success.

### Reconciliation operation

Reconciliation identifies exact existing execution, stop outcome, terminal
observations, and unresolved known orphans. Zero, one, and multiple candidate
cases remain explicit. It never selects by timestamp or directory order.

### Retention release operation

The strategy compares the complete requested evidence-digest set with retained
external evidence and returns an immutable receipt. Missing, extra, or divergent
digests fail closed. A retry with the identical request converges on the same
receipt.

## 7. Cross-Cutting Concerns

### Idempotence

Capability verdicts, commitments, operation IDs, state revisions, launch
correlations, observations, evidence, and submission proposals have stable
identities. Identical repeats converge; divergent repeats conflict.

### Security

A strategy receives only the worker subset and trusted runtime bindings. It
cannot read arbitrary host paths, elevate tool permissions from manifest input,
or expose credentials in commitments and diagnostics.

### Observability

Bounded events cover capability, commitment, candidate, dispatch,
acknowledgement, observation, publication, stop, reconciliation, ambiguity, and
cleanup evidence. Events are not strategy-state authority.

### Evolution

A dependency version changing operation behavior, durable visibility,
correlation, terminal states, result retention, or stop semantics requires a new
Dependency Contract and compatibility decision.

## 8. Infrastructure & Environment

Every implementation consumes the exact environment and resource standards:

- [Delegation Execution Environment](../../../standards/std-turnlock-delegation-execution-environment.md);
- [Delegation Resource Policy](../../../standards/std-turnlock-delegation-resource-policy.md);
- [Artifact Reference and Integrity](../../../standards/std-turnlock-artifact-reference-and-integrity.md);
- [Canonical JSON and Digest](../../../standards/std-turnlock-canonical-json-and-digest.md);
- [Workspace Input Commitment](../../../standards/std-turnlock-workspace-input-commitment.md).

A strategy may add stricter requirements but cannot weaken these contracts.
Remote execution remains admissible only when a durable local integration
surface preserves every generic operation and recovery guarantee.

## 9. Dependencies

The interface depends on the parent Runner CDD-O and permanent standards only.
Each CDD-S declares its exact external Dependency Contract.

The Pi implementation depends on
[DC-PI-SUBAGENTS](../../../dependencies/dc-pi-subagents.md). That contract
currently proves the inspected fork incompatible; therefore Pi preflight must
reject until a compatible release supersedes it.

## 10. Testing Strategy

Every strategy conformance suite must prove:

- side-effect-free negative preflight;
- complete commitment coverage and digest sensitivity;
- exclusion of runtime observations from pre-dispatch digests;
- candidate powerlessness before Runner selection;
- no dispatch without fresh selection authorization;
- exact caller-correlated acknowledgement;
- zero, one, and multiple recovery candidates;
- non-destructive durable results;
- per-job success and every closed factual failure;
- paused jobs remain non-terminal;
- publication before and after intake closure;
- stop success, timeout, and unresolved orphan reporting;
- graceful handoff without a stop request;
- exact retention release and divergent receipt rejection;
- ambiguity requests quarantine;
- absence of owner tokens, final targets, resume operations, and retry flags.

The same generic fixtures must run against every CDD-S. Strategy-specific tests
add dependency and lifecycle cases without weakening interface assertions.

## 11. Glossary

### Capability verdict

Side-effect-free proof that one strategy can or cannot satisfy the complete
worker subset.

### Executor commitment

Canonical pre-dispatch intent governing one worker job.

### External execution strategy

Mutually exclusive harness-specific implementation of worker execution,
observation, and submission proposal.

### Reconciliation

Bounded recovery operation that compares selected strategy state with durable
external evidence.

### State candidate

Immutable proposed strategy snapshot requiring Runner selection before it gains
authority.

### Submission proposal

Strategy-produced factual result passed through the generic Runner publication
boundary.
