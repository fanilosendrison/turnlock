---
okf_version: "1.0"
kind: "RuntimeArtifact"
format: "cubits-design-doc"
workspace: "turnlock"
date: "2026-07-21"
step_id: 0
id: "CDD-N-TURNLOCK-WORKSET-PREPARATION"
version: "0.1.0"
scope: "workset-preparation"
status: "draft"
consumers:
  - "agent-generator"
superseded_by: []
---

# CDD-N: Turnlock Workset Preparation

## 1. Objectif & Position

This node converts one admitted workset and one side-effect-free external
strategy capability verdict into either a complete prepared workset, a trusted
attempt-rejection request, or an ambiguity request.

It is a worker node of
[CDD-O Turnlock Runner Execution](cdd-o-turnlock-runner-execution.md). The Runner
orchestrator obtains the strategy verdict before invoking this node. The node
performs no host delivery, external spawn, terminal selection, or core resume.

## 2. Goals & Non-Goals

### Goals

- Complete every generic and host preflight before activation.
- Validate the strategy verdict against the admitted worker subset.
- Commit one executor digest per dispatchable job.
- Select the initial immutable strategy-state candidate.
- Commit one complete `prepared` snapshot atomically.
- Return closed trusted rejection or ambiguity evidence without side effects.

### Non-goals

- Calling the external dependency or strategy.
- Host ticket creation or continuation delivery.
- Opening intake or launching workers.
- Selecting attempt-terminal state.
- Submission adoption, outcomes, resume, or cleanup.

## 3. Data Contracts (Inputs & Outputs)

### Input

```typescript
interface WorksetPreparationInputSketch {
  readonly admittedWorksetCommitment: ArtifactCommitmentV2;
  readonly strategyVerdict?: StrategyCapabilityVerdictSketch;
  readonly resultContractCommitments: Readonly<
    Record<string, ArtifactCommitmentV2>
  >;
  readonly currentOwnerGeneration: number;
}
```

`strategyVerdict` is absent only for a host-only workset. A worker-containing
workset requires one verdict matching every worker job exactly.

### Prepared output

The prepared snapshot contains:

- the unchanged admitted attempt and target commitments;
- validated resource, environment, and workspace commitments;
- one complete host executor digest when a host job exists;
- one strategy executor digest per worker job;
- the selected initial strategy-state commitment and revision when workers
  exist;
- immutable result-contract commitments;
- closed topology and branch counts;
- pending intake, terminal, resume, and quarantine records.

### Trusted rejection request

```typescript
interface PreparationRejectionRequestSketch {
  readonly attemptId: string;
  readonly worksetId: string;
  readonly proposedCode: AttemptRejectionCodeSketch;
  readonly evidenceCommitment: ArtifactCommitmentV2;
}
```

The downstream outcome node validates and selects the rejection. This node does
not write terminal state.

### Ambiguity request

An ambiguity output commits bounded evidence showing why attempt, policy,
workspace, strategy, result-contract, or candidate identity cannot be trusted.
The Runner orchestrator routes it to quarantine handling.

## 4. Pipeline

1. Safe-open the admitted workset and verify current owner generation.
2. Revalidate manifest, typed targets, deadline, resource policy, environment
   profile, workspace commitment, and result-contract commitments.
3. Enforce version-1 topology: at most one host job, at least one total job, at
   most eight worker jobs, at most one external strategy group, and no `direct`
   target.
4. Resolve the host execution specification and executor digest when present.
5. For worker jobs, validate one supported strategy verdict, exact worker-set
   membership, dependency contract identity, group commitment, one executor
   digest per job, and one initial state candidate.
6. Verify that no external side effect or host event exists for the admitted
   workset.
7. Recompute the workspace boundary immediately before preparation.
8. Acquire the transaction mutex and reload owner and admitted state.
9. Publish immutable preparation evidence and host executor specification.
10. Select the initial strategy candidate with revision one when applicable.
11. Atomically replace the admitted snapshot with the complete prepared
    snapshot.
12. Return the prepared commitment to the Runner orchestrator.

A trustworthy negative check returns a rejection request before steps 9–11.
Identity or integrity ambiguity returns an ambiguity request.

## 5. Invariants

1. Preparation performs no host delivery or external spawn.
2. A prepared workset contains every required executor digest.
3. A partial worker subset is never prepared.
4. Host and worker profile resolution is complete before preparation.
5. Direct targets are unsupported in version 1.
6. Result contracts are immutable and resolved before activation.
7. The initial strategy state is immutable and selected only through the
   workset transition.
8. Resource, environment, and workspace digests are unchanged from admission.
9. Trusted preflight failures produce one closed rejection request.
10. Ambiguous authority never becomes a trusted rejection.
11. Identical preparation retries converge; divergent retries conflict.

## 6. Internal Operations

### Topology validation

Reject empty manifests, duplicate jobs, multiple host jobs, multiple strategy
groups, direct targets, dependent jobs, incompatible workspace domains, or
policy limits before any stable prepared state.

### Host commitment

The host executor digest commits task, result contract, workspace, resource,
and environment inputs. It contains no ticket, staging path, session identity,
or runtime observation.

### Strategy verdict validation

A supported verdict must reference the active compatible Dependency Contract,
cover exactly the admitted worker IDs, provide distinct executor digests, and
commit an initial strategy state whose workset and group identities match.

A rejected verdict maps only to its closed proposed rejection code. An ambiguous
verdict cannot be normalized to dependency unavailability.

### Candidate selection

The initial state candidate has revision one and no predecessor. The node
verifies candidate bytes before atomically selecting its commitment in the
prepared workset. A published but unselected candidate has no authority.

### Failure behavior

| Condition | Response |
| --------- | -------- |
| Unsupported topology | Trusted rejection request |
| Invalid closed configuration | Trusted rejection request |
| Dependency unavailable | Trusted rejection request |
| Insufficient deadline margin | Trusted rejection request |
| Workspace drift with valid identity | Configuration-drift request |
| Strategy verdict missing for workers | Preparation failure |
| Strategy or attempt identity ambiguity | Quarantine request |
| Initial candidate mismatch | Quarantine request |
| Existing identical prepared snapshot | Idempotent success |
| Existing divergent prepared snapshot | Quarantine conflict |

## 7. Cross-Cutting Concerns

All checks use bounded strict data, canonical digests, and committed artifacts.
No secret, credential, owner token, absolute path, or raw provider output enters
preparation evidence.

Preparation remains deterministic over admitted content and strategy verdict.
Ambient model availability, directory order, and wall-clock timing cannot alter
committed intent after the final preflight boundary.

## 8. Infrastructure & Environment

The node consumes the exact environment, resource, workspace, artifact,
canonical JSON, and Runner coordination standards. It runs entirely on the
certified local Runner host.

All expensive external capability checks occur before this node through the
strategy interface. The node holds the transaction mutex only for bounded
artifact verification and snapshot selection.

## 9. Dependencies

- Parent Runner CDD-O.
- Admission and handoff node for admitted input.
- External execution strategy interface for the capability verdict.
- Host intake node as downstream consumer of host commitment.
- Outcome and terminal node for rejection and ambiguity requests.
- Permanent standards.

## 10. Testing Strategy

Tests cover:

- host-only, worker-only, and mixed preparation;
- every version-1 topology limit;
- direct-target rejection;
- host executor digest sensitivity;
- exact strategy worker-set membership;
- missing, duplicate, foreign, rejected, and ambiguous strategy verdicts;
- result-contract resolution and divergence;
- resource, environment, and workspace drift;
- initial candidate publication and selection crash boundaries;
- identical preparation convergence and divergent conflict;
- proof of zero host event and zero external spawn before prepared state;
- closed mapping of every trustworthy rejection code.

## 11. Glossary

### Prepared workset

Complete immutable execution intent selected in Runner authority before any
host or external side effect.

### Preparation evidence

Committed proof of generic, host, workspace, policy, environment, and strategy
preflight.

### Strategy verdict

Side-effect-free strategy output consumed as preparation input rather than
trusted as a Runner transition.
