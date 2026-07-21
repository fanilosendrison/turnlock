---
okf_version: "1.0"
kind: "RuntimeArtifact"
format: "cubits-design-doc"
workspace: "turnlock"
date: "2026-07-21"
step_id: 0
id: "CDD-N-TURNLOCK-ATTEMPT-ADMISSION-AND-HANDOFF"
version: "0.1.0"
scope: "attempt-admission-and-handoff"
status: "draft"
consumers:
  - "agent-generator"
superseded_by: []
---

# CDD-N: Turnlock Attempt Admission and Handoff

## 1. Objectif & Position

This node validates one short core invocation result, admits at most one
manifest-version-3 attempt into a deterministic Runner namespace, and publishes
durable handoff evidence to the resident controller.

It is a worker node of
[CDD-O Turnlock Runner Execution](cdd-o-turnlock-runner-execution.md). It neither
performs complete execution preflight nor delegates work to a host or external
strategy.

## 2. Goals & Non-Goals

### Goals

- Cross-validate process, protocol, core state, manifest, targets, and resume
  operation.
- Reject manifest-v2 pending state under the breaking upgrade gate.
- Resolve exactly one deterministic workset namespace.
- Create one `admitted` snapshot without external side effects.
- Publish durable handoff before releasing invocation responsibility.
- Recover admission and handoff crashes idempotently.

### Non-goals

- Strategy capability or profile resolution.
- Host ticket creation or delivery.
- External launch.
- Attempt rejection selection.
- Submission, outcome, join, resume, or retry.
- Repair of corrupt core or Runner authority.

## 3. Data Contracts (Inputs & Outputs)

### Input

```typescript
interface AdmissionInputSketch {
  readonly invocationId: string;
  readonly processObservationCommitment: ArtifactCommitmentV2;
  readonly protocolResultCommitment: ArtifactCommitmentV2;
  readonly trustedCoreRootBinding: ArtifactRootBindingV1;
  readonly runnerConfigurationDigest: PayloadDigestV1;
}
```

The process observation commits executable identity, argv vector, working
directory identity, allowed environment digest, exit status, signal, stdout, and
stderr. It does not contain an evaluated shell command.

### Admitted snapshot output

The output is the initial `WorksetRecord` in `admitted` state. It contains exact
attempt identity and commitments but no host ticket, executor digests, selected
strategy state, terminal route, or resume progress.

### Handoff output

```typescript
interface AdmissionHandoffSketch {
  readonly version: 1;
  readonly invocationId: string;
  readonly runnerId: string;
  readonly attemptId: string;
  readonly worksetId: string;
  readonly admittedWorksetDigest: PayloadDigestV1;
  readonly eventId: string;
  readonly eventCommitment: ArtifactCommitmentV2;
  readonly publishedAtEpochMs: number;
}
```

A convenience index may reference the handoff but is not authority.

### Rejection output

Admission failure before trustworthy workset creation returns one bounded Runner
protocol error. It does not fabricate attempt rejection or job outcomes.

## 4. Pipeline

1. Open and verify bounded process observation and protocol artifacts.
2. Require one protocol-version-3 block and a coherent exit/signal result.
3. Resolve the trusted Turnlock run-root binding from deployment configuration
   and core identity.
4. Load authoritative core state and require the exact pending attempt.
5. Reject pending protocol version 2 or manifest version 2 without mutation.
6. Safe-open and validate the manifest commitment and semantic digest.
7. Validate unique jobs, topology shape, typed targets, result contracts,
   deadline, resource policy, environment profile, workspace commitment, and
   structured resume operation.
8. Require all core-run targets to belong to the same run and attempt, remain
   pairwise distinct, and be unoccupied or identically committed where allowed.
9. Derive the deterministic Runner-and-attempt namespace.
10. Resolve zero, one, or multiple existing worksets.
11. Publish the admitted workset candidate and atomically select it when no
    workset exists; converge only on identical existing content.
12. Publish immutable handoff evidence and its sequenced event.
13. Return only after the handoff commitment is durable.

## 5. Invariants

1. Admission performs no host delivery or external execution.
2. Exactly one protocol block is accepted.
3. Protocol, process, core state, and manifest identities agree exactly.
4. An absolute path or raw resume command is invalid.
5. Manifest-v2 pending state is never reinterpreted as version 3.
6. One deterministic namespace maps to one attempt.
7. Multiple worksets for one namespace are never selected by discovery order.
8. Handoff references an already committed admitted snapshot.
9. A Runner error before trustworthy admission cannot select core terminal state.
10. Repetition with identical input converges.

## 6. Internal Operations

### Protocol validation

No block, multiple blocks, unsupported protocol version, unexpected stdout,
process signal, nonconforming exit, duplicate key, or output limit violation
fails admission. Bounded stderr is diagnostic only and cannot repair protocol.

### Namespace resolution

Zero existing worksets permits creation. One exact matching admitted or later
workset makes admission idempotent. More than one match or divergent content
produces collision evidence and stops handoff.

### Target validation

The node validates target syntax, root identity, allocation identity, purpose,
and pairwise disjointness. It does not create final result bytes. Existing
divergent bytes are a protocol conflict.

### Crash recovery

- Crash before snapshot selection leaves only an unreferenced candidate.
- Crash after snapshot selection but before handoff republishes the same handoff.
- Crash after handoff but before acknowledgement resolves from journal evidence.
- A convenience-index failure is repaired from the authoritative snapshot and
  immutable handoff event.

### Failure behavior

| Condition | Response |
| --------- | -------- |
| Pending v2 protocol or manifest | Incompatible-state error; no mutation |
| Core state has no pending attempt | Stale invocation error |
| Identity or digest mismatch | Admission protocol error |
| Invalid or colliding target | Admission protocol error |
| Existing identical workset | Idempotent handoff |
| Existing divergent workset | Collision evidence; no selection |
| Multiple worksets | Quarantine evidence for operator inspection |
| Handoff event conflict | Stop and preserve both artifacts |

## 7. Cross-Cutting Concerns

Admission uses strict bounded parsing, canonical digests, write-once artifacts,
and exact process capture. Secrets and raw prompts are excluded from audit
events. Messages are bounded; long evidence remains committed by reference.

Every stable output is idempotent by invocation, attempt, workset, and semantic
digest. Time, directory order, and process memory cannot choose between
conflicting candidates.

## 8. Infrastructure & Environment

The node consumes the permanent environment, resource, artifact, canonical JSON,
workspace, and coordination standards. It runs on the certified local platform
and requires trusted root and executable bindings before parsing core output.

The core invocation's stdout and stderr are captured into bounded files opened
before process start. The node never invokes a shell.

## 9. Dependencies

- Parent Runner CDD-O.
- Parent delegation-attempt CDD-O for manifest and resume contracts.
- Delivery bridge node for later event transport; admission only publishes the
  immutable event.
- Permanent Turnlock standards.
- No external execution strategy or pi-subagents dependency.

## 10. Testing Strategy

Tests cover:

- zero, one, and multiple protocol blocks;
- every exit, signal, stdout, and stderr mismatch;
- manifest-v2 refusal;
- stale, missing, and divergent pending core state;
- malformed manifest and semantic digest mismatch;
- absolute, foreign-run, wrong-purpose, colliding, and occupied targets;
- zero, one identical, one divergent, and multiple worksets;
- crash before and after snapshot and handoff publication;
- duplicate admission convergence;
- no host, strategy, terminal, or resume side effect on failure;
- handoff event sequencing and digest conflict.

## 11. Glossary

### Admission

Validation and durable Runner registration of one trustworthy core attempt.

### Handoff

Durable transfer from a short invocation to the resident controller.

### Invocation observation

Immutable capture of executable identity, process termination, stdout, and
stderr.

### Namespace collision

Divergent or multiple workset authorities discovered for one deterministic
attempt namespace.
