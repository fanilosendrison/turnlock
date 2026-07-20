---
okf_version: "1.0"
kind: "RuntimeArtifact"
format: "cubits-design-doc"
workspace: "turnlock"
date: "2026-07-21"
step_id: 0
id: "CDD-O-TURNLOCK-DELEGATION-ATTEMPT-EXECUTION"
version: "0.1.0"
scope: "delegation-attempt-execution"
status: "draft"
consumers:
  - "agent-generator"
superseded_by: []
---

# CDD-O: Turnlock Delegation Attempt Execution

## 1. Document Status

This document is the umbrella conceptual design for durable execution of a
mixed delegation attempt across Turnlock core, a Turnlock Runner, a harness
adapter, and external workers.

The architecture has been conceptually frozen. This extraction remains in
`draft` status until the complete CDD corpus passes a hostile review.

Typed interfaces are non-normative functional sketches. The later NIB corpus
owns exact TypeScript, Zod, filesystem, timeout, and error contracts.

## 2. Contextual Placement

Turnlock executes a durable finite-state machine. A phase may complete
in-process or delegate work to a parent consumer. Delegation checkpoints the
workflow, emits one `DELEGATE` protocol block, and terminates the Turnlock
process. A parent later supplies result artifacts and executes the exact
`resumeCmd` emitted by the core.

This design extends delegated batch execution without changing that process
boundary.

```text
Turnlock phase
  -> neutral batch delegation attempt
  -> Runner workset execution
  -> harness-specific execution
  -> committed job outcomes
  -> Turnlock resume
  -> next phase or retry attempt
```

The workset is not a new core protocol kind. It is the Runner's durable
execution projection of one Turnlock delegation attempt.

This orchestrator delegates detailed design to two child CDDs:

- `CDD-I-TURNLOCK-RUNNER-WORKSET-CONTRACT` defines the harness-neutral Runner
  interface;
- `CDD-S-PI-SUBAGENTS-EXECUTION` defines the first Pi execution strategy.

The extraction sequence is documented in
[Turnlock Delegation Attempt Specification Restructuring
Plan](../delegation-attempt-specification-restructuring-plan.md).

## 3. System Objective

Execute one independent mixed batch containing external worker jobs and an
optional host-session job while preserving durable workflow state, deterministic
join and retry decisions, crash recovery, host neutrality, and unprivileged
worker boundaries.

## 4. System Physics

### 4.1 Core neutrality

Turnlock core understands only neutral delegation shapes:

```text
prompt | batch
```

A version 3 batch manifest carries one neutral target per job. The core does not
understand Pi, pi-subagents, Claude Code, model providers, concrete agent names,
thinking levels, tool names, process identifiers, or child lifecycle states.

```typescript
type DelegationTargetSketch =
  | { kind: "host" }
  | { kind: "worker"; profile: string }
  | { kind: "direct"; profile: string };
```

The first Pi strategy supports `host` and `worker`. A `direct` target is reserved
for another strategy and fails Pi version 1 preflight.

### 4.2 Core authority

Turnlock core owns:

- FSM state and phase progression;
- the logical delegation and its retry attempts;
- the neutral manifest commitment;
- the authoritative deadline and retry policy;
- validation of final outcome envelopes;
- execution failure classification and retry resolution;
- lazy validation of successful business payloads;
- transition to the next phase.

The core persists `pendingDelegation`. It never persists live workset, launch,
process, or harness state.

### 4.3 Runner authority

The Turnlock Runner owns:

- the workset projection of one attempt;
- pre-dispatch executor commitments;
- controller ownership and fencing;
- intake state;
- submission adoption;
- immutable final outcome commits;
- the all-terminal barrier;
- selection of an attempt for resume;
- execution of the exact core-provided `resumeCmd`.

### 4.4 Adapter authority

A harness adapter owns:

- translation from neutral targets to harness operations;
- capability and topology preflight;
- runtime bindings;
- external lifecycle observation;
- normalization of external outputs into unprivileged submissions;
- stop and reconciliation requests to the harness executor.

The adapter never decides core retry policy or business validity.

### 4.5 Worker authority

A worker owns only its assigned semantic task. It can propose a result but
cannot:

- receive the Runner fence;
- mutate owner-only workset transitions;
- commit a final Turnlock outcome;
- evaluate the join;
- invoke Turnlock resume.

### 4.6 pi-subagents authority

For the Pi strategy, pi-subagents owns:

- child process creation and supervision;
- internal parallel scheduling;
- per-child lifecycle artifacts;
- model invocation and fallback behavior;
- technical stop, interrupt, and stale-run reconciliation.

Turnlock does not duplicate those mechanisms.

### 4.7 Scoped sources of truth

The architecture uses one authority per concern:

```text
state.json
  -> Turnlock workflow state

WorksetRecord
  -> Runner execution coordination

Pi lifecycle artifacts
  -> technical child lifecycle

JobSubmissionEnvelope
  -> unprivileged result proposal

JobOutcomeEnvelope
  -> committed Runner-to-core handoff
```

An event stream remains an audit trail. It never replaces the authoritative
snapshot for its concern.

### 4.8 Version 1 topology

One workset attempt contains:

```text
0..1 Pi parallel group
0..1 host job
```

All jobs are mutually independent. A synthesis or any other job consuming peer
results belongs in a later Turnlock phase.

Version 1 fixes the following policies:

```text
join = all-terminal
failure mode = collect-all
Pi failFast = false
retry = whole delegation attempt
Pi context = fresh
shared workspace access = cooperatively read-only
```

The following topologies fail before dispatch:

- more than one host job;
- more than one Pi group;
- jobs with incompatible working directories, deadlines, contexts,
  cancellation domains, permissions, or recovery models;
- a direct target under the Pi version 1 strategy;
- a dependency between jobs in the same batch;
- a write-capable participant overlapping another participant.

There is no targeted retry, quorum, race, nested DAG, dynamic fanout, or partial
success continuation.

### 4.9 Parallelism semantics

The Pi group and optional host job may overlap in wall-clock execution. The
design does not promise a simultaneous start barrier.

The main session remains sequential. A host continuation begins when the
harness can deliver it, while Pi workers may already be active.

## 5. System Boundaries

### 5.1 Core-to-Runner attempt

The Runner receives one committed delegation attempt containing:

- Turnlock run identity;
- stable logical delegation identity;
- attempt identity and ordered attempt number;
- manifest version and digest;
- result envelope version;
- deadline and retry policy;
- ordered jobs with prompts, neutral targets, and final result paths;
- the exact core resume command.

```typescript
interface DelegationAttemptInputSketch {
  readonly turnlockRunId: string;
  readonly delegationId: string;
  readonly attemptId: string;
  readonly attempt: number;
  readonly manifestVersion: 3;
  readonly manifestDigest: PayloadDigestSketch;
  readonly resultEnvelopeVersion: 1;
  readonly deadlineAtEpochMs: number;
  readonly jobs: readonly ManifestJobSketch[];
  readonly resumeCmd: string;
}

interface ManifestJobSketch {
  readonly id: string;
  readonly prompt: string;
  readonly target: DelegationTargetSketch;
  readonly resultPath: string;
  readonly resultContractId?: string;
}
```

The core calculates the manifest digest from canonical manifest bytes without a
self-referential digest field. It persists that digest in `state.json` and
expects it in every final outcome.

### 5.2 Pre-dispatch execution commitment

Before dispatch, the Runner resolves every neutral target into an executor
intent it can support. The committed intent contains only information known
before dispatch.

The commitment excludes:

- session identifiers;
- launch and process identifiers;
- concrete Pi run identifiers;
- launch-specific paths;
- models selected by runtime fallback;
- lifecycle observations;
- post-dispatch timestamps.

Every job has an `executorSpecDigest` with one cross-strategy meaning:

> RFC 8785 and SHA-256 digest of all pre-dispatch parameters committed by the
> Runner that govern the job's execution.

Pi group-wide parameters and Pi job parameters remain structurally distinct.
The job digest commits both. A host job digest commits its host execution spec.

### 5.3 Runtime binding

Runtime bindings describe where and by which technical process an already
committed intent executes. They can change during recovery without creating
false configuration drift.

They include session references, launch identities, Pi run identities,
launch-specific chain directories, raw output paths, and lifecycle artifact
references.

Every runtime binding points back to the unchanged executor commitment.

### 5.4 Execution observation

An execution observation is derived by the adapter from executor artifacts. It
is not a cryptographic attestation and does not alter the pre-dispatch spec.

Pi observations are scoped per job and per launch because jobs can use different
model selectors and fallback sequences.

```typescript
interface PiJobExecutionObservationSketch {
  readonly worksetId: string;
  readonly launchId: string;
  readonly jobId: string;
  readonly modelSelector: string;
  readonly attemptedModels: readonly string[];
  readonly actualModel?: string;
  readonly actualThinking?: string;
  readonly terminalState: "completed" | "failed" | "stopped";
  readonly piStatusDigest: PayloadDigestSketch;
  readonly piResultDigest?: PayloadDigestSketch;
  readonly observedAtEpochMs: number;
}
```

A paused child is non-terminal. It has no terminal observation until it resumes,
fails, or stops.

### 5.5 Unprivileged submission

Host and worker paths produce the same logical artifact family:

```typescript
type JobSubmissionEnvelopeSketch =
  | HostJobSubmissionSketch
  | WorkerJobSubmissionSketch;

interface JobSubmissionHeaderSketch {
  readonly turnlockRunId: string;
  readonly delegationId: string;
  readonly attemptId: string;
  readonly worksetId: string;
  readonly jobId: string;
  readonly executorSpecDigest: PayloadDigestSketch;
  readonly publishedAtEpochMs: number;
}
```

A host submission identifies its Runner-issued ticket. A worker submission
identifies its eligible launch and execution evidence.

A submission proposes a successful payload or an observed execution failure. It
never grants authority to adopt or commit that proposal.

### 5.6 Final outcome

The current owner transforms accepted submissions and owner-generated terminal
conditions into final outcome envelopes.

```typescript
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

The core validates identities and commitments it previously produced. The
Runner validates execution-layer identities and commitments.

The core does not claim to compare an expected executor spec digest because the
Runner resolves that spec after core termination.

### 5.7 Digest contract

```typescript
interface PayloadDigestSketch {
  readonly canonicalization: "rfc8785";
  readonly digestAlgorithm: "sha256";
  readonly value: `sha256:${string}`;
}
```

Digest production follows this conceptual path:

```text
bounded raw UTF-8 bytes
  -> strict UTF-8 and I-JSON validation
  -> duplicate property detection before information loss
  -> interoperable numeric-domain validation
  -> RFC 8785 canonical bytes
  -> SHA-256
```

A maintained, audited, pinned implementation is selected through an ADR and a
Dependency Contract. `JSON.parse` followed by key sorting does not satisfy this
contract.

A digest field is never included in its own digest subject.

### 5.8 Artifact references

Cross-boundary artifact references are typed rather than unconstrained strings.
Runner-relative references are traversal-free and confined below the Runner
root. Content-addressed references resolve through one defined Runner artifact
store.

Exact reference schemas and safe-open mechanics belong to the Runner CDD and
NIBs.

### 5.9 Infrastructure and Environment Assumptions

Version 1 assumes native execution on one local machine. It requires a local
filesystem with exclusive creation, atomic same-filesystem rename, durable
regular files, stable process identity checks, and deterministic path
containment. Network filesystems with weaker locking or rename semantics are
outside scope.

The Pi RPC is process-local. Cross-process and post-crash recovery relies on
durable filesystem artifacts covered by the Pi Dependency Contract, never on an
in-memory completion event alone.

No container is required or assumed. Native processes share the host operating
system. The cooperative threat model covers accidental errors, retries, crashes,
stale controllers, and normal races; it does not protect Runner control data
from an adversarial same-user process with arbitrary shell access. Strong
adversarial isolation requires a separate system user, sandbox, or privileged
broker and remains outside version 1.

All persisted cross-boundary data is JSON. Wall-clock deadlines use persisted
epoch milliseconds, audit timestamps use ISO 8601, and process-local duration
measurement uses a monotonic clock where arithmetic does not cross a process
boundary.

## 6. Identity Hierarchy

The identity hierarchy is:

```text
turnlockRunId
  -> delegationId
      -> attemptId
          -> worksetId
              -> launchId
                  -> piRunId
```

### 6.1 Turnlock run identity

Identifies one durable FSM run.

### 6.2 Delegation identity

Identifies one logical delegation across retries.

### 6.3 Attempt identity

Identifies one Turnlock retry attempt. A separate ordered `attempt` integer
remains authoritative for retry arithmetic.

### 6.4 Workset identity

Identifies the Runner projection of one attempt and remains stable through that
attempt's recovery.

### 6.5 Launch identity

Identifies one technical Pi group launch. Multiple launches can exist because
external execution is at-least-once, but only one can remain eligible.

### 6.6 Pi run identity

Identifies one concrete pi-subagents execution when Pi reports it. It is runtime
evidence, not workflow identity.

The new model does not use `yieldId`. The Runner selects by `attemptId` and then
executes the core-provided command.

## 7. Global Coordination Invariants

### 7.1 Owner fencing

One recoverable owner lease identifies the current controller. Recovery rotates
a monotonic generation and opaque token.

One short recoverable transaction mutex serializes workset transitions and
submission publication. Acquiring the mutex does not grant owner authority.
Every owner-only transition reloads the workset and verifies the current fence
under that mutex.

Workers never receive the owner token. There is no separate physical submission
lock.

### 7.2 Intake

Intake is either open or closed. A host or worker result becomes receivable only
when its immutable submission is atomically published under the transaction
mutex while intake is open and the attempt deadline has not passed.

A raw Pi output is not itself a Turnlock submission.

After intake closes:

- no new worker submission can become receivable;
- the current owner can still adopt submissions already published;
- the current owner creates missing terminal failure outcomes directly.

### 7.3 Eligible Pi launch

A workset has zero or one `eligibleLaunchId`. It references exactly one launch
in an eligible state.

A launch marked superseded or orphaned is never eligible for adoption. A worker
submission is receivable only when its launch matches `eligibleLaunchId`.

Once any submission from a launch is adopted or any outcome from that launch is
committed, that launch can no longer be superseded. This prevents one workset
from mixing nondeterministic results from different Pi executions.

Launch intent and eligibility are persisted before external spawn. Recovery
reconciles an uncertain launch before authorizing replacement. Ambiguous
multiple candidates fail closed instead of being selected by timing.

Exact launch states and recovery transitions belong to the Pi strategy CDD.

### 7.4 Launch-specific paths

Every Pi launch has its own chain directory and raw output paths. A replacement
launch never writes into a prior launch's staging locations.

Concrete paths are runtime bindings and do not enter the pre-dispatch executor
spec digest.

### 7.5 Shared workspace

When a Pi group overlaps a host job, every participant is cooperatively
read-only with respect to the shared workspace.

```text
phase A
  -> Pi analysis jobs, read-only
  -> optional host analysis job, read-only
  -> join

phase B
  -> mutations after the join
```

The Runner commits a versioned workspace input policy and manifest. The manifest
covers the Git and filesystem inputs selected by that closed policy, including
tracked changes, selected untracked files, relevant modes, symlinks, and
submodules.

The commitment is checked:

1. before dispatch;
2. before submission publication or adoption;
3. before final join commit.

A mismatch produces configuration drift. This mechanism detects drift according
to the policy; it is not a snapshot and does not prove every reader saw the same
bytes at one instant.

The logical workspace identity and relative working directory belong to the
pre-dispatch spec. The resolved absolute path belongs to runtime binding.

### 7.6 Context policy

Pi worker context is `fresh` in version 1. Forked context is rejected because a
runtime session reference cannot commit and reconstruct the exact context for a
replacement launch.

### 7.7 Result limits

Envelope, payload, and diagnostic boundaries are deterministically bounded
before unbounded parsing or canonicalization. Exact constants belong to the
NIBs.

### 7.8 Deadline and paused children

A paused Pi child is non-terminal before deadline closure.

At the deadline, the current owner closes intake atomically after a final scan,
then requests stop or interrupt for running and paused executions. Stop
reconciliation is bounded. An execution that cannot be confirmed terminated is
tracked for orphan cleanup but does not block Turnlock outcome terminality
without bound.

No synthetic worker submission is published after intake closure. The owner
creates `deadline-exceeded` outcomes for jobs without a receivable terminal
submission.

## 8. Abstract Logical Pathway

### 8.1 Core emission

The core validates the neutral batch, assigns delegation and attempt identities,
produces attempt-specific result paths, commits manifest version 3 and
`pendingDelegation`, emits one `DELEGATE` block, releases its run lock, and
terminates.

The core creates no workset and launches no worker.

### 8.2 Runner preflight

The Runner validates protocol, state, manifest, identities, topology, adapter
capabilities, target profiles, result paths, workspace commitment, and result
contracts before any external dispatch.

A successful preflight creates one stable workset for the attempt and commits
all executor specs.

### 8.3 Dispatch

The Runner creates an immutable host ticket when a host job exists. The Pi
adapter commits one eligible launch intent before spawning one pi-subagents
parallel group when worker jobs exist.

The host receives only its own task. The main session never schedules Pi
workers or evaluates the join.

### 8.4 Submission publication

The host writes a payload to a fixed staging location and invokes a Runner-owned
submission command using an opaque ticket identity. The command validates and
publishes an immutable host submission under the transaction mutex.

Pi children write only launch-specific raw outputs. The Pi adapter validates
external evidence and publishes worker submissions under the same logical
intake rule.

Neither path writes the final Turnlock result directly.

### 8.5 Intake closure

Normal closure occurs when every expected job has one receivable terminal
submission. Deadline closure occurs after the final scan at the authoritative
attempt deadline.

The current owner closes intake under the transaction mutex and performs the
final workspace drift check before committing the join.

### 8.6 Adoption and final outcomes

Only the current owner adopts submissions. Adoption verifies core identity,
Runner identity, executor commitment, eligible launch where relevant, workspace
commitment, payload or failure shape, digest consistency, and absence of a
divergent final outcome.

Final commit behavior is:

```text
outcome absent
  -> atomic commit

same outcome digest
  -> idempotent success

different outcome digest
  -> result conflict, fail closed
```

### 8.7 All-terminal barrier

The Runner join condition is:

```text
all-terminal
  <=>
exactly one committed final outcome exists for every manifest job
```

A successful or failed outcome both satisfy execution terminality. The Runner
does not validate business payload schemas and does not advance the FSM.

### 8.8 Resume

After all outcomes are committed, the current owner records the committed join
under the fence. The Runner selects the current attempt by `attemptId`,
cross-checks `state.pendingDelegation`, and executes exactly the `resumeCmd`
emitted by the core.

Workers and the main session never construct or invoke the core resume command.

### 8.9 Core resume

The core loads expected outcomes in manifest order and validates:

- bounded strict envelope parsing;
- envelope version and shape;
- core-owned identities;
- manifest and payload digests;
- one expected outcome per job.

A malformed, foreign, duplicate, or incoherent final envelope is a fatal outcome
protocol violation.

When valid execution failures exist, the core classifies the complete set and
resolves retry or terminal failure. When every outcome succeeded, the core
unwraps payloads in manifest order and enters the resumed phase.

Business Zod validation remains lazy in the phase's pending result consumer.

### 8.10 Retry

A retry creates a new attempt under the same delegation:

```text
delegationId remains stable
attempt increments
attemptId changes
worksetId changes
result paths change
profiles resolve again
```

Nothing from an older attempt is adoptable by the new attempt. Version 1 retries
the complete delegation and does not reuse successful peer results.

## 9. Execution Failure Semantics

### 9.1 Closed failure codes

The version 1 execution taxonomy contains:

- `executor-unavailable`;
- `provider-exhausted`;
- `deadline-exceeded`;
- `invalid-executor-output`;
- `budget-exceeded`;
- `protocol-failure` for a valid observation of executor protocol failure;
- `configuration-drift`;
- `cancelled-by-user`;
- `unknown`.

Controller stops map to their actual closed cause rather than a vague
controller-cancelled code.

### 9.2 Classification

The core owns the versioned classification:

```text
executor-unavailable      -> transient
provider-exhausted        -> transient
deadline-exceeded         -> transient
invalid-executor-output   -> transient
budget-exceeded           -> permanent
protocol-failure          -> permanent
configuration-drift       -> permanent
cancelled-by-user         -> abort
unknown                   -> permanent
```

### 9.3 Aggregate reduction

The core reads outcomes in manifest order, classifies every valid failure, and
reduces the set deterministically:

```text
any abort
  -> aggregate abort

otherwise any permanent
  -> aggregate permanent

otherwise
  -> aggregate transient
```

The retry resolver consumes this aggregate rather than the first failure to
finish. A primary diagnostic is selected separately with a stable ordering over
classification, failure code, and job identity.

### 9.4 Protocol violations

A malformed final envelope is not an execution failure. It is a fatal violation
of the Runner-to-core contract.

Closed violation families include malformed JSON, unsupported envelope version,
identity mismatch, digest mismatch, incoherent status shape, unexpected job,
and duplicate outcome.

## 10. Global Failure Mapping

### 10.1 Invalid topology or capability

The Runner fails before any host continuation or Pi spawn. There is no partial
dispatch and no automatic host-agent fallback.

### 10.2 Profile or workspace drift

The operation fails at the boundary where drift is observed. A replacement is
never described as identical when committed inputs changed.

### 10.3 Crash around Pi spawn

A committed launch intent is reconciled against Pi artifacts before replacement.
One exact candidate can be adopted. Multiple exact candidates produce an
adoption conflict and quarantine rather than arbitrary selection.

### 10.4 Late result from an ineligible launch

The result remains diagnostic and cannot win adoption.

### 10.5 Duplicate submissions or outcomes

Canonical identity and digest equality produce idempotent success. Divergence
produces a conflict and fails closed.

### 10.6 Malformed or oversized executor output

The adapter converts an expected executor-output defect into a valid failure
submission. It never writes a malformed final outcome.

### 10.7 Owner crash

Lease recovery rotates the fence. Immutable submissions and outcomes remain
available. A stale owner cannot perform an owner transition.

### 10.8 Deadline with active or paused execution

Intake closes first. Stop and bounded reconciliation follow. Missing jobs receive
owner-generated deadline outcomes, while uncertain processes enter orphan
cleanup.

### 10.9 Crash after all outcomes but before resume

Recovery recomputes the all-terminal barrier from authoritative records and
reissues idempotent attempt selection.

### 10.10 Invalid final envelope

The core emits a fatal outcome protocol error. It does not disguise the defect
as business schema failure or normal executor failure.

### 10.11 Multiple valid failures

All failures remain observable. Classification and retry behavior are
independent of completion, event, and file discovery order.

## 11. Guarantees and Limitations

### 11.1 Guaranteed conceptual properties

- Core workflow state remains snapshot-authoritative.
- Workset execution state remains outside `state.json`.
- Workers never receive controller fencing authority.
- Every owner mutation is fence-checked under one short transaction mutex.
- External execution can be at-least-once while only one Pi launch can win
  adoption.
- Final outcome commits are idempotent for identical content and fail closed for
  divergent content.
- Join and retry decisions are deterministic and order-independent.
- Pi child scheduling is not reimplemented by Turnlock.
- Successful business payload validation remains lazy in the resumed phase.

### 11.2 Explicit limitations

- Child execution is not exactly-once.
- Host and Pi execution have no simultaneous start guarantee.
- The shared workspace is not snapshotted.
- Read-only behavior is cooperative, not adversarially enforced.
- Pi worker context is fresh only.
- There is no partial job retry or prior-success reuse.
- There is no automatic executor fallback.
- Intake acceptance is based on Runner submission publication, not the model's
  final token timestamp.
- Ambiguous external execution can be quarantined rather than resolved by a
  guess.

## 12. Proof of Logic

### 12.1 Successful mixed review

```text
Turnlock attempt A
  -> Pi group: architecture + tests
  -> host job: requirements

Pi adapter publishes two worker submissions
host command publishes one host submission

current owner closes intake
current owner commits three success outcomes
current owner resumes attempt A

core validates envelopes and digests
core unwraps payloads in manifest order
phase validates business schemas lazily
workflow advances to a later synthesis phase
```

No worker decides that the join is complete. Synthesis is absent from the
parallel attempt because it depends on peer results.

### 12.2 Mixed failures

```text
architecture -> provider-exhausted -> transient
tests        -> invalid-executor-output -> transient
requirements -> success
```

The Runner commits one outcome per job. The core classifies the complete set as
transient and creates a new whole-delegation attempt when policy permits.

### 12.3 Stale completion after replacement

```text
launch 1 becomes uncertain
recovery marks launch 1 superseded
launch 2 becomes eligible
launch 1 reports a late result
```

The late result remains diagnostic because it does not match
`eligibleLaunchId`. Only launch 2 can produce receivable worker submissions.

### 12.4 Deadline with a paused child

```text
host submission published
Pi child 1 submitted
Pi child 2 paused without submission
deadline reached
```

The owner closes intake, requests stop, performs bounded reconciliation, commits
`deadline-exceeded` for child 2, and resumes after every job has a committed
outcome. Uncertain process cleanup does not block core retry resolution.

## 13. Non-Goals

Version 1 and this umbrella CDD exclude:

- exact implementation schemas and algorithms;
- exact lock layouts, constants, and lease durations;
- exact Pi RPC event names and payloads;
- exact RFC 8785 package selection;
- multiple Pi groups or multiple host jobs;
- direct model execution in the Pi strategy;
- write-capable concurrent jobs;
- workspace snapshots;
- forked Pi conversation context;
- targeted retry and successful-result reuse;
- fail-fast cancellation;
- quorum, race, or conditional joins;
- distributed multi-machine execution;
- protection against a malicious same-user shell actor.

## 14. Extraction Map

### 14.1 Runner interface CDD

`CDD-I-TURNLOCK-RUNNER-WORKSET-CONTRACT` owns:

- generic `WorksetRecord` states;
- owner lease and transaction mechanics;
- tickets, submissions, adoption, and final commit;
- intake closure and deadline transactions;
- artifact and workspace commitments;
- handoff, spool, deduplication, and generic recovery.

### 14.2 Pi strategy CDD

`CDD-S-PI-SUBAGENTS-EXECUTION` owns:

- Pi capability mapping and one-group construction;
- resolver input commitments;
- launch states and eligible-launch transitions;
- Pi runtime bindings and observations;
- lifecycle artifact reconciliation;
- raw output collection and worker submission publication;
- stop, interrupt, and Pi-specific recovery.

### 14.3 Core construction briefs

The core NIB lot owns exact behavior for:

- public neutral targets;
- manifest version 3;
- pending delegation state evolution;
- canonical digest verification;
- final outcome envelope parsing;
- protocol violation errors;
- failure classification and aggregation;
- retry resolution;
- successful payload unwrapping;
- lazy business validation compatibility.

### 14.4 Dependency Contracts

Dependency Contracts own:

- the exact public pi-subagents integration surface;
- external artifact schemas and tolerant parsing rules;
- strict I-JSON and RFC 8785 dependency surfaces;
- dependency version and error semantics.

## 15. Baseline Criteria

This CDD becomes `baselined` only when:

- the CDD-I and CDD-S exist and close every delegated boundary;
- cross-document types have one owner and compatible consumers;
- no Pi-specific field leaks into the core contract;
- no Runner execution state leaks into `state.json`;
- every failure mode has one deterministic owner and response;
- all unresolved options are explicitly deferred outside version 1;
- the three-document corpus passes claim verification and a fresh blind-spot
  sweep with zero blocking findings.
