---
okf_version: "1.0"
kind: "RuntimeArtifact"
format: "cubits-design-doc"
workspace: "turnlock"
date: "2026-07-21"
step_id: 0
id: "CDD-S-PI-SUBAGENTS-EXECUTION"
version: "0.3.0"
scope: "pi-subagents-execution-strategy"
status: "draft"
consumers:
  - "agent-generator"
superseded_by: []
---

# CDD-S: Pi Subagents Execution

## 1. Objectif & Position

This strategy implements only the worker-execution capability defined by
[CDD-I Turnlock External Execution Strategy](../../runner/cdd-i-turnlock-external-execution-strategy.md).
It does not implement the complete Runner orchestration.

The strategy translates one committed worker subset into one asynchronous,
static, collect-all pi-subagents group. Pi-subagents owns child scheduling,
model fallback, and technical lifecycle. The strategy owns profile resolution,
launch correlation, durable observation, normalization, and generic worker
submission proposals.

The strategy is currently not admissible for dispatch. The inspected fork
`pi-subagents` 0.35.1 at commit
`2842823d421ed01619f6cc58c15dab850cef7eaa` generates its own run identity and
uses destructive result consumption. The active dependency contract records
that incompatibility. Preflight must return `dependency-unavailable` until a
new fork release provides the required versioned integration API and a
superseding compatible Dependency Contract.

### Authority boundary

- The Runner workset selects the authoritative Pi strategy-state commitment.
- Pi state candidates describe technical launches but cannot select themselves.
- Pi-subagents artifacts are external evidence, not Runner authority.
- Workers write only launch-specific raw output.
- The strategy proposes generic submissions but cannot adopt them.

## 2. Goals & Non-Goals

### Goals

- Resolve every worker profile before dispatch.
- Commit one static group and one executor digest per worker job.
- Use fresh child context and collect-all behavior.
- Commit caller-controlled launch correlation before spawn.
- Maintain exactly one eligible launch per workset consistency unit.
- Recover uncertain acknowledgement by caller launch key.
- Consume non-destructive durable per-job output.
- Normalize per-job lifecycle into success or closed factual failure.
- Publish generic worker submission proposals through Runner intake.
- Stop and reconcile running or paused children within policy.
- Preserve late, superseded, orphaned, and ambiguous evidence safely.

### Non-goals

- Host execution.
- Generic Runner ownership, intake, adoption, outcomes, terminal selection,
  resume, delivery, or operator disposition.
- Dynamic fanout, nested groups, dependent children, or fail-fast behavior.
- Multiple logical Pi groups per workset.
- Direct model execution outside pi-subagents.
- Partial job retry or successful-peer reuse.
- Model/provider fallback chosen by the Runner.
- Exactly-once LLM execution.
- Private pi-subagents imports, TUI scraping, or watcher timing as API.
- Dispatch against the currently incompatible fork commit.

## 3. Data Contracts (Inputs & Outputs)

### Activation input

The strategy inherits `ExternalStrategyPreflightInputSketch` and
`StrategyActivationAuthorizationSketch` from its parent CDD-I. Only jobs with
neutral target `worker` enter this strategy. Host and direct targets are absent.

### Strategy configuration

The committed configuration contains:

- adapter identity and version;
- active pi-subagents Dependency Contract identity;
- closed worker-profile registry;
- logical profile to Pi agent mapping;
- model selector and requested thinking policy;
- tool, permission, extension, turn, and tool-budget commitments;
- provider profile commitments;
- resource and environment policy digests;
- Pi artifact root binding.

Provider credentials are runtime secrets and never enter persisted state or
semantic digests.

### Resolved group context

```typescript
interface ResolvedTurnBudgetSketch {
  readonly maxTurns: number;
  readonly graceTurns: number;
}

interface ResolvedToolBudgetSketch {
  readonly soft?: number;
  readonly hard: number;
  readonly blockedTools: readonly string[] | "*";
}

interface ResolvedPiGroupContextSketch {
  readonly version: 1;
  readonly adapterKind: "pi-subagents";
  readonly dependencyContractId: string;
  readonly context: "fresh";
  readonly failFast: false;
  readonly durableArtifactsRequired: true;
  readonly workspaceInputCommitment: WorkspaceInputCommitmentV1;
  readonly resourcePolicyDigest: PayloadDigestV1;
  readonly environmentProfileDigest: PayloadDigestV1;
  readonly maximumRuntimeMs: number;
  readonly concurrency: number;
  readonly turnBudget?: ResolvedTurnBudgetSketch;
}
```

`maximumRuntimeMs` satisfies the exact deadline reserve in the permanent
resource policy. Worker count is at most eight and concurrency at most four
under the version-1 default profile; any explicit profile remains within the
same closed standard bounds.

### Resolved worker intent

```typescript
interface ResolvedPiWorkerJobSketch {
  readonly version: 1;
  readonly jobId: string;
  readonly taskDigest: PayloadDigestV1;
  readonly profileName: string;
  readonly agentName: string;
  readonly agentResolverInputDigest: PayloadDigestV1;
  readonly modelSelector: string;
  readonly requestedThinking?: string;
  readonly toolProfileDigest: PayloadDigestV1;
  readonly permissionProfileDigest?: PayloadDigestV1;
  readonly configuredExtensionDigests: readonly PayloadDigestV1[];
  readonly toolBudget?: ResolvedToolBudgetSketch;
  readonly resultContractDigest?: PayloadDigestV1;
  readonly workspaceInputCommitment: WorkspaceInputCommitmentV1;
}
```

The resolver input digest commits known approved inputs without claiming to
capture hidden dependency or provider defaults.

### Executor commitments

```text
groupSpecDigest
  = digest(turnlock:executor-group-spec, resolved group context)

executorSpecDigest(job)
  = digest(turnlock:executor-spec,
      { version, groupSpecDigest, resolved worker job })
```

Runtime IDs, paths, timestamps, actual fallback models, and observations are
excluded.

### Pi strategy state candidate

```typescript
interface PiStrategyStateSketch {
  readonly version: 1;
  readonly worksetId: string;
  readonly attemptId: string;
  readonly groupSpecDigest: PayloadDigestV1;
  readonly executorSpecDigests: Readonly<Record<string, PayloadDigestV1>>;
  readonly eligibleLaunchId?: string;
  readonly launches: readonly PiLaunchRecordSketch[];
}

interface PiStrategyStateCandidateSketch {
  readonly header: StrategyStateCandidateHeaderSketch;
  readonly state: PiStrategyStateSketch;
}
```

Each state is an immutable candidate. `WorksetRecord.strategyState` remains the
sole authority selecting one commitment and revision. No mutable Pi snapshot is
replaced independently.

### Launch record

```typescript
type PiLaunchStateSketch =
  | "dispatch-intent"
  | "accepted"
  | "running"
  | "completed"
  | "failed"
  | "stopped"
  | "superseded"
  | "orphaned";

interface PiLaunchRecordSketch {
  readonly version: 1;
  readonly launchSequence: number;
  readonly launchId: string;
  readonly callerLaunchKey: string;
  readonly requestDigest: PayloadDigestV1;
  readonly groupSpecDigest: PayloadDigestV1;
  readonly state: PiLaunchStateSketch;
  readonly namespaceRef: ArtifactRefV2;
  readonly dependencyExecutionId?: string;
  readonly dependencyAcknowledgementCommitment?: ArtifactCommitmentV2;
  readonly statusCommitment?: ArtifactCommitmentV2;
  readonly resultCommitments: Readonly<Record<string, ArtifactCommitmentV2>>;
  readonly dispatchedAtEpochMs: number;
  readonly updatedAtEpochMs: number;
}
```

`callerLaunchKey` is allocated and committed by Turnlock before calling the
dependency. The dependency-generated execution ID is secondary evidence and
never the sole recovery key.

### Dependency integration surface

A compatible pi-subagents dependency must expose versioned operations equivalent
to:

```typescript
interface CapabilityReplySketch {
  readonly apiVersion: "turnlock-pi-subagents-v1";
  readonly dependencyVersion: string;
  readonly sourceCommit: string;
  readonly capabilities: {
    readonly callerCommittedLaunchKey: true;
    readonly idempotentLaunch: true;
    readonly durableAcknowledgement: true;
    readonly restartSafeInspect: true;
    readonly retainedPerJobResults: true;
    readonly idempotentStop: true;
    readonly explicitRetentionAcknowledgement: true;
  };
}

interface LaunchJobRequestSketch {
  readonly jobId: string;
  readonly agentName: string;
  readonly task: string;
  readonly modelSelector: string;
  readonly requestedThinking?: string;
  readonly rawResultTarget: ArtifactTargetRefV1;
  readonly resultContractDigest?: PayloadDigestV1;
}

interface LaunchRequestSketch {
  readonly apiVersion: "turnlock-pi-subagents-v1";
  readonly callerLaunchKey: string;
  readonly requestDigest: PayloadDigestV1;
  readonly groupSpecDigest: PayloadDigestV1;
  readonly context: "fresh";
  readonly failFast: false;
  readonly concurrency: number;
  readonly deadlineAtEpochMs: number;
  readonly jobs: readonly LaunchJobRequestSketch[];
}

type LaunchReplySketch =
  | {
      readonly kind: "accepted" | "already-accepted";
      readonly callerLaunchKey: string;
      readonly requestDigest: PayloadDigestV1;
      readonly dependencyExecutionId: string;
      readonly durableRecordCommitment: ArtifactCommitmentV2;
    }
  | {
      readonly kind: "conflict";
      readonly callerLaunchKey: string;
      readonly existingRequestDigest: PayloadDigestV1;
    };

type DependencyJobStateSketch =
  | "queued"
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "stopped";

interface LaunchSnapshotSketch {
  readonly callerLaunchKey: string;
  readonly requestDigest: PayloadDigestV1;
  readonly dependencyExecutionId: string;
  readonly state:
    | "accepted"
    | "running"
    | "completed"
    | "failed"
    | "stopped";
  readonly jobs: readonly {
    readonly jobId: string;
    readonly state: DependencyJobStateSketch;
  }[];
  readonly snapshotCommitment: ArtifactCommitmentV2;
}

type JobResultSketch =
  | { readonly kind: "not-terminal" }
  | {
      readonly kind: "available";
      readonly jobId: string;
      readonly terminalState: "completed" | "failed" | "stopped";
      readonly resultCommitment: ArtifactCommitmentV2;
    };

interface StopReplySketch {
  readonly callerLaunchKey: string;
  readonly state: "stopping" | "stopped" | "already-terminal";
  readonly snapshotCommitment: ArtifactCommitmentV2;
}

interface RetentionReplySketch {
  readonly callerLaunchKey: string;
  readonly acknowledgedResultDigests: Readonly<Record<string, string>>;
  readonly earliestCleanupAtEpochMs: number;
  readonly receiptCommitment: ArtifactCommitmentV2;
}

interface TurnlockPiSubagentsIntegrationSketch {
  capabilities(): Promise<CapabilityReplySketch>;
  launchStaticGroup(request: LaunchRequestSketch): Promise<LaunchReplySketch>;
  inspectLaunch(callerLaunchKey: string): Promise<LaunchSnapshotSketch>;
  readJobResult(callerLaunchKey: string, jobId: string): Promise<JobResultSketch>;
  stopLaunch(callerLaunchKey: string, reason: string): Promise<StopReplySketch>;
  acknowledgeRetention(
    callerLaunchKey: string,
    resultDigests: Readonly<Record<string, string>>,
  ): Promise<RetentionReplySketch>;
}
```

Every `rawResultTarget` is Runner-relative with purpose
`strategy-raw-result`, belongs to the selected launch namespace, and remains
pairwise distinct. `launchStaticGroup` is idempotent for equal caller key and
request digest and conflicting for divergence. Acceptance is acknowledged only
after a durable launch record exists. `inspectLaunch` and result reads remain
valid across controller and dependency restart. Each result commitment resolves
from the Runner-allocated `rawResultTarget` inside the selected launch
namespace. Result reads do not delete or mutate
result artifacts. Cleanup occurs only after explicit retention acknowledgement
and the contractual retention floor.

### Observation and execution evidence

```typescript
interface PiJobExecutionEvidenceSketch {
  readonly version: 1;
  readonly worksetId: string;
  readonly attemptId: string;
  readonly launchId: string;
  readonly callerLaunchKey: string;
  readonly jobId: string;
  readonly groupSpecDigest: PayloadDigestV1;
  readonly executorSpecDigest: PayloadDigestV1;
  readonly dependencyStatusCommitment: ArtifactCommitmentV2;
  readonly dependencyResultCommitment?: ArtifactCommitmentV2;
  readonly normalizedObservationCommitment: ArtifactCommitmentV2;
}
```

The generic worker proposal points to this commitment. Paused or running jobs
have no terminal evidence.

### Outputs

The strategy outputs only:

- capability verdicts;
- group and executor commitments;
- immutable state candidates;
- launch acknowledgements and observations;
- worker submission proposals;
- stop and reconciliation reports;
- orphan, conflict, and diagnostic evidence.

It outputs no final outcome, terminal envelope, owner transition, or resume
request.

## 4. Pipeline

### 1. Capability and dependency preflight

The adapter validates exact environment, resource, Dependency Contract, public
operation versions, launch idempotency, durable status, non-destructive results,
retention, stop, and restart guarantees. The current 0.35.1 fork fails this step
before any external side effect.

### 2. Topology and profile preflight

The adapter requires one non-empty worker subset, one static independent group,
fresh context, collect-all behavior, common workspace and deadline domains,
cooperative read-only compatibility, and policy-bounded concurrency.

Every profile resolves to an available Pi agent, committed model selector,
approved tools and permissions, configured extensions, provider profile, and
result policy. Any failure rejects the whole worker subset.

### 3. Intent commitment

The adapter constructs group and job intent, calculates every digest, publishes
an initial strategy-state candidate, and returns the capability verdict. No Pi
process starts.

The Runner selects the initial candidate and executor digests in the prepared
workset before activation.

### 4. Launch-intent candidate

With a fresh Runner authorization, the adapter loads the selected state,
allocates the next `launchId`, caller launch key, request digest, and disjoint
namespace, then publishes a `dispatch-intent` candidate. The Runner verifies the
expected predecessor and atomically selects it.

### 5. Static group construction

The adapter builds exactly one asynchronous static group containing one child
per manifest worker job in manifest order. Each child receives its own task,
agent, committed model selector, requested thinking, approved tools,
launch-specific output identity, fresh context, and strict structured-result
contract.

The request contains no host job, peer dependency, dynamic fanout, final core
target, owner token, or resume operation.

### 6. Idempotent launch

Only after the dispatch-intent candidate is selected does the adapter call
`launchStaticGroup` with `callerLaunchKey` and `requestDigest`.

- A first equal request creates one durable dependency launch.
- A repeated equal request returns the same launch identity and status.
- A repeated divergent request returns conflict and creates no launch.
- Lost acknowledgement is recovered with `inspectLaunch(callerLaunchKey)`.

The accepted acknowledgement becomes an immutable candidate selected by the
Runner before later observations gain authority.

### 7. Lifecycle observation

Live events are hints. The adapter repeatedly inspects durable status under the
resource policy and publishes state candidates through expected-predecessor
transitions. Each child is observed independently; one failure does not stop
peers.

Unknown additive fields are tolerated only when the Dependency Contract allows
them. Missing required fields, impossible transitions, unknown terminal states,
or changed committed facts fail closed.

### 8. Result reconciliation

For each terminal child, the adapter reads its retained result non-destructively,
bounds bytes, validates strict UTF-8 and JSON, verifies job and launch
correlation, and commits exact dependency status and result artifacts.

It normalizes:

- valid completed structured output to success;
- provider fallback exhaustion to `provider-exhausted`;
- maximum runtime expiry to `deadline-exceeded`;
- budget exhaustion to `budget-exceeded`;
- completed status without valid required output to
  `invalid-executor-output`;
- trustworthy dependency protocol failure to `protocol-failure`;
- otherwise trustworthy unclassifiable failure to `unknown`.

Identity or eligibility ambiguity requests quarantine instead of normalization.

### 9. Submission proposal

The adapter publishes immutable execution evidence and asks the generic Runner
publisher to publish one worker submission. The Runner revalidates selected
launch, executor digest, intake, deadline, workspace, result bounds, and
conflict.

A crash after generic publication converges by submission digest. A publication
attempt after intake closure is rejected and remains diagnostic.

### 10. Technical launch finalization

When every child is terminal, the adapter proposes the corresponding launch
state candidate. Technical completion does not close intake, adopt submissions,
commit outcomes, select terminal state, or resume Turnlock.

### 11. Stop and reconciliation

After the Runner has closed intake for deadline, cancellation, rejection, or
quarantine, the adapter invokes idempotent stop by caller launch key, observes
for `stopReconciliationMs`, records terminal evidence, and reports unresolved
known executions as orphans.

Graceful controller handoff skips stop. A successor recovers from selected
strategy state and durable dependency artifacts.

### 12. Retention acknowledgement and cleanup

The strategy acknowledges dependency cleanup only after generic state proves
that all required submissions, outcomes, terminal resume, quarantine,
diagnostics, and policy retention no longer reference dependency results.
Acknowledgement names exact retained result digests. Cleanup does not occur on
read.

## 5. Invariants

1. The complete preflight has zero external side effects.
2. The current incompatible dependency always returns
   `dependency-unavailable`.
3. One logical worker subset maps to one committed static group.
4. Every worker has one cross-strategy executor digest.
5. Pre-dispatch intent excludes runtime and observed facts.
6. Strategy state is immutable and authoritative only through workset selection.
7. External spawn requires a selected dispatch-intent candidate.
8. Caller launch key and request digest precede spawn.
9. Equal launch replay is idempotent; divergent replay creates no second launch.
10. At most one launch is eligible to publish at a time.
11. Launch replacement is forbidden after any submission from the consistency
    unit is adopted or any related outcome is committed.
12. Launch namespaces are disjoint.
13. Durable dependency evidence, not live notifications, proves terminality.
14. Results remain readable and unchanged until explicit retention
    acknowledgement.
15. A paused child is non-terminal.
16. Raw output alone never satisfies Runner intake.
17. The strategy reports factual codes and no retryability field.
18. Deadline or cancellation closure precedes stop.
19. Graceful ownership handoff causes no stop.
20. No strategy operation adopts, commits, joins, resumes, or delivers.

## 6. Internal Operations

### Launch eligibility

A launch is eligible only when its exact record is selected by the current
strategy-state commitment and `eligibleLaunchId` matches. Superseded, orphaned,
foreign, unselected, or late launch evidence cannot publish.

### Replacement

Replacement is permitted only when:

- the current launch is known and terminally unusable or proven absent;
- no submission from it has been adopted;
- no outcome from it has been committed;
- resolver, workspace, resource, environment, group, and executor commitments
  still match;
- the previous launch becomes durably superseded before the next dispatch
  intent is selected.

Zero exact dependency candidates permits replacement after proof of absence.
One exact candidate is rebound. More than one candidate requests quarantine.
No timestamp winner exists.

### Candidate crash behavior

- Crash before candidate publication leaves no proposed transition.
- Crash after candidate publication but before workset selection leaves an
  orphan candidate with no authority.
- Crash after dispatch-intent selection but before dependency call permits the
  same idempotent call.
- Crash after dependency acceptance but before acknowledgement selection uses
  `inspectLaunch(callerLaunchKey)`.
- Crash after raw result but before submission rereads the retained result and
  republishes identical evidence.

### Dependency failure behavior

| Condition | Strategy response |
| --------- | ----------------- |
| Missing or incompatible contract | `dependency-unavailable` preflight |
| Required operation absent | `capability-mismatch` preflight |
| Launch equal replay | Return same durable launch |
| Launch divergent replay | Conflict; no new launch |
| Acknowledgement lost | Inspect by caller launch key |
| Zero candidates after intent | Prove absence before replacement |
| Multiple exact candidates | Request quarantine |
| Dependency ID missing | Continue only with authoritative caller key |
| Status or result changed | Request quarantine |
| Result deleted before retention ack | Protocol violation and quarantine |
| Unknown additive field | Ignore only when contract permits |
| Unknown terminal state | Protocol failure; do not guess |
| Connection loss | Recover from durable operations and artifacts |
| Stop timeout | Report unresolved known orphan |

### Job failure behavior

| Condition | Normalized fact |
| --------- | --------------- |
| Provider fallback exhausted | `provider-exhausted` |
| External runtime expires | `deadline-exceeded` |
| Tool or turn budget exhausted | `budget-exceeded` |
| Completed without valid strict output | `invalid-executor-output` |
| Trustworthy dependency protocol failure | `protocol-failure` |
| Trustworthy unclassifiable job failure | `unknown` |
| Identity or launch ambiguity | No job failure; request quarantine |

### Workspace drift

Verify the workspace at the standard dispatch, publication/adoption, and final
terminal boundaries. The strategy performs the dispatch and publication checks
assigned to it and requests generic `configuration-drift` rejection for a
trustworthy mismatch. It never refreshes the commitment.

### Late evidence

Evidence from an ineligible launch, after intake closure, or after retention
selection remains diagnostic. It cannot change eligible launch, submission,
outcome, or terminal state.

## 7. Cross-Cutting Concerns

### Idempotence and determinism

Stable identities exist for profile resolution, group intent, executor intent,
state revision, operation, caller launch key, request, observation, execution
evidence, and submission proposal. Manifest order controls group construction.
Completion, event, and directory order do not affect identity.

### Resource bounds

All values come from the committed
[Delegation Resource Policy](../../../../standards/std-turnlock-delegation-resource-policy.md).
No behavior-affecting limit is deferred to NIB invention. External bytes are
bounded before parsing or canonicalization.

### Security and privacy

Approved profiles determine tools and permissions. Manifest input cannot grant
new tools. Owner tokens, credentials, unrestricted paths, raw prompts, private
model context, and unbounded provider output are excluded from Pi requests where
not required, commitments, events, and diagnostics.

### Observability

Bounded events cover preflight, commitment, candidate selection request,
launch, acknowledgement, observation, normalization, submission, stop,
reconciliation, retention acknowledgement, conflict, and quarantine request.
Events never replace selected strategy state.

### Cleanup

Eligible launches, retained dependency results, pending submissions, execution
evidence, unresolved orphans, and quarantine artifacts remain retained while
referenced. Cleanup is explicit, digest-scoped, and non-destructive on read.

## 8. Infrastructure & Environment

The strategy consumes the exact
[Delegation Execution Environment](../../../../standards/std-turnlock-delegation-execution-environment.md),
including macOS 12.7.6 x86_64, Bun 1.3.12, Node.js 22.22.2, Pi 0.80.10, local
APFS, native processes, local IPC, and committed provider profiles.

It also consumes:

- [Artifact Reference and Integrity](../../../../standards/std-turnlock-artifact-reference-and-integrity.md);
- [Canonical JSON and Digest](../../../../standards/std-turnlock-canonical-json-and-digest.md);
- [Workspace Input Commitment](../../../../standards/std-turnlock-workspace-input-commitment.md);
- [Runner Coordination](../../../../standards/std-turnlock-runner-coordination.md).

Strategy control and dependency artifacts remain outside committed workspace
inputs or inside one committed exclusion. Recovery never depends on the
original RPC connection or in-memory event stream.

## 9. Dependencies

### Parent documents

- [CDD-O Turnlock Delegation Attempt Execution](../../cdd-o-turnlock-delegation-attempt-execution.md);
- [CDD-O Turnlock Runner Execution](../../runner/cdd-o-turnlock-runner-execution.md);
- [CDD-I Turnlock External Execution Strategy](../../runner/cdd-i-turnlock-external-execution-strategy.md).

### Pi-subagents contract

[DC-PI-SUBAGENTS](../../../../dependencies/dc-pi-subagents.md) pins and describes
the inspected 0.35.1 fork as incompatible. A superseding contract may report
compatibility only after an actual fork release proves:

- caller-committed launch correlation;
- equal-request idempotency and divergent conflict;
- durable acknowledgement before return;
- restart-safe inspect and stop;
- non-destructive per-job structured results;
- explicit retention acknowledgement;
- complete fixtures and conformance tests.

The strategy remains disabled and this CDD remains `draft` until that contract
exists. A broker around the unmodified dependency is not an approved substitute.

### Construction extraction

Future NIBs may define exact schemas and module signatures only after the
Dependency Contract is compatible. They do not invent operations, limits,
recovery guarantees, or private API use.

## 10. Testing Strategy

### Generic interface conformance

Run every parent-interface test for side-effect-free preflight, commitment
coverage, candidate selection, launch correlation, observation, proposal,
reconciliation, and privilege boundaries.

### Dependency admission

Tests pin the current commit and prove it is rejected. A future compatible
fixture suite must prove exact package/source identity, capability negotiation,
caller key idempotency, divergent conflict, durable acknowledgement,
non-destructive result reads, restart recovery, stop, and retention.

### Crash windows

Place crashes:

- before and after every state-candidate publication and workset selection;
- before dependency call;
- after dependency acceptance before acknowledgement receipt;
- after acknowledgement before candidate selection;
- after status and result publication;
- before and after execution evidence;
- before and after generic submission publication;
- during supersession, stop, reconciliation, retention acknowledgement, and
  graceful controller handoff.

### Lifecycle and normalization

Cover completed, failed, stopped, paused, provider-exhausted, budget-exhausted,
timed-out, malformed, missing, oversized, changed, and unknown result states.
Prove paused remains non-terminal and ambiguity never becomes ordinary failure.

### Eligibility and replacement

Cover zero, one, and multiple exact candidates; no timestamp winner; disjoint
namespaces; safe replacement before adoption; replacement refusal after
adoption; late superseded output; known orphan; and unresolved ambiguity.

### Property tests

Permute child completion, live event, artifact discovery, adapter restart,
controller takeover, and submission publication. Equivalent durable dependency
evidence must produce the same selected launch, observations, execution
evidence, and submission digests.

The CDD cannot become `baselined` while the active Dependency Contract verdict
is incompatible or any required conformance vector lacks an actual dependency
implementation.

## 11. Glossary

### Caller launch key

Turnlock-allocated idempotency and recovery identity committed before dependency
spawn.

### Dependency execution ID

Secondary identifier returned by pi-subagents; never the sole correlation
authority.

### Eligible launch

Only selected launch whose evidence may produce generic worker submissions.

### Pi strategy state

Immutable technical snapshot candidate selected through the generic workset.

### Raw output

Dependency-produced launch-specific bytes that are not yet generic submissions.

### Retention acknowledgement

Explicit digest-scoped permission allowing the dependency to collect results
after all Turnlock references are released.

### Superseded launch

Prior launch made permanently ineligible before any adoption or outcome fixed it
as the consistency source.
