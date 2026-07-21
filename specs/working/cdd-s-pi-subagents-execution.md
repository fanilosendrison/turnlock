---
okf_version: "1.0"
kind: "RuntimeArtifact"
format: "cubits-design-doc"
workspace: "turnlock"
date: "2026-07-21"
step_id: 0
id: "CDD-S-PI-SUBAGENTS-EXECUTION"
version: "0.1.0"
scope: "pi-subagents-execution-strategy"
status: "draft"
consumers:
  - "agent-generator"
superseded_by: []
---

# CDD-S: Pi Subagents Execution

## 1. Document Status and Contextual Placement

### 1.1 Document status

This document defines the Pi-specific execution strategy that implements the
harness-neutral Runner interface in
[CDD-I: Turnlock Runner Workset
Contract](cdd-i-turnlock-runner-workset-contract.md).

It is also a child of
[CDD-O: Turnlock Delegation Attempt
Execution](cdd-o-turnlock-delegation-attempt-execution.md), which remains
authoritative for the end-to-end execution graph, core authority, identity
hierarchy, all-terminal barrier, failure classification, retry, and resume.

This strategy CDD owns only the operational mapping from Runner worker jobs to
pi-subagents execution. It remains in `draft` status until the complete
three-document CDD corpus passes a hostile review.

Typed interfaces are non-normative functional sketches. Later NIBs own exact
TypeScript and Zod schemas, filenames, state-dependent unions, RPC calls,
timeout constants, and filesystem algorithms. A separate Dependency Contract
owns the exact pinned pi-subagents release, public operations, reply shapes,
lifecycle artifacts, and forward-compatibility rules.

The corpus extraction sequence is documented in
[Turnlock Delegation Attempt Specification Restructuring
Plan](../../docs/delegation-attempt-specification-restructuring-plan.md).

### 1.2 Strategy position

The strategy executes the worker subset of one prepared Runner workset.

```text
neutral worker jobs
  -> Pi strategy preflight and intent commitment
  -> one static pi-subagents parallel group
  -> launch-specific lifecycle and raw artifacts
  -> per-job Pi observations
  -> generic unprivileged worker submissions
  -> current Runner owner adoption and outcome commit
```

The optional host job is coordinated by the generic Runner. It can overlap the
Pi group, but this strategy neither dispatches it nor waits for it.

### 1.3 Authority boundary

The Pi strategy owns:

- Pi capability and topology validation;
- resolution of known worker-profile inputs;
- Pi group and per-job pre-dispatch commitments;
- construction of one static parallel group;
- launch identities, eligibility, and Pi runtime bindings;
- Pi lifecycle and artifact reconciliation;
- per-job execution observations;
- normalization of raw Pi outputs;
- publication of generic worker submissions;
- Pi stop and interrupt requests;
- Pi-specific orphan evidence and cleanup.

The strategy does not own:

- Turnlock FSM state or `pendingDelegation`;
- workset ownership, intake, or the transaction mutex;
- host tickets or host submission publication;
- generic submission adoption;
- final outcome commit;
- the all-terminal join;
- failure retry classification;
- business payload validation;
- attempt selection or Turnlock resume.

The current Runner owner invokes owner-only strategy transitions under the
CDD-I fence. The strategy cannot turn possession of Pi artifacts into Runner
owner authority.

### 1.4 External executor authority

Pi-subagents remains authoritative for:

- creation and supervision of child Pi sessions;
- scheduling and concurrency inside the parallel group;
- provider and model fallback internal to each child;
- child lifecycle transitions;
- technical runtime limits;
- machine-readable lifecycle artifacts;
- stop and interrupt behavior exposed by its public contract.

The strategy observes and translates those mechanisms. It does not recreate a
child scheduler, provider fallback loop, or session lifecycle engine.

### 1.5 Actors

#### Resident controller

The resident controller is the current Runner owner. It authorizes strategy
activation, launch replacement, intake closure, adoption, and outcome commit.

#### Pi strategy adapter

The adapter translates committed Runner intent into public pi-subagents
operations and durable Pi strategy artifacts. It can publish submissions under
the generic unprivileged publication contract but receives no independent
workset authority.

#### Pi-subagents service

The service accepts one asynchronous static group, supervises its child
sessions, and exposes public lifecycle control and durable machine-readable
artifacts.

#### Pi child

A child receives one job task in fresh context. It produces only a raw
launch-specific output and external lifecycle evidence. It cannot write a
Runner submission, a final outcome, or core state directly.

## 2. Strategy Objective, Goals, and Non-Goals

### 2.1 Objective

Execute all worker jobs of one Turnlock attempt through one recoverable
pi-subagents parallel group while preserving Runner neutrality, deterministic
pre-dispatch commitments, at-least-once external execution, single-launch
adoption consistency, and fail-closed recovery.

### 2.2 Goals

The strategy establishes:

- one Pi group specification per workset attempt;
- one static child entry per worker job;
- Pi-owned child scheduling and concurrency;
- fresh child context;
- cooperative read-only workspace access;
- one committed resolver-input digest per worker profile resolution;
- one cross-strategy `executorSpecDigest` per worker job;
- strict separation of committed intent, runtime binding, and observation;
- zero or one eligible Pi launch at a time;
- launch-specific artifact namespaces;
- deterministic reconciliation after every spawn crash window;
- per-job normalization into the generic Runner submission contract;
- bounded stop and reconciliation for running or paused children;
- extension-tolerant consumption of version-compatible Pi artifacts.

### 2.3 Non-goals

Version 1 does not provide:

- more than one logical Pi group in a workset;
- successive Pi groups in one attempt;
- a Turnlock-owned child scheduler;
- dynamic fanout or child-created jobs;
- dependencies between children;
- synthesis over peer outputs inside the group;
- `fork` context without a reproducible context snapshot;
- write-capable concurrent workspace activity;
- arbitrary per-request tool grants;
- automatic host-agent scheduling fallback;
- direct model execution outside pi-subagents;
- a complete effective-agent digest when Pi cannot expose one;
- exactly-once LLM execution;
- targeted retry of one worker within the same Turnlock attempt;
- global concurrency arbitration across unrelated Runner worksets;
- parsing of terminal widgets or human-oriented Pi output;
- exact Pi operation names or external artifact schemas;
- protection against a malicious same-user process with arbitrary shell access.

## 3. Strategy Doctrine

### 3.1 One logical group, potentially multiple technical launches

One workset contains at most one logical Pi group. Recovery can create more than
one technical launch record for that same group because external execution is
at-least-once.

Multiple launch records do not create multiple logical groups. At most one
launch is eligible to publish receivable worker submissions.

### 3.2 Static collect-all execution

The group is completely known before dispatch. Every worker job becomes one
static child entry. The group uses collect-all behavior:

```text
failFast = false
```

One child failure does not authorize the strategy to cancel successful or still
running peers. Pi-subagents controls the actual child scheduling within the
committed concurrency bound.

### 3.3 Fresh context

Every child starts with fresh Pi context. A runtime session reference is a
binding, not a reproducible input commitment, and therefore cannot justify
`fork` recovery.

A child receives its own task and committed execution environment. It does not
receive host-session conversation state or peer results.

### 3.4 Cooperative read-only workspace

All concurrently executing children, and an overlapping host job when present,
use the shared workspace cooperatively read-only.

The strategy validates that selected profiles, declared tools, task policy, and
working-directory topology are compatible with that rule. The strategy does not
claim adversarial filesystem enforcement when children retain same-user shell
access.

A mutation depending on worker output belongs in a later Turnlock phase after
the Runner join.

### 3.5 Intent, binding, and observation are distinct

The strategy maintains three non-interchangeable artifact families:

```text
Resolved Pi intent
  -> facts known and committed before dispatch

Pi launch binding
  -> concrete session, process, paths, and external run identity

Pi job observation
  -> facts derived from actual external execution
```

Post-dispatch facts never enter a pre-dispatch digest retroactively. Runtime
bindings can change during safe recovery without pretending that committed
configuration changed.

### 3.6 Known-input commitment, not false effective configuration

The strategy commits every configuration input that it can resolve through its
approved registry and public dependency surface. It does not label that digest
an effective-agent digest unless Pi exposes and guarantees a complete effective
execution plan.

Unknown dependency internals are an explicit reproducibility limit, not a field
to be guessed from ambient files.

### 3.7 Workers remain unprivileged

A raw child output is not a Runner submission. The adapter validates and
normalizes it, then attempts publication through the CDD-I transaction contract.

Neither the child nor pi-subagents receives:

- the owner token;
- owner generation as an authorization secret;
- final result-path write authority;
- join authority;
- the core resume command.

### 3.8 External artifacts are evidence, not Runner state

Pi lifecycle artifacts are authoritative for Pi technical lifecycle only. They
do not replace the Pi strategy snapshot, generic `WorksetRecord`, final outcome,
or Turnlock `state.json`.

An in-memory RPC reply or completion event can accelerate observation but cannot
be the sole recovery proof.

### 3.9 Failure facts do not decide retry

The strategy can report a closed execution failure code supported by observed
Pi evidence. It never reports an authoritative `retryable` boolean.

The core classification and aggregate retry behavior remain inherited from
CDD-O.

## 4. System Boundaries and Functional Contracts

### 4.1 Strategy activation input

The strategy receives only a prepared and fence-authorized projection of the
worker subset.

```typescript
interface PiStrategyActivationInputSketch {
  readonly runnerId: string;
  readonly turnlockRunId: string;
  readonly delegationId: string;
  readonly attemptId: string;
  readonly attempt: number;
  readonly worksetId: string;

  readonly manifestDigest: PayloadDigestSketch;
  readonly deadlineAtEpochMs: number;
  readonly workspaceInputCommitment: WorkspaceInputCommitmentSketch;
  readonly logicalWorkspace: LogicalWorkspaceSketch;
  readonly workerJobs: readonly PiWorkerJobInputSketch[];
}

interface PiWorkerJobInputSketch {
  readonly jobId: string;
  readonly prompt: string;
  readonly profileName: string;
  readonly resultContractDigest?: PayloadDigestSketch;
}
```

The generic Runner proves that the workset, attempt, manifest, and current owner
are coherent. The strategy does not reconstruct those identities from Pi
labels.

### 4.2 Strategy configuration

Deployment configuration supplies:

- the selected Pi adapter identity and version;
- a closed worker-profile registry;
- logical-to-concrete agent mappings;
- model selectors and optional requested thinking levels;
- tool and permission profile commitments;
- configured extension commitments;
- Pi dependency contract identity;
- process-local RPC connection policy;
- bounded startup, launch, observation, stop, and reconciliation limits;
- maximum group concurrency policy;
- Pi artifact roots outside or excluded from workspace commitment roots.

Provider credentials and other secrets are runtime inputs. They are neither
persisted in strategy records nor included in semantic digests.

### 4.3 Capability verdict

Before commitment, the adapter returns a closed verdict covering:

- dependency presence and protocol compatibility;
- required public operation classes;
- asynchronous static-group support;
- durable artifact support;
- per-job raw output support;
- status and terminal evidence support;
- stop or interrupt support;
- all requested profiles and agents;
- fresh context support;
- collect-all behavior;
- requested topology and resource bounds.

A negative or indeterminate verdict rejects the complete workset before any host
continuation or Pi launch.

### 4.4 Resolver input commitment

One profile is resolved once for the attempt into known inputs.

```typescript
interface PiAgentResolverInputsSketch {
  readonly profileName: string;
  readonly profileDefinitionDigest: PayloadDigestSketch;
  readonly agentName: string;
  readonly agentDefinitionDigest?: PayloadDigestSketch;
  readonly knownPiConfigurationDigest: PayloadDigestSketch;
  readonly toolProfileName: string;
  readonly toolProfileDigest: PayloadDigestSketch;
  readonly permissionProfileDigest?: PayloadDigestSketch;
  readonly configuredExtensions: readonly string[];
  readonly adapterVersion: string;
  readonly dependencyContractId: string;
  readonly piSubagentsVersionCommitment: string;
}
```

The `agentResolverInputDigest` commits this closed value. It is explicitly not a
claim that every hidden Pi or provider default has been captured.

### 4.5 Resolved group context

```typescript
interface ResolvedPiGroupContextSketch {
  readonly version: 1;
  readonly adapterKind: "pi-subagents";
  readonly dependencyContractId: string;
  readonly context: "fresh";

  readonly logicalWorkspace: LogicalWorkspaceSketch;
  readonly workspaceInputCommitment: WorkspaceInputCommitmentSketch;

  readonly maximumRuntimeMs: number;
  readonly concurrency: number;
  readonly failFast: false;
  readonly durableArtifactsRequired: true;
  readonly turnBudget?: ResolvedTurnBudgetSketch;
}
```

The maximum Pi runtime is strictly less than the remaining Turnlock deadline.
The reserved margin covers terminal observation, bounded output reads,
normalization, publication, adoption, outcome commit, join, and resume startup.
Exact constants belong to the NIBs.

### 4.6 Resolved worker job intent

```typescript
interface ResolvedPiWorkerJobSketch {
  readonly version: 1;
  readonly jobId: string;
  readonly taskDigest: PayloadDigestSketch;

  readonly profileName: string;
  readonly agentName: string;
  readonly agentResolverInputDigest: PayloadDigestSketch;

  readonly modelSelector: string;
  readonly requestedThinking?: string;

  readonly toolProfileName: string;
  readonly toolProfileDigest: PayloadDigestSketch;
  readonly permissionProfileDigest?: PayloadDigestSketch;

  readonly toolBudget?: ResolvedToolBudgetSketch;
  readonly acceptancePolicy?: ResolvedAcceptancePolicySketch;
  readonly resultContractDigest?: PayloadDigestSketch;
  readonly workspaceInputCommitment: WorkspaceInputCommitmentSketch;
}
```

The exact `modelSelector` sent before dispatch is committed. Actual model,
fallback sequence, Pi run identity, session identity, paths, timestamps, and
lifecycle state are excluded.

### 4.7 Executor digest projection

The strategy produces one group-context digest and one executor digest per job.

```text
groupSpecDigest
  = digest(resolved group context)

executorSpecDigest(job)
  = digest({ version, groupSpecDigest, resolved worker job })
```

Digest semantics, strict I-JSON input, RFC 8785 canonicalization, and SHA-256 are
inherited from CDD-O and CDD-I. The strategy cannot substitute object key
sorting or a post-parse hash that has already lost duplicate properties.

### 4.8 Strategy state

The generic workset references a Pi-specific state artifact.

```typescript
interface PiStrategyStateSketch {
  readonly version: 1;
  readonly worksetId: string;
  readonly attemptId: string;
  readonly groupSpecDigest: PayloadDigestSketch;
  readonly executorSpecDigests: Readonly<Record<string, PayloadDigestSketch>>;
  readonly eligibleLaunchId?: string;
  readonly launches: readonly PiLaunchRecordSketch[];
  readonly updatedAt: string;
}
```

The state contains Pi execution coordination only. Generic submission adoption
and final outcome state remain in `WorksetRecord` and are consulted
transactionally when launch replacement is evaluated.

### 4.9 Launch record

```typescript
type PiLaunchStateSketch =
  | "dispatch-intent"
  | "spawned"
  | "completed"
  | "failed"
  | "stopped"
  | "superseded"
  | "orphaned";

interface PiLaunchRecordSketch {
  readonly version: 1;
  readonly launchSequence: number;
  readonly launchId: string;
  readonly groupSpecDigest: PayloadDigestSketch;
  readonly state: PiLaunchStateSketch;

  readonly sessionRef: RuntimeBindingRefSketch;
  readonly chainArtifactRef: ArtifactRefSketch;
  readonly rawOutputRefs: Readonly<Record<string, ArtifactRefSketch>>;
  readonly observationRootRef: ArtifactRefSketch;

  readonly piRunId?: string;
  readonly executionRef?: ArtifactRefSketch;

  readonly dispatchedAtEpochMs: number;
  readonly updatedAtEpochMs: number;
}
```

A launch record does not duplicate authoritative generic adoption or outcome
flags. Supersession checks join this launch identity with the corresponding
CDD-I workset job records under the transaction mutex.

### 4.10 Launch namespace

Every launch has a disjoint namespace equivalent to:

```text
<workset-strategy-root>/<launchId>/
  -> chain artifacts
  -> one raw output location per job
  -> observations
  -> reconciliation evidence
```

The exact directory layout belongs to the NIB. The conceptual invariant is that
two launch identities never share a mutable chain, raw output, or observation
path.

### 4.11 Per-job execution observation

```typescript
interface PiJobExecutionObservationSketch {
  readonly version: 1;
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

The observation is launch- and job-scoped. It is evidence derived from Pi
artifacts, not a cryptographic attestation and not part of the original executor
commitment.

A paused job has no terminal observation.

### 4.12 Worker submission evidence

Before publishing a generic worker submission, the strategy commits a confined
execution-evidence artifact.

```typescript
interface PiWorkerExecutionEvidenceSketch {
  readonly version: 1;
  readonly worksetId: string;
  readonly attemptId: string;
  readonly launchId: string;
  readonly jobId: string;
  readonly groupSpecDigest: PayloadDigestSketch;
  readonly executorSpecDigest: PayloadDigestSketch;
  readonly observationRef: ArtifactRefSketch;
  readonly rawOutputDigest?: PayloadDigestSketch;
}
```

The CDD-I worker submission points its generic `executionRef` to this evidence
and identifies the Pi strategy. Launch identity remains inside strategy evidence
rather than changing the generic submission family.

### 4.13 Stop and reconciliation request

The current owner can request a bounded strategy action carrying:

- workset and attempt identity;
- current eligible launch identity;
- closed cause supplied by the Runner;
- stop or interrupt intent;
- reconciliation deadline;
- current owner authorization resolved internally by the Runner.

The request never delegates intake closure, outcome construction, or retry
classification to the adapter.

### 4.14 Strategy outputs

The strategy produces only:

- capability and preflight verdicts;
- committed Pi intent and executor digests;
- Pi strategy and launch snapshots;
- runtime binding references;
- per-job observations;
- generic worker submission proposals;
- stop and reconciliation reports;
- confined orphan and diagnostic evidence.

It does not produce final Turnlock outcomes or a resume request.

## 5. Infrastructure and Environment Assumptions

### 5.1 Process locality

Version 1 assumes that the resident controller and Pi RPC endpoint execute on
one local machine. The live RPC can be process-local, but recovery cannot depend
on the original connection remaining alive.

### 5.2 Durable filesystem

The strategy requires the filesystem semantics inherited from CDD-I:
exclusive creation, atomic same-filesystem rename, durable regular files,
process identity checks, and deterministic path containment.

Pi artifacts required for recovery must become durable under the external
Dependency Contract. A network filesystem with weaker visibility, locking, or
rename guarantees is unsupported.

### 5.3 Stable dependency surface

The runtime uses only public pi-subagents operations covered by the Dependency
Contract. Importing undocumented internal modules, scraping a terminal, or
inferring lifecycle from a widget is outside the strategy contract.

### 5.4 Artifact visibility

The Dependency Contract defines when a launched group, status transition, raw
output, or stop result becomes durably discoverable. Recovery does not infer
absence until those visibility guarantees and bounded waiting rules are
satisfied.

### 5.5 Workspace topology

The concrete absolute workspace path is a runtime binding. The committed input
contains only the logical workspace identity, relative working directory, and
generic workspace commitment.

Strategy control and raw output roots remain outside committed workspace roots
or inside one explicitly excluded Runner namespace.

### 5.6 Clocks and deadlines

Persisted cross-process deadlines use epoch milliseconds. Audit timestamps use
ISO 8601. Process-local timeout measurement uses a monotonic clock where the
measurement does not cross a process boundary.

Pi lifecycle timestamps are evidence only. They do not override the Runner's
mutex-ordered intake publication boundary.

### 5.7 Cooperative threat model

The strategy protects against crashes, retries, stale owners, accidental path
mistakes, malformed outputs, ambiguous launches, and normal races. It does not
isolate control artifacts from an adversarial same-user process with arbitrary
shell access.

Stronger isolation requires a separate system user, sandbox, or privileged
broker and is outside version 1.

## 6. Preconditions and Complete Preflight

### 6.1 No external side effect before complete preflight

The Pi strategy completes all checks and commits all resolved intents before
creating a child session or exposing a host continuation.

A partially valid worker set is rejected as a whole. Unsupported jobs are not
silently dropped or rerouted.

### 6.2 Topology preflight

The strategy verifies:

- at least one worker job exists for Pi execution;
- all selected jobs use the neutral `worker` target;
- no `direct` target is routed to this strategy;
- exactly one static group can represent all worker jobs;
- every job is independent of every peer and the optional host job;
- no child consumes another child's output;
- `context` is `fresh`;
- collect-all behavior is available;
- all jobs share compatible workspace, working directory, environment,
  deadline, cancellation, permission, and recovery domains;
- requested concurrency is positive, bounded, and no greater than policy;
- all overlapping jobs are compatible with cooperative read-only execution.

### 6.3 Dependency preflight

The adapter performs a bounded runtime handshake that proves:

- liveness;
- compatible protocol version;
- availability of every required operation class;
- support for asynchronous static groups;
- durable artifacts and per-job output;
- lifecycle status and reconciliation;
- stop or interrupt support.

A readiness event can be used as a hint but is not the sole authority. The
startup handshake does not pretend to prove package provenance or execute the
full dependency contract suite; exact provenance and exhaustive compatibility
remain CI responsibilities.

### 6.4 Profile preflight

Every requested profile resolves through the closed Runner registry. Resolution
verifies:

- profile existence;
- concrete Pi agent availability;
- model selector syntax accepted by the Dependency Contract;
- requested thinking compatibility when present;
- tool and permission profile existence;
- configured extension commitment;
- read-only compatibility;
- result and resource policy compatibility.

The strategy does not grant a child arbitrary new tools from manifest input.
Capabilities come from configured Pi agents and approved profiles.

### 6.5 Commitment preflight

The complete group context, every job intent, every resolver-input digest, and
every executor digest are calculated and validated before dispatch.

No runtime binding or observation is allowed in those commitments.

### 6.6 Workspace preflight

The strategy requests the generic Runner workspace verification before
dispatch. It does not own or redefine the Git workspace manifest algorithm.

A mismatch rejects the attempt as configuration drift. The strategy never
refreshes the commitment in place.

### 6.7 Deadline preflight

The remaining deadline must exceed:

```text
committed Pi maximum runtime
  + launch and observation allowance
  + output normalization allowance
  + publication and adoption allowance
  + outcome, join, and resume allowance
```

An insufficient margin rejects dispatch. The strategy does not shorten other
post-execution safety windows to force acceptance.

### 6.8 Artifact preflight

The strategy validates that every child has:

- a unique stable correlation within the group;
- one launch-specific raw output destination;
- bounded expected output policy;
- one result normalization contract;
- a confined artifact reference;
- no ability to select its final Turnlock result path.

## 7. Abstract Operational Pipeline

### 7.1 Activate or recover strategy state

The current owner loads the generic workset and Pi strategy state under the
CDD-I transaction boundary. Existing state is validated before any new
operation.

An identical activation converges on the committed strategy state. Different
intent under the same workset identity is a conflict and cannot dispatch.

### 7.2 Establish runtime capability

The adapter establishes a bounded live connection and obtains the capability
verdict required by section 6.3.

A transient connection retry is bounded to adapter initialization. It is not a
hidden Turnlock business retry and cannot create a second launch.

### 7.3 Resolve profiles

The adapter resolves each profile into known inputs and calculates its
`agentResolverInputDigest`.

Profiles reused by multiple jobs can share the same resolver commitment when
all committed inputs are identical. Job-specific task, model, budget, and result
contracts remain part of each job intent.

### 7.4 Commit execution intent

The strategy constructs the group context and one job intent per manifest job,
then calculates `groupSpecDigest` and every `executorSpecDigest`.

The generic Runner commits those digests in the prepared workset before any Pi
spawn. Failure to commit the complete set leaves no dispatchable workset.

### 7.5 Commit launch intent

Under the current owner fence and transaction mutex, the strategy:

1. reloads generic and Pi strategy state;
2. verifies there is no incompatible eligible launch;
3. allocates the next launch sequence and identity;
4. allocates disjoint runtime artifact bindings;
5. commits a `dispatch-intent` launch;
6. sets it as the sole eligible launch;
7. atomically replaces the Pi strategy snapshot.

The durable intent precedes the external side effect.

### 7.6 Construct one static Pi group

The adapter projects all resolved worker jobs into one asynchronous static
parallel group.

The projection preserves:

- one child entry per manifest worker job;
- stable job correlation;
- each job's concrete configured agent;
- exact pre-dispatch model selector;
- requested thinking when supported;
- each job's task only;
- launch-specific raw output location;
- fresh context;
- committed concurrency;
- collect-all behavior;
- durable machine-readable artifacts.

The projection contains no nested group, dynamic phase, peer dependency, host
job, final result path, owner token, or resume command.

### 7.7 Dispatch and bind acknowledgement

The adapter submits the group through the approved public dependency surface.
On acknowledgement, it records every returned runtime identity and artifact
reference without changing the committed group or executor digests.

A Pi run identity is optional evidence when the public surface does not always
return one. It is never fabricated from timestamps or process guesses.

The launch becomes `spawned` only after evidence satisfying the Dependency
Contract is durable.

### 7.8 Observe lifecycle

The adapter combines live notifications with durable artifact reads. Live
notifications are hints; durable evidence confirms stable observations.

Each child is tracked independently. A failure in one child does not terminate
peer observation. Unknown version-compatible events are ignored, while missing
required facts or impossible transitions fail closed.

### 7.9 Reconcile terminal jobs

For each terminal child, the adapter:

1. validates launch and job correlation;
2. reads bounded machine-readable lifecycle evidence;
3. reads bounded raw output when required;
4. validates strict UTF-8 and the applicable JSON domain before semantic use;
5. records artifact digests;
6. constructs one terminal job observation;
7. selects a normalized success or observed execution failure;
8. commits confined execution evidence.

A `completed` Pi status without valid required output becomes
`invalid-executor-output`. A valid provider-exhaustion fact becomes
`provider-exhausted`. A failure that cannot be narrowed safely uses the closed
`unknown` code rather than an invented retry policy.

If identity or launch eligibility itself cannot be established, the workset is
quarantined rather than normalized into an ordinary job failure.

### 7.10 Publish worker submission

The adapter enters the generic CDD-I publication transaction. Under the short
transaction mutex it verifies:

- current attempt and workset identity;
- the worker job and executor digest;
- current `eligibleLaunchId`;
- source launch identity;
- open intake and authoritative deadline;
- current workspace commitment;
- bounded normalized result;
- execution evidence integrity;
- absence of divergent submission content.

It then publishes one immutable generic worker submission. The adapter performs
no owner-only state transition.

A crash after publication but before acknowledgement is recovered through
submission idempotence. A crash before publication leaves only strategy
evidence and can repeat the publication transaction.

### 7.11 Finalize Pi launch lifecycle

When Pi reports the group terminal and every child has been reconciled, the
strategy records the launch's technical terminal state.

Technical launch completion does not close Runner intake, adopt submissions,
commit outcomes, satisfy the global join, or resume Turnlock.

### 7.12 Respond to deadline or cancellation

The Runner closes intake first under CDD-I. It then asks the strategy to stop or
interrupt running and paused children.

The adapter:

1. verifies the requested workset and eligible launch;
2. sends the approved stop or interrupt operation;
3. observes terminal evidence for a bounded period;
4. records completed observations that remain diagnostic after closure;
5. reports unresolved known executions for orphan cleanup;
6. returns a bounded reconciliation report.

The adapter publishes no synthetic worker submission after intake closure. The
current owner creates the appropriate missing terminal outcomes from the closed
Runner cause.

### 7.13 Recover after controller or adapter crash

Recovery starts from `WorksetRecord`, Pi strategy state, and durable Pi
artifacts. It never starts from an event stream alone.

The successor:

1. obtains current Runner ownership;
2. validates committed intent and strategy state;
3. rechecks resolver and workspace commitments at required boundaries;
4. reconciles the eligible launch by exact committed correlations;
5. binds one exact existing Pi execution when possible;
6. preserves already published submissions;
7. republishes only missing identical submissions;
8. requests launch replacement only when section 8 permits it;
9. reports ambiguity for quarantine instead of selecting by timing.

## 8. Launch Eligibility, Supersession, and Recovery

### 8.1 Closed launch states

The stable launch states are:

- `dispatch-intent`: durable intent and bindings exist; external spawn is not
  yet durably acknowledged;
- `spawned`: one external execution is durably correlated;
- `completed`: the external group reached a terminal completed lifecycle;
- `failed`: the external group reached a terminal technical failure;
- `stopped`: the external group reached a terminal controlled stop;
- `superseded`: a known prior launch is permanently ineligible after safe
  replacement;
- `orphaned`: a known prior launch can no longer participate and requires
  separate technical cleanup.

`superseded` and `orphaned` are terminal and permanently ineligible.

### 8.2 Monotonic transitions

Conceptual transitions are:

```text
dispatch-intent
  -> spawned | failed | stopped | superseded | orphaned

spawned
  -> completed | failed | stopped | superseded | orphaned

completed | failed | stopped
  -> superseded | orphaned
```

The last transition is permitted only before any adoption or outcome from that
launch and only when replacement is otherwise proven safe.

No state transitions backward to `dispatch-intent` or `spawned`.

### 8.3 Eligible launch invariant

`eligibleLaunchId` is absent or references exactly one launch in one of these
states:

- `dispatch-intent`;
- `spawned`;
- `completed`;
- `failed`;
- `stopped`.

A worker submission is eligible only when its source launch equals the current
`eligibleLaunchId` at publication and adoption.

### 8.4 Consistency lock after adoption

A launch becomes permanently non-supersedable when any generic workset job
record proves either:

- adoption of a submission sourced from that launch; or
- commit of an outcome sourced from that launch.

The check is performed under the generic transaction mutex against authoritative
CDD-I records. It is not inferred from a cached Pi flag.

Once locked, all remaining Pi worker results for the attempt must come from the
same launch. This prevents a nondeterministic mixture of two LLM executions.

### 8.5 Replacement preconditions

A new launch can become eligible only when the current owner proves under the
transaction mutex that:

- the old launch has no adopted submission and no committed outcome;
- current profile resolver inputs still match their commitments;
- the workspace commitment still matches;
- launch ambiguity has been resolved;
- the old launch is durably marked `superseded` or `orphaned`;
- old and new launch artifact namespaces are disjoint;
- the Dependency Contract permits replacement for the observed condition.

If any precondition is indeterminate, replacement is rejected fail-closed.

### 8.6 Exact candidate cardinality

Recovery of an uncertain spawn uses exact committed correlations covered by the
Dependency Contract.

```text
zero exact candidates
  -> continue the committed launch or replace only after absence is proven

one exact candidate
  -> bind and reconcile that candidate

more than one exact candidate
  -> quarantine with adoption conflict
```

Timestamps, labels, or path similarity can narrow a search but cannot become an
idempotence key unless the Dependency Contract guarantees them.

### 8.7 Known orphan versus ambiguous execution

A known execution can be marked orphaned only when its launch identity and
artifact namespace are established well enough to reject all future
submissions from it and to clean it independently.

An execution whose identity could belong to multiple launch candidates is not a
known orphan. That condition is an ambiguity requiring quarantine and no new
spawn.

### 8.8 Crash before spawn

A crash after `dispatch-intent` but before external spawn leaves a recoverable
intent. Recovery first proves whether an execution exists. If absence is proven,
it can perform the original dispatch without allocating a conflicting logical
group.

### 8.9 Crash after spawn before acknowledgement commit

Recovery searches durable Pi evidence using committed launch correlations.
Exactly one candidate is adopted into the existing launch. Multiple candidates
quarantine the workset. A replacement is not authorized merely because
`piRunId` is absent.

### 8.10 Crash after raw output before publication

The raw output and observation are revalidated. The same normalized submission
is republished idempotently while intake remains open. A divergent terminal
artifact under the same launch and job identity is a conflict.

### 8.11 Late ineligible output

Output from a superseded, orphaned, or otherwise ineligible launch remains
confined diagnostic evidence. It cannot publish or win adoption, even if its Pi
completion timestamp predates replacement.

## 9. Pi Artifact and Observation Semantics

### 9.1 Machine-readable sources only

The adapter consumes only public machine-readable RPC replies and durable
artifacts covered by the Dependency Contract. Human terminal text, widgets, and
rendered status displays are never parsed as control data.

### 9.2 Forward-compatible external parsing

Version-compatible external records are parsed extension-tolerantly:

- unknown fields are retained or ignored according to the Dependency Contract;
- unknown non-semantic events can be ignored;
- new optional properties do not invalidate an otherwise known record.

The adapter rejects:

- a missing required field;
- an invalid required type;
- an incompatible protocol or artifact version;
- malformed or oversized data;
- an impossible lifecycle state;
- an unknown terminal state;
- an invalid state transition;
- inconsistent job or launch correlation.

Internal Turnlock and Runner records remain strict and are not relaxed to match
external parsing policy.

### 9.3 Per-job terminality

The only Pi job states projected as terminal observations are:

- `completed`;
- `failed`;
- `stopped`.

`paused` is non-terminal. It remains under observation until resumed, failed,
completed, or stopped. It does not satisfy the Runner all-terminal barrier.

### 9.4 Model fallback observations

Provider and model fallback remain internal to pi-subagents. The adapter records
attempted and actual model facts only when the public artifact contract exposes
them.

Absence of an actual model field does not invalidate an otherwise valid
terminal observation. The adapter never rewrites the committed `modelSelector`
to match a fallback result.

### 9.5 Raw output normalization

A successful worker submission requires a bounded raw output that:

- belongs to the eligible launch and expected job;
- satisfies strict transport and JSON requirements;
- remains within payload and structural limits;
- produces the expected generic JSON value domain;
- has a recomputable canonical digest;
- carries no uncontrolled artifact path as authority.

Business schema validation remains deferred to the resumed Turnlock phase. The
adapter validates execution-output structure, not domain correctness.

### 9.6 Missing and malformed output

A terminal child that was expected to produce output but has none produces
`invalid-executor-output` when launch and job identity remain trustworthy.
Malformed, oversized, non-UTF-8, duplicate-key, or structurally unsupported raw
output follows the same execution failure family.

If malformed control artifacts prevent trustworthy launch or job identity, the
condition is a strategy protocol breach and quarantines the workset instead of
producing an ordinary failure submission.

### 9.7 Status and result integrity

Every observation commits the digests of the status and result artifacts it
used. Re-reading identical artifacts converges. A terminal artifact that changes
divergently under the same immutable identity is preserved as conflict evidence
and stops automatic progression.

### 9.8 Runtime timestamps

Pi timestamps help correlate and diagnose execution. They do not decide intake
acceptance. A result is received only when the generic submission is published
under the transaction mutex before closure and before the authoritative
deadline.

## 10. Exhaustive Failure Modes Mapping

### 10.1 Dependency absent or incompatible before dispatch

The strategy returns a negative preflight verdict. No Pi group or host
continuation starts. The Runner publishes its durable preflight failure through
the generic handoff contract.

### 10.2 Runtime handshake timeout

Initialization retries are bounded. Exhaustion returns an unavailable verdict
without allocating a launch. A readiness event cannot convert an unverified
connection into compatibility.

### 10.3 Required public operation missing

The dependency is incompatible for this strategy version. The strategy does not
fall back to internal APIs, terminal scraping, or textual main-agent scheduling.

### 10.4 Unknown or invalid profile

The complete workset fails preflight. The job is not silently rerouted to a
default agent, model, or tool set.

### 10.5 Resolver drift

A changed resolver-input digest during the same attempt produces configuration
drift. The strategy does not describe a replacement launch as the same
committed execution.

### 10.6 Unsupported topology

Multiple logical groups, dependencies, non-fresh context, fail-fast behavior,
incompatible execution domains, or write-capable overlap reject the workset
before dispatch.

### 10.7 Insufficient deadline margin

Dispatch is rejected. The strategy does not start work that cannot retain the
required reconciliation and publication margin.

### 10.8 Workspace drift

The operation stops at the boundary where the generic Runner detects drift. The
strategy neither refreshes the commitment nor publishes under stale workspace
inputs.

### 10.9 Launch request rejected with trustworthy identity

The launch becomes technically failed. When the failure is attributable to the
executor and every affected job identity is known, the strategy can publish one
`executor-unavailable` failure proposal per affected worker while intake
remains open.

If the rejection leaves uncertain external execution, uncertain-spawn recovery
applies instead.

### 10.10 Spawn acknowledgement lost

Recovery applies exact candidate cardinality. It never spawns a second group
solely because the initiating process did not receive a reply.

### 10.11 Multiple matching Pi executions

The strategy reports an adoption conflict and requests quarantine. It never
chooses the first event, newest timestamp, or shortest path.

### 10.12 Pi run identity unavailable

Recovery uses other exact correlations guaranteed by the Dependency Contract.
The strategy leaves `piRunId` absent and does not synthesize one.

### 10.13 One child fails while peers run

The failed child is reconciled independently. Collect-all execution keeps peers
running unless the current owner issues a closed stop request.

### 10.14 Provider fallback exhausted

A trustworthy terminal provider-exhaustion fact becomes a
`provider-exhausted` worker failure proposal. Retry classification remains a
core decision.

### 10.15 Pi runtime budget exhausted

When the committed Pi runtime limit expires, the adapter requests technical
stop and reconciles the child. A trustworthy timeout caused by the attempt's
execution window becomes `deadline-exceeded`; ambiguous termination remains
under bounded reconciliation until the Runner closes intake or quarantines a
protocol breach.

### 10.16 Child reports completed without valid output

The strategy publishes `invalid-executor-output` when identity and terminal
status are trustworthy. It does not publish a success with `null`, empty text,
or guessed JSON.

### 10.17 Child remains paused

The job remains non-terminal. At Runner deadline closure, the adapter requests
stop or interrupt and performs bounded reconciliation. The owner, not the
adapter, creates any missing deadline outcome after intake has closed.

### 10.18 External artifact adds unknown fields

Known required semantics are parsed and unknown compatible extensions are
tolerated. The record is not rejected merely for additive fields.

### 10.19 External artifact is corrupt or impossible

A job-local output defect becomes `invalid-executor-output` when identity is
safe. Corruption of launch identity, lifecycle authority, or candidate
cardinality causes quarantine.

### 10.20 Unknown external event

A non-semantic compatible event is ignored and audited at bounded verbosity. An
unknown terminal state is never ignored because it can change terminality.

### 10.21 Raw output arrives before deadline but publication is late

If intake has closed before the publication transaction, the submission is
rejected. Pi internal timestamps do not reopen intake. The output remains
available only for diagnostics.

### 10.22 Duplicate raw or submission content

Identical canonical content under the same launch and job converges. Divergent
content under the same identity is a conflict and cannot be selected by arrival
order.

### 10.23 Late output from a replaced launch

The output is ineligible and diagnostic only. It cannot affect the current
launch, submission, or outcome set.

### 10.24 Replacement requested after adoption

The request is rejected under the generic transaction mutex. The eligible
launch remains fixed for the remainder of that attempt.

### 10.25 Stop request succeeds

The adapter records terminal stopped observations where available and returns
the reconciliation report. It does not infer the Runner's final failure cause
from the technical stop alone.

### 10.26 Stop request times out

Known unresolved execution is recorded for orphan cleanup. The bounded stop
window does not delay Runner terminal outcomes indefinitely.

### 10.27 RPC connection lost after dispatch

The adapter reconnects within bounded policy and reconciles durable artifacts.
It does not assume that connection loss stopped children.

### 10.28 Adapter crash after submission publication

The immutable generic submission survives. A successor can adopt it under a
new owner fence without re-executing the child.

### 10.29 Adapter crash before submission publication

A successor revalidates durable Pi evidence and repeats normalization and
publication. If intake closed meanwhile, publication is rejected and the owner
uses the closed terminal cause.

### 10.30 Strategy state corruption

The workset is quarantined. Pi events are not replayed to invent missing
strategy authority.

### 10.31 Path escape or symlink substitution

The artifact is rejected under generic confinement rules. No uncontrolled path
is opened or projected into a submission.

### 10.32 Unclassifiable trustworthy job failure

The strategy can use the closed `unknown` execution failure code with a bounded
message and diagnostic reference. It cannot use `unknown` to hide launch,
identity, or authority ambiguity; those conditions quarantine.

## 11. Cross-Cutting Concerns

### 11.1 Idempotence

Stable semantic identities exist for group intent, executor intent, launch,
observation, evidence, and generic submission.

Repeated profile resolution, launch reconciliation, observation construction,
and submission publication compare canonical identities and digests before
converging or conflicting.

The strategy promises no exactly-once LLM execution.

### 11.2 Determinism

Manifest job order determines child construction and normalized result order.
Completion, event, filesystem discovery, and provider fallback order do not
change job identity or executor commitment.

Candidate selection uses exact cardinality rather than earliest or latest
observation.

### 11.3 Resource bounds

The NIBs define closed limits for:

- worker count;
- concurrency;
- startup retries;
- RPC reply size;
- lifecycle artifact size;
- raw output size;
- JSON depth and collection sizes;
- observation attempts;
- stop and reconciliation duration;
- diagnostic size and retention.

All external bytes are bounded before unbounded parsing or canonicalization.

### 11.4 Path safety

All external paths resolve from committed Runner or strategy records. Child
input cannot supply an arbitrary path to read, publish, or commit.

Launch namespaces reject traversal, absolute path substitution, and symlink
escape through the CDD-I safe-open contract.

### 11.5 Security and secrets

Owner tokens, provider credentials, unrestricted local paths, raw model context,
and secrets never enter child prompts, Pi observations, semantic digests, final
messages, or audit events.

Tool capabilities originate in approved configured profiles. A manifest profile
name cannot elevate them dynamically.

### 11.6 Observability

The strategy emits bounded audit facts for:

- capability verdicts;
- profile commitment;
- launch intent and acknowledgement;
- launch adoption, supersession, or orphaning;
- lifecycle reconciliation;
- job observation;
- raw output normalization;
- submission publication;
- stop and cleanup results;
- conflicts and quarantine requests.

Audit events reference identities and confined evidence rather than embedding
prompts, payloads, credentials, or large Pi artifacts. Events never replace the
strategy snapshot.

### 11.7 Cleanup and retention

Cleanup is launch-aware and idempotent. Eligible launches, pending submissions,
committed execution evidence, unresolved orphans, and quarantine artifacts
remain retained while referenced.

A superseded launch can be removed only after generic state proves that no
pending adoption, outcome, resume, or diagnostic retention obligation refers to
it.

### 11.8 Schema evolution

Pi strategy records are strict and explicitly versioned. External Pi records use
the extension rules in the Dependency Contract.

A dependency version that changes required semantics, terminal states, artifact
visibility, or operation behavior requires an updated Dependency Contract and a
strategy compatibility decision before runtime acceptance.

### 11.9 PII discipline

Human-facing failure messages are bounded and carry only the minimum identities
needed for diagnosis. Long provider or child output is stored as confined
diagnostic evidence and referenced by digest.

## 12. Proof of Logic

### 12.1 Successful worker group with overlapping host

```text
Runner prepares one host job and two Pi worker jobs
Pi strategy commits one group and two executor digests
current owner commits launch 1 intent
adapter launches one static collect-all Pi group
host executes independently through the generic Runner path
both Pi children terminate with valid outputs
adapter publishes two generic worker submissions
current owner adopts host and worker submissions
current owner commits all outcomes and joins
Runner resumes the exact Turnlock attempt
```

The Pi strategy never schedules the host, evaluates the global barrier, or
resumes Turnlock.

### 12.2 Crash after spawn before acknowledgement persistence

```text
launch 1 dispatch intent is durable
Pi accepts the group
adapter crashes before persisting returned run identity
successor finds one exact durable candidate
successor binds that candidate to launch 1
observation and publication continue
```

No replacement launch is created merely because the RPC reply was lost.

### 12.3 Safe replacement before adoption

```text
launch 1 is known and terminally unusable
no launch 1 submission has been adopted
no launch 1 outcome has been committed
resolver and workspace commitments still match
current owner marks launch 1 superseded
current owner commits launch 2 intent with disjoint paths
launch 2 becomes eligible
```

A late launch 1 output remains diagnostic and cannot publish.

### 12.4 Replacement rejected after one adoption

```text
launch 1 publishes job A
current owner adopts job A submission
launch 1 later becomes technically uncertain for job B
replacement is requested
```

The request is rejected because mixing launch 1 job A with launch 2 job B would
combine two nondeterministic executions in one workset.

### 12.5 Deadline with paused child

```text
job A publishes successfully
job B remains paused
Runner deadline arrives
current owner performs final scan and closes intake
adapter requests Pi stop and reconciles for a bounded period
job B remains unresolved
owner commits deadline outcome for job B
orphan cleanup continues independently
```

Paused Pi lifecycle does not block Turnlock retry resolution without bound.

### 12.6 Provider exhaustion and successful peer

```text
job A exhausts Pi provider fallback
job B completes successfully
adapter publishes provider-exhausted for A
adapter publishes success for B
current owner commits both final outcomes
core classifies the complete outcome set
```

The adapter reports execution facts and does not decide whether the delegation
retries.

### 12.7 Late publication loses to intake closure

```text
Pi child completes before the deadline
adapter has not yet published its generic submission
current owner closes intake at the deadline under the mutex
adapter later attempts publication
```

Publication is rejected. The child's internal completion timestamp does not
reopen intake.

## 13. Dependencies and Extraction Map

### 13.1 Parent CDD-O

CDD-O remains authoritative for:

- core neutrality;
- identity hierarchy;
- global topology;
- final outcome semantics;
- failure taxonomy and aggregate classification;
- retry and resume.

### 13.2 Parent CDD-I

CDD-I remains authoritative for:

- generic workset state;
- owner lease and fencing;
- transaction mutex;
- intake;
- generic submissions;
- adoption and final outcomes;
- all-terminal join;
- durable handoff and delivery;
- attempt-oriented resume;
- generic artifact, workspace, and digest contracts.

### 13.3 Pi-subagents Dependency Contract

The Dependency Contract owns:

- exact package release and verified source identity;
- public RPC operation names and request or reply shapes;
- protocol version negotiation;
- static parallel-group request fields;
- lifecycle state and event schemas;
- artifact locations and durability guarantees;
- spawn acknowledgement semantics;
- candidate-correlation guarantees;
- stop and interrupt semantics;
- additive-field and incompatible-version rules;
- fixtures for status, results, events, pause, stop, and recovery.

Runtime startup performs only the bounded compatibility handshake described in
this CDD. CI performs the complete contract verification.

### 13.4 Pi strategy NIB lot

The Pi construction briefs own exact:

- adapter module boundaries and signatures;
- strict internal schemas;
- profile resolver algorithm;
- group and job commitment schemas;
- digest subjects;
- launch state transitions;
- artifact namespaces;
- RPC invocation sequence;
- observation normalization;
- failure-code mapping;
- publication transactions;
- stop, reconciliation, orphan, and cleanup algorithms;
- constants, limits, errors, and audit events.

### 13.5 Generic Runner and core NIB lots

The strategy NIBs consume but do not redefine generic owner, mutex, intake,
submission, outcome, join, resume, and core failure contracts.

## 14. Testing Strategy

### 14.1 Preflight coverage

Acceptance tests cover:

- worker-only and mixed worksets;
- one static group construction;
- `direct` target rejection;
- internal dependency rejection;
- fresh context enforcement;
- collect-all enforcement;
- unknown profile or agent;
- incompatible tools or permissions;
- insufficient deadline margin;
- workspace drift before dispatch;
- dependency absence, version mismatch, and missing capabilities;
- zero external side effects after any failed preflight.

### 14.2 Commitment coverage

Tests prove that:

- known resolver inputs affect `agentResolverInputDigest`;
- runtime bindings and observations do not affect executor digests;
- every job digest commits group and job inputs;
- actual fallback model does not rewrite committed model selector;
- resolver drift blocks same-attempt replacement;
- secrets and absolute runtime paths are absent from commitments.

### 14.3 Group construction coverage

Tests prove:

- one child entry exists per worker job;
- manifest order is stable;
- each child receives only its own task;
- output paths are launch-specific;
- concurrency is bounded;
- fail-fast is disabled;
- context is fresh;
- host jobs and resume commands never enter the Pi request;
- no Turnlock scheduling loop is created around individual children.

### 14.4 Launch crash-window coverage

Fixtures place crashes:

- before launch intent commit;
- after intent and before spawn;
- after spawn and before acknowledgement persistence;
- after acknowledgement and before `spawned` snapshot;
- after raw output and before observation;
- after observation and before submission;
- after submission and before adapter acknowledgement;
- during supersession;
- during stop and orphan recording.

Each fixture specifies the exact repeatable operation and next stable state.

### 14.5 Candidate and supersession coverage

Tests cover:

- zero, one, and multiple exact candidates;
- no timestamp-based winner;
- one eligible launch invariant;
- disjoint namespaces across launches;
- replacement before adoption;
- rejection after any launch submission adoption;
- rejection after any launch-sourced outcome;
- late superseded and orphaned output;
- known orphan versus ambiguous candidate.

### 14.6 Artifact compatibility coverage

Dependency fixtures cover:

- required known fields;
- additive unknown fields;
- unknown non-semantic events;
- missing required fields;
- invalid types;
- incompatible versions;
- corrupt records;
- impossible transitions;
- unknown terminal states;
- changed terminal artifacts;
- missing and oversized raw outputs.

### 14.7 Lifecycle and failure coverage

Tests cover:

- completed, failed, stopped, and paused children;
- provider fallback success and exhaustion;
- group launch rejection;
- one failed child with successful peers;
- completed child without output;
- malformed and duplicate-key output;
- connection loss with durable recovery;
- runtime limit expiry;
- deadline and user-cancellation stop;
- bounded stop timeout and orphan report;
- failure proposals without a retryability field.

### 14.8 Publication coverage

Tests prove that:

- only the eligible launch can publish;
- publication uses the generic mutex contract;
- publication before closure is receivable;
- publication after closure is rejected;
- identical publication converges;
- divergent publication conflicts;
- strategy publication cannot mutate owner-only workset state;
- raw Pi output alone never satisfies intake or join.

### 14.9 Security and resource coverage

Tests cover:

- traversal and absolute path injection;
- symlink substitution;
- output and artifact size limits;
- bounded retries and reconciliation;
- owner token absence from Pi requests and artifacts;
- credential absence from records and logs;
- staging isolation from workspace commitment roots;
- bounded diagnostic messages.

### 14.10 Property coverage

Property tests permute child completion, event arrival, artifact discovery,
adapter restart, and submission publication order. For equivalent durable Pi
evidence, every permutation produces the same eligible launch, per-job
observation identities, normalized submission digests, and generic outcome
inputs.

## 15. Guarantees and Limitations

### 15.1 Guaranteed conceptual properties

- Pi-subagents owns child scheduling and technical lifecycle.
- One workset attempt has one logical Pi group.
- One static child entry represents each worker job.
- Fresh context and collect-all behavior are fixed for version 1.
- Committed intent excludes runtime and observed facts.
- Every worker job has one cross-strategy executor digest.
- At most one technical launch is eligible at a time.
- No launch replacement can occur after adoption or outcome commit from that
  launch.
- Launch namespaces are disjoint.
- External artifacts are consumed through a bounded, versioned contract.
- Paused children are non-terminal.
- Raw output becomes receivable only through generic submission publication.
- Deadline closure precedes stop and bounded reconciliation.
- The strategy reports execution facts but never decides core retry.

### 15.2 Explicit limitations

- LLM execution can occur more than once.
- Fresh context omits host conversation context.
- The effective Pi configuration can contain dependency-owned defaults not
  exposed for commitment.
- Workspace read-only behavior is cooperative.
- Runtime RPC availability is not itself durable proof.
- An ambiguous external launch can require quarantine and human diagnosis.
- Stop can leave a known orphan process requiring later cleanup.
- No Pi timestamp can override Runner intake ordering.
- Version 1 has no partial worker retry, successful result reuse, nested group,
  dynamic fanout, or strategy fallback.

## 16. Glossary

### Agent resolver input digest

Digest of every known, approved input used to resolve a neutral worker profile
before dispatch. It is not a claim of complete effective Pi configuration.

### Eligible launch

The only Pi launch whose evidence can produce receivable worker submissions for
the current workset.

### Group specification

Committed pre-dispatch context shared by all Pi worker jobs in one static
parallel group.

### Launch

One concrete technical attempt to execute the committed Pi group. Multiple
launches can exist for recovery, but only one can remain eligible.

### Observation

Per-job record derived from Pi lifecycle and result artifacts. It describes
observed execution without claiming cryptographic attestation.

### Orphaned launch

Known ineligible launch that can no longer participate in outcomes and requires
separate technical cleanup.

### Pi strategy state

Strict Runner-owned snapshot containing Pi commitments, launch records, and
eligibility behind the generic `strategyStateRef`.

### Raw output

Launch-specific child artifact produced by Pi. It is not a Runner submission or
final outcome.

### Superseded launch

Known prior launch made permanently ineligible before any adoption or outcome
locked it as the workset's execution source.

## 17. Baseline Criteria

This CDD becomes `baselined` only when:

- every inherited boundary agrees with CDD-O and CDD-I;
- the Dependency Contract can express every required Pi operation and recovery
  guarantee without private API assumptions;
- one-group topology, fresh context, collect-all behavior, and cooperative
  read-only execution have no unresolved exception;
- resolver commitments do not overclaim effective Pi configuration;
- intent, runtime bindings, and observations remain disjoint;
- launch eligibility and supersession have one deterministic owner and no state
  duplication with generic adoption records;
- every spawn crash window has one fail-closed recovery response;
- paused, stopped, late, malformed, missing, and ambiguous Pi results have
  deterministic outcomes;
- no Pi-specific lifecycle field leaks into core state or the generic Runner
  interface;
- no worker, child, or adapter path can adopt, commit, join, or resume;
- the complete three-document CDD corpus passes claim verification and a fresh
  blind-spot sweep with zero blocking findings.
