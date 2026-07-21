---
okf_version: "1.0"
kind: "RuntimeArtifact"
format: "cubits-design-doc"
workspace: "turnlock"
date: "2026-07-21"
step_id: 0
id: "CDD-I-TURNLOCK-RUNNER-WORKSET-CONTRACT"
version: "0.1.0"
scope: "runner-workset-contract"
status: "draft"
consumers:
  - "agent-generator"
superseded_by: []
---

# CDD-I: Turnlock Runner Workset Contract

## 1. Objectif & Position

### 1.1 Document status

This document defines the harness-neutral interface implemented by a Turnlock
Runner and its execution strategies.

It is a child of
[CDD-O: Turnlock Delegation Attempt
Execution](cdd-o-turnlock-delegation-attempt-execution.md).
The parent owns end-to-end topology, core authority, identity hierarchy, retry
semantics, and global invariants. This document owns the Runner-side functional
contract only.

The first strategy will be `CDD-S-PI-SUBAGENTS-EXECUTION`. Agent names, model
resolution, launch states, Pi RPC operations, and Pi lifecycle schemas are
outside this interface CDD.

This extraction remains `draft` until the complete three-document CDD corpus
passes a hostile review. Typed interfaces are non-normative sketches; NIBs own
exact schemas, algorithms, filenames, constants, and error classes.

The corpus extraction sequence is documented in
[Turnlock Delegation Attempt Specification Restructuring
Plan](../../docs/delegation-attempt-specification-restructuring-plan.md).

As a CDD-I, this document intentionally has no `Pipeline` section. Concrete
operational pathways belong to strategy CDDs and NIBs.

### 1.2 System position

A Turnlock Runner sits between a terminating Turnlock process and a resident
harness controller.

```text
Turnlock core process
  -> one validated protocol result

Runner invocation
  -> durable handoff or terminal delivery event

Resident controller
  -> workset coordination
  -> host delivery and external strategy execution
  -> final outcomes
  -> attempt resume
```

The Runner does not become a workflow engine. Turnlock core remains the only
owner of FSM progression and retry policy. The Runner coordinates one external
execution projection for one committed Turnlock attempt.

The same interface can be implemented by different harness strategies. A
strategy translates neutral worker profiles into concrete execution without
changing the workset contract.

### 1.3 Interface objective

The interface provides a durable, fail-closed boundary that:

- accepts one core-committed delegation attempt;
- validates all external execution requirements before dispatch;
- persists one Runner workset snapshot;
- transfers ownership durably to a resident controller;
- accepts unprivileged host and worker submissions;
- adopts submissions only under the current fence;
- commits one immutable final outcome per manifest job;
- evaluates an all-terminal barrier;
- resumes exactly the current attempt through the core-provided command;
- recovers every stable transition after process or controller failure.

### 1.4 Actors

#### Core process

The core process produces a protocol result and authoritative attempt artifacts.
The Runner validates them but never rewrites core state or manifests.

#### Runner invocation

A Runner invocation is a short process that starts or resumes the core,
validates its one protocol result, and publishes a durable handoff or terminal
notification. It does not remain alive to supervise external jobs.

#### Resident controller actor

The resident controller holds the owner lease, coordinates active worksets,
invokes execution strategies, adopts submissions, commits outcomes, and starts
resume invocations. Only this actor performs owner-only transitions.

#### Host-session producer

The host session receives at most one host job. It writes a payload into a fixed
Runner staging location and invokes a Runner-owned submission command. It
receives no fence, final result path authority, or resume authority.

#### External strategy

An external strategy resolves neutral worker profiles and manages concrete
external execution. It can publish worker submissions through the Runner
contract but cannot commit final outcomes or decide retry policy.

#### External worker

An external worker produces strategy-specific raw output. Raw output remains
outside the Turnlock submission boundary until the strategy validates and
publishes a worker submission.

#### Delivery bridge

The bridge delivers durable Runner events into one harness session. Delivery is
at-least-once and sequential per session. Delivery success does not itself prove
semantic job completion.

## 2. Goals & Non-Goals

### 2.1 Goals

The Runner interface establishes:

- one durable workset per Turnlock attempt;
- one scoped source of truth for Runner coordination;
- one current controller protected by fencing;
- one transaction boundary shared by owner transitions and submission
  publication;
- one common intake contract for host and worker paths;
- immutable submission and outcome identities;
- recoverable per-job outcome commit;
- deterministic all-terminal join;
- durable attempt-oriented resume;
- durable handoff and at-least-once host delivery;
- a closed strategy interface that does not leak harness details into core or
  generic Runner state.

### 2.2 Non-goals

The interface does not provide:

- an external execution scheduler;
- strategy-specific launch, process, model, or lifecycle schemas;
- exactly-once external execution;
- simultaneous host and worker start;
- distributed multi-host coordination;
- workspace snapshots;
- adversarial isolation from a same-user shell actor;
- targeted job retry;
- partial-success workflow continuation;
- automatic executor fallback;
- business payload validation;
- protection from a dependency that violates its durable artifact contract;
- a new Turnlock protocol kind;
- core-level live workset state.

### 2.3 Inherited constraints

The interface inherits these constraints from CDD-O without redefining them:

- the core protocol remains `prompt | batch`;
- worksets exist only in the Runner layer;
- one workset maps to one `attemptId`;
- workers never receive controller authority;
- submissions are proposals, not final outcomes;
- only the current owner adopts, commits, joins, and resumes;
- final execution terminality accepts success and failure outcomes;
- the core alone classifies failures and advances the FSM;
- external execution is at-least-once;
- final outcome commit is idempotent for identical content and fail-closed for
  divergent content;
- version 1 supports at most one host job and one external strategy group;
- shared workspace access during overlap is cooperatively read-only.

## 3. Data Contracts (Inputs & Outputs)

### 3.1 Delegation attempt input

The Runner consumes the attempt committed by Turnlock core and defined by
CDD-O.

```typescript
interface RunnerAttemptInputSketch {
  readonly turnlockRunId: string;
  readonly delegationId: string;
  readonly attemptId: string;
  readonly attempt: number;

  readonly manifestVersion: 3;
  readonly manifestRef: ArtifactRefSketch;
  readonly manifestDigest: PayloadDigestSketch;
  readonly resultEnvelopeVersion: 1;

  readonly deadlineAtEpochMs: number;
  readonly jobs: readonly RunnerManifestJobSketch[];
  readonly resumeCommandCommitment: ResumeCommandCommitmentSketch;
}
```

The Runner cross-validates protocol result, core state, manifest, result paths,
run identity, delegation identity, and attempt identity before creating a
workset.

### 3.2 Manifest job input

```typescript
interface RunnerManifestJobSketch {
  readonly id: string;
  readonly prompt: string;
  readonly target:
    | { kind: "host" }
    | { kind: "worker"; profile: string }
    | { kind: "direct"; profile: string };
  readonly resultPath: string;
  readonly resultContractId?: string;
}
```

Manifest job order is authoritative for final outcome loading and successful
payload delivery to the core.

### 3.3 Runner configuration input

Runner configuration supplies deployment and policy inputs not owned by one
attempt:

- Runner identity;
- harness session identity;
- Runner storage root;
- project and workspace logical roots;
- adapter strategy selection;
- closed target profile registry;
- result size limits;
- owner lease policy;
- bounded invocation, delivery, and termination limits.

Configuration is validated before core execution or external dispatch. Secrets
and owner tokens are not embedded in versioned configuration.

### 3.4 Workspace input commitment

```typescript
interface WorkspaceInputCommitmentSketch {
  readonly policyDigest: PayloadDigestSketch;
  readonly manifestDigest: PayloadDigestSketch;
}
```

The workspace policy closes included roots, exclusions, untracked files,
ignored files, and submodule treatment. Every executor commitment references the
same workspace input commitment when jobs share the workspace.

Logical workspace identity and relative working directory are committed inputs.
Resolved absolute paths are runtime bindings.

### 3.5 Workset output

`WorksetRecord` is the authoritative Runner coordination snapshot for one
attempt.

```typescript
interface WorksetRecordSketch {
  readonly version: 1;
  readonly worksetId: string;
  readonly runnerId: string;

  readonly turnlockRunId: string;
  readonly delegationId: string;
  readonly attemptId: string;
  readonly attempt: number;

  readonly manifestRef: ArtifactRefSketch;
  readonly manifestDigest: PayloadDigestSketch;
  readonly resultEnvelopeVersion: 1;
  readonly deadlineAtEpochMs: number;

  readonly state: WorksetStateSketch;
  readonly ownerGeneration: number;
  readonly intake: IntakeRecordSketch;
  readonly workspaceInputCommitment: WorkspaceInputCommitmentSketch;

  readonly jobs: readonly WorksetJobRecordSketch[];
  readonly hostTicketRef?: ArtifactRefSketch;
  readonly strategyStateRef?: ArtifactRefSketch;

  readonly join: JoinRecordSketch;
  readonly resume: ResumeRecordSketch;
  readonly createdAt: string;
  readonly updatedAt: string;
}
```

The record contains no core business state, strategy-specific lifecycle state,
or raw secret material.

The join and resume projections are:

```typescript
interface JoinRecordSketch {
  readonly state: "pending" | "committed";
  readonly outcomeSetDigest?: PayloadDigestSketch;
  readonly committedAtEpochMs?: number;
}

interface ResumeRecordSketch {
  readonly state: "not-started" | "in-progress" | "completed";
  readonly invocationId?: string;
  readonly protocolResultRef?: ArtifactRefSketch;
  readonly startedAtEpochMs?: number;
  readonly completedAtEpochMs?: number;
}

interface ResumeCommandCommitmentSketch {
  readonly command: string;
  readonly commandDigest: PayloadDigestSketch;
}
```

Optional fields are present only in the corresponding active or completed
state. Exact state-dependent schema unions belong to the NIB.

### 3.6 Workset state

```typescript
type WorksetStateSketch =
  | "prepared"
  | "active"
  | "intake-closed"
  | "outcomes-committed"
  | "resuming"
  | "resumed"
  | "quarantined";
```

Expected execution failures do not place a workset in `quarantined`. They become
valid failure outcomes and continue through `outcomes-committed` and resume.

`quarantined` is reserved for a Runner invariant or protocol condition that
cannot safely produce or consume normal outcomes.

### 3.7 Workset job record

```typescript
interface WorksetJobRecordSketch {
  readonly jobId: string;
  readonly targetKind: "host" | "worker" | "direct";
  readonly executorSpecDigest: PayloadDigestSketch;

  readonly submissionState:
    | "awaiting"
    | "adopted";
  readonly submissionRef?: ArtifactRefSketch;

  readonly outcomeState:
    | "absent"
    | "committed";
  readonly outcomeRef?: ArtifactRefSketch;
}
```

A record never infers adoption or outcome commit solely from an in-memory event.
The publisher writes only the immutable submission artifact. The current owner
sets `submissionState` and `submissionRef` when it validates and adopts that
artifact under the owner fence.

Stable artifact evidence and the snapshot agree before a transition commits.

### 3.8 Intake record

```typescript
interface IntakeRecordSketch {
  readonly state: "open" | "closed";
  readonly closedAtEpochMs?: number;
  readonly closeReason?:
    | "all-submissions-received"
    | "deadline-reached"
    | "cancelled-by-user"
    | "quarantined";
}
```

Intake closure is irreversible for one attempt.

The owner lease and short transaction mutex are separate authority and ordering
contracts:

```typescript
interface OwnerLeaseSketch {
  readonly version: 1;
  readonly runnerId: string;
  readonly sessionKey: string;
  readonly generation: number;
  readonly ownerToken: string;
  readonly ownerProcessRef: string;
  readonly acquiredAtEpochMs: number;
  readonly heartbeatAtEpochMs: number;
  readonly leaseUntilEpochMs: number;
}

interface TransactionMutexSketch {
  readonly version: 1;
  readonly scopeRef: string;
  readonly holderId: string;
  readonly acquiredAtEpochMs: number;
  readonly leaseUntilEpochMs: number;
}
```

The owner token is secret control data. The mutex holder identity prevents an
older process from releasing a successor's mutex instance.

### 3.9 Executor commitment

Before dispatch, the Runner resolves every neutral target into a complete
pre-dispatch executor commitment or rejects the whole workset.

Every job stores one `executorSpecDigest` with the cross-strategy meaning defined
by CDD-O. Runtime bindings and observations never enter that digest.

A profile name alone is not an executor commitment.

### 3.10 Host ticket

```typescript
interface HostSubmissionTicketSketch {
  readonly version: 1;
  readonly ticketId: string;
  readonly turnlockRunId: string;
  readonly delegationId: string;
  readonly attemptId: string;
  readonly worksetId: string;
  readonly jobId: string;
  readonly executorSpecDigest: PayloadDigestSketch;
  readonly resultContractDigest?: PayloadDigestSketch;
  readonly stagingInputRef: ArtifactRefSketch;
  readonly issuedAtEpochMs: number;
  readonly expiresAtEpochMs: number;
}
```

The ticket contains no owner token, fence generation, agent-selected source
path, final result path, or resume command.

### 3.11 Job submission

Host and worker producers publish one common logical artifact family.

```typescript
interface JobSubmissionHeaderSketch {
  readonly version: 1;
  readonly turnlockRunId: string;
  readonly delegationId: string;
  readonly attemptId: string;
  readonly worksetId: string;
  readonly jobId: string;
  readonly executorSpecDigest: PayloadDigestSketch;
  readonly publishedAtEpochMs: number;
}

interface SubmittedSuccessSketch {
  readonly status: "success";
  readonly payload: JsonValueSketch;
  readonly payloadDigest: PayloadDigestSketch;
}

interface SubmittedFailureSketch {
  readonly status: "failure";
  readonly failureCode: ExecutionFailureCodeSketch;
  readonly message: string;
  readonly evidenceRef?: ArtifactRefSketch;
}

type SubmittedResultSketch =
  | SubmittedSuccessSketch
  | SubmittedFailureSketch;

interface HostJobSubmissionSketch {
  readonly header: JobSubmissionHeaderSketch;
  readonly source: {
    readonly kind: "host";
    readonly ticketId: string;
  };
  readonly result: SubmittedSuccessSketch;
}

interface WorkerJobSubmissionSketch {
  readonly header: JobSubmissionHeaderSketch;
  readonly source: {
    readonly kind: "worker-strategy";
    readonly strategyId: string;
    readonly executionRef: ArtifactRefSketch;
  };
  readonly result: SubmittedResultSketch;
}

type JobSubmissionEnvelopeSketch =
  | HostJobSubmissionSketch
  | WorkerJobSubmissionSketch;
```

A host submission identifies its ticket. A worker submission identifies the
strategy-specific execution evidence that produced it.

A host submission proposes only a successful payload. Missing host completion
is terminalized by the current owner under an explicit deadline or quarantine
rule. A worker submission can propose a successful payload or an observed
execution failure.

No submission grants adoption or commit authority. `JsonValueSketch` denotes the
strict JSON value domain inherited from CDD-O.

### 3.12 Final outcome

The current owner constructs final outcomes from adopted submissions or an
explicitly authorized owner-generated terminal condition.

The contact types project parent-owned identity and failure contracts without
changing their authority:

```typescript
interface CoreOutcomeIdentitySketch {
  readonly turnlockRunId: string;
  readonly delegationId: string;
  readonly attemptId: string;
  readonly attempt: number;
  readonly jobId: string;
  readonly manifestVersion: 3;
  readonly manifestDigest: PayloadDigestSketch;
  readonly resultEnvelopeVersion: 1;
}

interface RunnerOutcomeIdentitySketch {
  readonly worksetId: string;
  readonly executorSpecDigest: PayloadDigestSketch;
  readonly executionRef: ArtifactRefSketch;
}

type ExecutionFailureCodeSketch =
  | "executor-unavailable"
  | "provider-exhausted"
  | "deadline-exceeded"
  | "invalid-executor-output"
  | "budget-exceeded"
  | "protocol-failure"
  | "configuration-drift"
  | "cancelled-by-user"
  | "unknown";

type JsonValueSketch =
  | null
  | boolean
  | number
  | string
  | readonly JsonValueSketch[]
  | { readonly [key: string]: JsonValueSketch };

type JobOutcomeEnvelopeSketch<T> =
  | {
      readonly version: 1;
      readonly status: "success";
      readonly coreIdentity: CoreOutcomeIdentitySketch;
      readonly runnerIdentity: RunnerOutcomeIdentitySketch;
      readonly payload: T;
      readonly payloadDigest: PayloadDigestSketch;
      readonly completedAt: string;
    }
  | {
      readonly version: 1;
      readonly status: "failure";
      readonly coreIdentity: CoreOutcomeIdentitySketch;
      readonly runnerIdentity: RunnerOutcomeIdentitySketch;
      readonly failureCode: ExecutionFailureCodeSketch;
      readonly message: string;
      readonly diagnosticRef?: ArtifactRefSketch;
      readonly completedAt: string;
    };
```

Each outcome is committed at the exact manifest-defined result path. Host and
strategy actors never choose or write that path directly.

### 3.13 Durable handoff output

A handoff record proves that a short Runner invocation transferred
responsibility to the resident controller or published a terminal event.

```typescript
interface DurableHandoffSketch {
  readonly version: 1;
  readonly runnerId: string;
  readonly invocationId: string;
  readonly ownerGeneration: number;
  readonly attemptId?: string;
  readonly eventRef: ArtifactRefSketch;
  readonly eventDigest: PayloadDigestSketch;
  readonly publishedAtEpochMs: number;
}
```

A convenience handoff file can index that proof but is not the sole authority.

### 3.14 Delivery journal output

The delivery journal records immutable events, independent claim metadata, and
delivered evidence.

```typescript
interface DeliveryEventSketch {
  readonly version: 1;
  readonly eventId: string;
  readonly runnerId: string;
  readonly sessionKey: string;
  readonly invocationId: string;
  readonly ownerGeneration: number;
  readonly semanticDedupeKey: string;
  readonly semanticDigest: PayloadDigestSketch;
  readonly eventKind:
    | "host-continuation"
    | "turnlock-terminal"
    | "runner-error"
    | "turnlock-aborted";
  readonly payloadRef: ArtifactRefSketch;
  readonly createdAtEpochMs: number;
}

interface DeliveryClaimSketch {
  readonly version: 1;
  readonly eventId: string;
  readonly claimantId: string;
  readonly claimedAtEpochMs: number;
  readonly leaseUntilEpochMs: number;
}
```

A deduplication index is derived and repairable from the delivered journal.

### 3.15 Artifact reference

Runner artifacts use typed relative or content-addressed references.

```typescript
type ArtifactRefSketch =
  | {
      readonly kind: "runner-relative";
      readonly path: string;
    }
  | {
      readonly kind: "content-addressed";
      readonly digest: PayloadDigestSketch;
    };
```

Absolute host paths remain runtime bindings and are never portable identity.
Exact path validation and safe-open mechanics are deferred to the NIBs.

### 3.16 Digest

```typescript
interface PayloadDigestSketch {
  readonly canonicalization: "rfc8785";
  readonly digestAlgorithm: "sha256";
  readonly value: `sha256:${string}`;
}
```

The digest contract is inherited from CDD-O and applies to manifests, payloads,
executor specs, workspace commitments, submissions, outcomes, and semantic
events.

### 3.17 Strategy interface output

Before dispatch, an execution strategy produces:

- a capability verdict;
- a closed pre-dispatch group commitment;
- one closed pre-dispatch job commitment per worker job;
- one deterministic executor spec digest per job;
- a declaration that the requested topology is supported.

During execution, the strategy persists strategy-specific runtime state behind
a typed reference and publishes generic worker submissions.

## 5. Invariants

### 5.1 Snapshot authority

`WorksetRecord` is atomically replaced at every stable Runner transition. An
event log can explain history but cannot reconstruct authority by replay alone.

### 5.2 Workset identity

Exactly one workset identity corresponds to one Runner and one `attemptId`.
Recreating the identity with identical committed content is idempotent. The same
identity with different committed content is a terminal collision.

### 5.3 Workset state machine

The stable state semantics are:

- `prepared`: preflight and executor commitments are durable; no unrecorded
  external dispatch is permitted;
- `active`: responsibility is durably transferred, intake is open, and external
  production is permitted;
- `intake-closed`: no new submission is receivable, while published submissions
  can still be adopted;
- `outcomes-committed`: one valid immutable final outcome exists for every job;
- `resuming`: one current-owner invocation is executing the committed core
  resume command;
- `resumed`: the resume protocol result is validated and durably handed off or
  delivered;
- `quarantined`: automatic progress is stopped and evidence is preserved.

No expected execution failure maps to `quarantined` merely because a job failed.

### 5.4 Owner fencing

One recoverable owner lease identifies the current controller for one logical
Runner session. Active worksets reference its generation.

The lease carries a monotonic generation and opaque token. Every owner-only
transition reloads the lease and workset under the transaction mutex and
compares both values.

An old controller that returns after takeover can acquire a mutex but fails
owner transition authorization.

### 5.5 Owner-only transitions

Only the current owner can:

- activate a prepared workset;
- adopt a submission;
- close intake;
- commit a final outcome;
- commit the all-terminal join;
- authorize strategy execution replacement when the strategy permits it;
- initiate and complete attempt resume;
- quarantine or finalize cleanup.

### 5.6 Owner token confinement

The owner token can appear only in controller-owned artifacts required to
verify ownership. It never appears in:

- host tickets;
- host continuation content;
- submissions;
- final outcomes;
- worker prompts;
- human-facing diagnostics;
- semantic event digests.

### 5.7 Transaction mutex

One short recoverable mutex type serializes workset transitions and submission
publication. Acquiring it does not grant owner authority.

A validated host command or strategy publisher can use it for an unprivileged
submission transaction. It cannot perform owner-only transitions.

A newer mutex holder is never released or deleted by an older process.

### 5.8 Transaction post-condition

Every stable snapshot references only artifacts that exist and validate.
Temporary or partially written files never become authoritative references.

A crash after immutable artifact publication but before snapshot advancement is
recoverable by validating and adopting the artifact. A crash before publication
leaves no stable artifact.

### 5.9 Intake

A result becomes receivable only when its immutable submission is atomically
published under the transaction mutex while intake is open and before the
attempt deadline.

A raw executor output is not a submission. Intake closure is irreversible.

After closure:

- no new submission is receivable;
- already published submissions remain adoptable;
- the current owner can create only explicitly authorized terminal outcomes.

### 5.10 Host topology

A version 1 workset contains zero or one host job. The host job is independent
from every worker job in the same attempt.

The host receives only its task, fixed staging location, opaque ticket identity,
and Runner-owned submission command. It never receives worker scheduling or
resume responsibility.

### 5.11 Worker strategy boundary

Only the selected strategy translates raw external output into a worker
submission. An external worker cannot write a generic Runner submission or final
outcome directly.

The strategy reports observed failure facts and a closed failure code. It never
sets a `retryable` flag or classifies core retry policy.

### 5.12 Submission eligibility

Adoption validates core identity, Runner identity, executor commitment, source
identity, workspace commitment, payload or failure shape, evidence digests, and
strategy-specific execution eligibility.

The generic Runner requires an eligibility verdict; the strategy CDD owns its
runtime mechanism.

### 5.13 Submission idempotence

Identical canonical submissions under one identity converge. Divergent
submissions produce a conflict and cannot be selected by arrival order.

### 5.14 Adoption durability

Adoption is current-owner-only and recorded durably. A strategy execution cannot
be replaced after an adopted submission when that strategy defines the
execution as one consistency unit.

### 5.15 Final outcome immutability

Conceptual behavior is:

```text
outcome absent
  -> atomic immutable commit

same canonical outcome digest
  -> idempotent success

different canonical outcome digest
  -> result conflict
```

A crash during the outcome set can leave a valid partial set. Recovery retains
valid committed outcomes and commits only missing outcomes from adopted
evidence.

### 5.16 All-terminal join

The join is satisfied only when every manifest job has one committed, strictly
valid final outcome. Success and failure outcomes both satisfy execution
terminality.

Job and outcome order follows the core manifest. Completion, submission, and
event order cannot change the join.

The join does not validate business payload schemas or classify failure
retryability.

### 5.17 Resume

`attemptId`, not workset identity or a worker-produced token, selects resume.
Before execution, the Runner verifies the attempt, committed join, current owner,
core pending state, manifest digest, and resume state.

The Runner executes exactly the core-committed `resumeCmd`; it does not
reconstruct that command from worker input or mutable defaults.

### 5.18 Durable handoff

Responsibility transfers only after immutable handoff evidence is durably
published. A convenience index or process-memory flag cannot prove transfer by
itself.

Runner errors are published while invocation serialization remains held, with no
release-then-publish window.

### 5.19 Delivery

Bridge delivery is at-least-once and sequential per session. Immutable semantic
events have separate mutable claim metadata. The delivered journal is
authoritative; the dedupe index is derived.

External scheduling and raw lifecycle notifications are strategy-internal and
are never injected into the host session as Runner control instructions.

### 5.20 Refencing

A successor never republishes a stale event by only replacing its token. It
revalidates current core state, attempt, workset, and delivery evidence first.

### 5.21 Workspace commitment

The same closed workspace input commitment is checked:

1. before external dispatch;
2. before submission publication or adoption;
3. before final join commitment.

A mismatch is configuration drift. It is not refreshed under the same attempt.

Shared host and worker execution is cooperatively read-only. Runner staging and
control data remain outside committed workspace input roots or in one explicitly
excluded Runner namespace.

### 5.22 Strict internal records

Runner-owned records reject unknown fields for their declared version. Schema
evolution uses explicit versions and migrations.

External strategy artifacts are extension-tolerant only under their Dependency
Contract. Unknown fields never excuse missing required fields, invalid types,
impossible states, or incompatible versions.

## 6. Internal Operations

### 6.1 Validate core invocation result

The operation accepts exactly one compatible Turnlock protocol block and
cross-validates it with process exit, signal, and transport status.

No block, multiple blocks, incompatible versions, or process/protocol mismatch
fail closed.

### 6.2 Create workset

The operation validates core attempt identity, manifest, exact result paths,
workspace commitment, topology, strategy capabilities, and executor specs before
persisting `prepared`.

No host continuation or external execution starts before the complete prepared
snapshot commits.

### 6.3 Transfer responsibility

The operation publishes durable handoff evidence and then allows the resident
controller to move the workset from `prepared` to `active` under the owner
fence.

An ambiguous handoff return is resolved from the durable journal and owner
lease, not from process memory.

### 6.4 Deliver host continuation

The operation publishes one immutable host continuation event carrying only the
host task and submission instructions. At-least-once redelivery is safe because
the ticket identity and submission digest are stable.

### 6.5 Publish host submission

The Runner-owned command accepts only the opaque ticket identity. It resolves
all authority from Runner records.

Under the transaction mutex it verifies ticket, attempt, host job, open intake,
deadline, executor commitment, workspace commitment, bounded strict input, and
submission conflict before immutable publication.

It performs no owner-only transition.

### 6.6 Publish worker submission

The selected strategy validates raw external evidence and, under the same mutex
contract, verifies attempt, worker job, executor commitment, strategy execution
eligibility, intake, deadline, workspace commitment, normalized result, and
submission conflict.

Raw output created before the deadline but published after intake closure is not
receivable in version 1.

### 6.7 Close intake normally

The current owner closes intake after one receivable terminal submission exists
for every expected job and the final workspace drift check succeeds.

### 6.8 Close intake at deadline

The current owner:

1. acquires the transaction mutex;
2. reloads and fence-checks the workset;
3. performs the final submission scan;
4. commits irreversible deadline closure;
5. releases the mutex;
6. requests strategy-specific stop or interrupt;
7. performs bounded reconciliation;
8. records unresolved execution for orphan cleanup;
9. creates final `deadline-exceeded` outcomes for missing jobs.

No worker or synthetic failure submission is published after closure.

#### User cancellation

A validated user cancellation signal follows the same close-first ordering. The
owner commits the `cancelled-by-user` intake reason, requests bounded strategy
stop, and creates `cancelled-by-user` outcomes for unresolved jobs. The complete
outcome set resumes the core, whose aggregate classification is `abort`.

### 6.9 Quarantine

A Runner invariant that prevents safe completion closes intake with the
`quarantined` reason, requests bounded strategy stop, and preserves evidence. It
does not fabricate ordinary failure outcomes or automatically resume the core.

### 6.10 Adopt submission

The publisher writes only the immutable submission artifact. The current owner
performs the complete eligibility and integrity validation set under the
transaction mutex, then records the submission reference and adoption in one
owner-only stable transition.

Repeated handling of identical evidence converges. Divergence quarantines the
workset.

### 6.11 Commit final outcome

The owner constructs a final success or failure envelope, validates both identity
families, resolves the exact manifest path, and performs an immutable commit.

Already committed identical content succeeds idempotently. Divergent content is
preserved as conflict evidence and never overwritten.

### 6.12 Commit join

The owner verifies the complete outcome set, current fence, workspace
commitment, and stable manifest ordering before committing
`outcomes-committed`.

### 6.13 Resume attempt

The owner records `resuming`, selects the attempt, cross-validates core pending
state, and starts a short Runner invocation that executes the core command
commitment.

The state becomes `resumed` only after the resulting protocol output is
validated and durably handed off or delivered.

A replacement `DELEGATE` creates a new attempt and workset. No old workset
artifact becomes current for it.

### 6.14 Claim and deliver event

The bridge claims an immutable event using separate recoverable metadata,
delivers events sequentially, moves successful claims into the delivered
journal, and updates the derived dedupe index.

Interrupted or expired claims remain recoverable without mutating event semantic
identity.

### 6.15 Recover owner

A successor proves takeover eligibility under the owner lease policy, increments
generation, creates a new token, commits ownership, and only then reconciles
worksets and journal claims.

### 6.16 Reconcile workset

Recovery validates the snapshot and every referenced artifact, repairs only
derived indexes, adopts valid immutable submissions, completes missing outcomes
from adopted evidence, recomputes join, and resumes only the current pending
attempt.

It never reconstructs authority from events alone.

### 6.17 Cleanup

Cleanup is idempotent and reference-aware. It removes artifacts only after
terminal state proves they are no longer required for pending resume, delivery,
quarantine, or diagnostics.

### 6.18 Failure behavior matrix

#### Attempt identity mismatch

Reject before workset creation or resume. Never attach execution to a merely
similar manifest path.

#### Workset collision

Treat identical committed content as idempotent. Quarantine different content
under the same identity.

#### Active owner conflict

Reject takeover while the current lease remains valid under policy.

#### Stale owner mutation

Abort after fence comparison and commit no owner transition.

#### Abandoned transaction mutex

Recover the bounded mutex, preserve already published immutable artifacts, and
reconstruct the stable snapshot relation.

#### Workset snapshot corruption

Quarantine. Never replay events to invent missing authority.

#### Preflight failure

Publish a durable Runner failure with no host continuation or external dispatch.

#### Partial dispatch before commitment

Treat as a strategy protocol violation. Reconcile evidence and quarantine
ambiguity.

#### Unknown or expired host ticket

Reject without publication. Expiration does not invalidate a submission already
published while intake was open.

#### Duplicate host continuation

Converge identical use of the same ticket and payload. Reject divergence.

#### Submission after intake closure

Reject publication. Retain external evidence only for diagnostics.

#### Malformed or oversized submission

Reject before adoption. Never guess a normal execution failure from an invalid
generic envelope.

#### Workspace drift

Stop at the boundary that detects it. Never refresh attempt inputs.

#### Strategy unavailable after dispatch

Use durable strategy state and Dependency Contract recovery. Never ask the host
agent to reconstruct scheduling textually.

#### Deadline with unresolved jobs

Close intake, request bounded stop, produce deadline outcomes, and track
unresolved technical execution for orphan cleanup.

#### Crash during outcome-set commit

Retain valid outcomes, commit missing outcomes from adopted evidence, and keep
the join incomplete until the set is whole.

#### Divergent final outcome

Quarantine and preserve evidence. Never overwrite or select by timing.

#### Crash after join before resume

Recover the committed join and start or recover the attempt resume invocation.

#### Duplicate resume invocation

Converge through attempt state, owner fencing, invocation serialization, and the
core run lock.

#### Core state advanced past attempt

Archive the stale request without executing the old command.

#### Core command or protocol result invalid

Publish a bounded terminal or unknown-recovery error and preserve evidence.
Never infer successful resume.

#### Handoff publication crash

Use durable journal evidence to decide whether responsibility transferred.

#### Delivery claim crash

Recover the immutable event independently from expired claim metadata.

#### Dedupe index corruption

Rebuild from the delivered journal before new delivery decisions.

#### Refencing stale event

Revalidate semantic state. Archive obsolete events and republish only still
current semantics.

#### Cleanup crash

Repeat cleanup safely without deleting artifacts referenced by pending state.

### 6.19 Proof: successful host and worker workset

```text
core emits attempt A
Runner commits workset A and executor specs
Runner durably hands off responsibility
controller delivers one host ticket
strategy executes one external group
host and strategy publish submissions
owner closes intake and adopts all submissions
owner commits one outcome per job
owner commits all-terminal join
Runner selects attempt A and executes core resumeCmd
```

No host or strategy operation advances the FSM directly.

### 6.20 Proof: owner crash after host submission

```text
host submission is atomically published
owner crashes before adoption
lease expires under recovery policy
successor rotates fence
successor reloads workset and submission
successor adopts and commits outcome
```

The host does not repeat semantic work merely because the controller crashed.

### 6.21 Proof: deadline with unresolved worker

```text
host submission exists
worker raw process remains active
owner closes intake at deadline
strategy receives stop request
bounded reconciliation expires
owner commits host success outcome
owner commits worker deadline outcome
join becomes all-terminal
core decides retry policy
```

Technical process uncertainty does not become unbounded workflow uncertainty.

### 6.22 Proof: partial outcome commit

```text
outcome A committed
process crashes before outcome B
successor validates outcome A
successor commits outcome B from adopted evidence
successor commits join
```

Per-file atomicity plus a durable join checkpoint recovers a non-atomic set
without rewriting committed content.

## 7. Cross-Cutting Concerns

### 7.1 Idempotence

Stable identities exist for attempt, workset, ticket, submission, final outcome,
and semantic delivery event. Every repeat path compares canonical identity and
digest before converging or conflicting.

External semantic execution remains at-least-once. No claim of exactly-once
worker execution is made.

### 7.2 Determinism

Manifest order controls job and outcome order. Completion, event, and discovery
order do not influence join or resume decisions.

Ambient time, randomness, and environment reads are provided by explicit Runner
services or validated configuration. Persisted identities and timestamps remain
stable across recovery.

### 7.3 Security

Workers and host tickets never receive the fence. Paths are resolved from
Runner-owned records, not command-line authority supplied by the agent.

The interface protects against accidental mistakes, stale controllers, replay,
and normal races. It does not protect control files from an adversarial process
running as the same system user with arbitrary shell access.

### 7.4 Path safety

Runner-relative references reject traversal, absolute roots, and symlink escape.
Untrusted reads use no-follow descriptor opening and post-open identity checks.
A platform that cannot enforce those checks is unsupported. Exact final result
path equality is required; broad containment is insufficient.

### 7.5 Canonical data

All persisted control records are JSON. Bounded raw UTF-8 input passes strict
I-JSON validation, duplicate-key detection, numeric-domain validation, RFC 8785
canonicalization, and SHA-256 digesting before semantic identity comparisons.

A digest field never belongs to its own digest subject.

### 7.6 Result limits

Envelope, payload, and diagnostic sizes are bounded before unbounded parsing or
canonicalization. Exact constants are NIB-owned closed values.

### 7.7 Observability

Stable transitions emit bounded audit events without exposing owner tokens,
secrets, raw prompts, or oversized payloads. Long evidence is stored as a
confined diagnostic artifact and referenced by digest or safe relative path.

The event stream never becomes the workset state source of truth.

### 7.8 Delivery deduplication

Event semantic digests exclude transport identity, claim timestamps, sequence
allocation, and owner token. They include every field that changes recipient
behavior.

The same dedupe identity with a different semantic digest is a conflict.

### 7.9 Cleanup and retention

Pending attempts, active claims, quarantine evidence, final outcomes, and resume
proofs remain retained while referenced. Cleanup uses logical Runner and attempt
identity, not an untrusted path or incidental process ID.

### 7.10 Schema evolution

Runner-owned schemas are strict and explicitly versioned. Persisted state is
migrated only through an approved version transition. External strategy parsing
follows its Dependency Contract's forward-compatibility rules.

### 7.11 PII and secrets

Human-facing and core-facing messages are bounded and contain no more identity
information than required for diagnosis. Secrets, owner tokens, provider
credentials, raw model context, and unrestricted local paths are excluded from
logs and final outcome messages.

## 8. Infrastructure & Environment

### 8.1 Local coordination environment

Version 1 assumes native execution on one local machine and one durable Runner
storage root reachable by the invocation, controller, bridge, host submission
command, and selected strategy.

### 8.2 Filesystem semantics

The filesystem provides exclusive creation, atomic same-filesystem rename,
durable regular files, process identity checks, and deterministic path
containment. Network filesystems with weaker semantics are outside scope.

### 8.3 Process model

Short Runner invocations and the resident controller can crash independently.
Process memory, watcher notification, or an in-flight RPC reply is never the
sole proof of a stable transition.

No container is required or assumed.

### 8.4 Remote executor allowance

A strategy can invoke a remote executor only when its durable local strategy
artifacts and Dependency Contract preserve the generic reconciliation,
submission, and stop obligations.

### 8.5 Clocks

Persisted deadlines use epoch milliseconds. Audit timestamps use ISO 8601.
Process-local duration measurement uses a monotonic clock where arithmetic does
not cross process boundaries.

### 8.6 Staging topology

Host payloads, raw external outputs, temporary files, submissions, final
outcomes, workset snapshots, and delivery records occupy distinct namespaces.
Staging is outside workspace input roots or explicitly excluded by the committed
workspace policy.

## 9. Dependencies

### 9.1 Parent CDD

`CDD-O-TURNLOCK-DELEGATION-ATTEMPT-EXECUTION` is authoritative for core/Runner
boundaries, identity hierarchy, global topology, outcome semantics, and failure
classification.

### 9.2 Strategy CDDs

Every concrete execution strategy has one CDD-S that inherits this interface.
The first planned strategy is `CDD-S-PI-SUBAGENTS-EXECUTION`.

### 9.3 Turnlock core protocol

The Runner consumes the core's validated protocol, manifest, state, final result
paths, and resume command. Exact version 3 contracts are extracted into the core
NIB lot.

### 9.4 Canonical JSON dependency

Strict I-JSON parsing and RFC 8785 canonicalization depend on an audited, pinned
implementation selected by ADR and constrained by a Dependency Contract.

### 9.5 Strategy dependencies

Each strategy owns Dependency Contracts for its external API and artifacts. A
strategy cannot rely on undocumented internal package modules as a public API.

### 9.6 Git workspace capture

Workspace input commitment uses official Git primitives and a versioned policy.
The exact manifest algorithm belongs to the Runner NIB rather than this CDD-I.

## 10. Testing Strategy

### 10.1 Acceptance coverage

The NIB-T derived from this CDD covers observable behavior for:

- valid workset creation and durable handoff;
- host-only, worker-only, and mixed worksets;
- zero or one host topology enforcement;
- complete preflight before any external side effect;
- host and worker submission publication;
- normal and deadline intake closure;
- outcome success and failure commit;
- partial outcome-set recovery;
- all-terminal join;
- attempt-oriented resume and replacement attempt creation;
- terminal core result delivery.

### 10.2 Crash-window coverage

Fixtures place crashes:

- before and after workset snapshot commit;
- before and after handoff publication;
- before and after submission publication;
- before and after adoption;
- between individual outcome commits;
- after join commit and before resume;
- during bridge claim and delivery;
- during owner takeover and mutex recovery;
- during cleanup.

Every fixture asserts the next stable state and which operation can safely
repeat.

### 10.3 Fencing coverage

Tests prove that:

- one active owner wins;
- takeover increments generation;
- stale owner mutations fail even after mutex acquisition;
- owner tokens never appear in worker-facing artifacts or diagnostics;
- a stale event cannot be refenced without semantic revalidation.

### 10.4 Idempotence properties

Property tests cover:

- identical workset creation convergence;
- divergent workset collision;
- identical submission convergence;
- divergent submission conflict;
- identical final outcome convergence;
- divergent final outcome conflict;
- repeated recovery producing the same stable snapshot;
- delivery index reconstruction from the delivered journal.

### 10.5 Ordering properties

Permutations of job completion, submission publication, event arrival, and file
discovery produce the same manifest-ordered outcome set and join result.

### 10.6 Workspace coverage

Tests cover tracked changes, selected untracked files, modes, symlinks,
submodules, exclusions, staging isolation, and drift detected at each of the
three required boundaries.

### 10.7 Path and parsing coverage

Tests cover traversal, absolute paths, symlink swaps, malformed UTF-8, duplicate
JSON keys, unsafe numbers, oversized envelopes, oversized payloads, unknown
internal fields, and version-compatible external extensions.

### 10.8 Delivery coverage

Tests cover duplicate continuation delivery, interrupted claims, expired claim
leases, delivered journal recovery, dedupe index corruption, semantic hash
conflict, and refencing after owner recovery.

### 10.9 Failure and quarantine coverage

Every failure behavior in section 6.18 has one acceptance vector or an explicit
v2 deferral. Tests distinguish expected execution failure outcomes from Runner
protocol violations and quarantine.

### 10.10 RED discipline

The NIB-T specifies only observable acceptance tests, cross-fixture invariants,
and property tests that fail before implementation. Internal helper tests emerge
during GREEN and are not prescribed as RED vectors.

## 11. Glossary

### Adapter strategy

Harness-specific implementation of the generic external worker interface.

### Adoption

Current-owner transition that accepts one valid unprivileged submission as the
evidence for constructing a final outcome.

### Attempt

One ordered Turnlock retry execution under a stable logical delegation.

### Current owner

Resident controller whose lease generation and token authorize owner-only
transitions.

### Delivery journal

Authoritative record of immutable bridge events proven delivered to the harness
session.

### Executor commitment

Complete pre-dispatch intent governing one job, represented across boundaries by
`executorSpecDigest`.

### Final outcome

Immutable Runner-to-core result envelope committed at the exact manifest path.
It can represent execution success or failure.

### Handoff

Durable transfer of responsibility from a short Runner invocation to the
resident controller or terminal delivery path.

### Host job

At most one independent job executed by the harness's main session.

### Intake

Irreversible gate deciding whether a newly published submission can be received
for the current attempt.

### Quarantine

Fail-closed terminal Runner coordination state used when authority or integrity
cannot be resolved safely through normal outcomes.

### Resident controller

Long-lived harness-side process that owns active workset coordination.

### Strategy state

Harness-specific durable runtime state referenced by, but not embedded in, the
generic workset snapshot.

### Submission

Immutable, unprivileged proposal containing a payload or observed execution
failure. It is not a final outcome.

### Transaction mutex

Short recoverable mutual exclusion primitive that serializes workset
transactions without granting owner authority.

### Workset

Runner-level durable execution projection of exactly one Turnlock attempt.

### Workset snapshot

Authoritative `WorksetRecord` describing stable Runner coordination state.
