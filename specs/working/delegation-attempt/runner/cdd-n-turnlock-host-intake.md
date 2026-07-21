---
okf_version: "1.0"
kind: "RuntimeArtifact"
format: "cubits-design-doc"
workspace: "turnlock"
date: "2026-07-21"
step_id: 0
id: "CDD-N-TURNLOCK-HOST-INTAKE"
version: "0.1.0"
scope: "host-intake"
status: "draft"
consumers:
  - "agent-generator"
superseded_by: []
---

# CDD-N: Turnlock Host Intake

## 1. Objectif & Position

This node prepares, delivers, validates, and publishes the unprivileged
submission for the optional single host job in a prepared workset.

It is a worker node of
[CDD-O Turnlock Runner Execution](cdd-o-turnlock-runner-execution.md). It neither
executes worker jobs nor adopts its own submission.

## 2. Goals & Non-Goals

### Goals

- Commit one host executor intent before activation.
- Create and commit one opaque host ticket before delivery.
- Expose one fixed staging target and Runner-owned submission operation.
- Publish at most one canonical successful host submission while intake is open.
- Make delivery and submission retries idempotent.
- Prevent the host from obtaining owner, final-result, or resume authority.

### Non-goals

- More than one host job.
- Worker strategy scheduling.
- Host failure submissions.
- Submission adoption or final outcome creation.
- Intake closure, terminal selection, or core resume.
- Arbitrary host-selected source or destination paths.

## 3. Data Contracts (Inputs & Outputs)

### Host execution commitment

```typescript
interface ResolvedHostExecutionSpecSketch {
  readonly version: 1;
  readonly target: "host";
  readonly jobId: string;
  readonly taskDigest: PayloadDigestV1;
  readonly resultContractDigest?: PayloadDigestV1;
  readonly workspaceInputCommitment: WorkspaceInputCommitmentV1;
  readonly resourcePolicyDigest: PayloadDigestV1;
  readonly environmentProfileDigest: PayloadDigestV1;
}
```

Its semantic digest uses `turnlock:executor-spec`.

### Host ticket contract

```typescript
interface HostSubmissionTicketSketch {
  readonly version: 1;
  readonly ticketId: string;
  readonly turnlockRunId: string;
  readonly delegationId: string;
  readonly attemptId: string;
  readonly attempt: number;
  readonly worksetId: string;
  readonly jobId: string;
  readonly executorSpecDigest: PayloadDigestV1;
  readonly resultContractDigest?: PayloadDigestV1;
  readonly stagingTarget: ArtifactTargetRefV1;
  readonly issuedAtEpochMs: number;
  readonly expiresAtEpochMs: number;
}
```

The `stagingTarget` is Runner-relative with purpose `host-staging`. The ticket
contains no owner token, fence, final result target, worker state, absolute path,
executable, or resume operation.

### Host continuation event

The immutable event contains the host task, opaque ticket identity, bounded
submission instructions, session delivery sequence, and ticket commitment. It
does not expose the ticket's trusted root binding.

### Host submission

```typescript
interface HostJobSubmissionSketch {
  readonly header: JobSubmissionHeaderSketch;
  readonly source: {
    readonly kind: "host";
    readonly ticketId: string;
    readonly ticketCommitment: ArtifactCommitmentV2;
  };
  readonly result: {
    readonly status: "success";
    readonly payload: JsonValueSketch;
    readonly payloadDigest: PayloadDigestV1;
  };
}
```

A missing host result is terminalized later by the current owner through a
committed deadline or cancellation cause. The host cannot publish a failure
code.

## 4. Pipeline

### Ticket preparation

1. Load the prepared workset under the current owner fence and mutex.
2. Require exactly one host job and no prior divergent ticket.
3. Verify the host executor digest, workspace, policy, environment, and deadline.
4. Allocate one Runner-owned write-once staging target.
5. Construct and publish the immutable ticket.
6. Atomically advance the workset with its ticket commitment.
7. Publish one sequenced host-continuation event referencing that commitment.

### Host submission publication

1. Accept only the opaque ticket identity and bounded payload bytes.
2. Resolve the ticket from Runner authority; reject a caller-supplied path.
3. Safe-open and verify the committed ticket bytes.
4. Parse and validate the payload through the strict JSON domain.
5. Acquire the transaction mutex.
6. Reload the current workset, intake, deadline, ticket, job, workspace, and
   executor commitment.
7. Require publication before irreversible intake closure.
8. Construct and publish one immutable canonical submission.
9. Compare any existing submission identity and digest.
10. Release the mutex without adopting the submission.

## 5. Invariants

1. Version 1 permits zero or one host job.
2. The ticket commitment is selected before continuation delivery.
3. The host receives no owner, strategy, terminal, result-target, or resume
   authority.
4. Ticket lookup starts from opaque identity, never a host path.
5. A host submission can represent success only.
6. Publication under open intake does not imply adoption.
7. Submission after closure is never receivable.
8. Payload and ticket size limits apply before parsing.
9. Identical continuation and submission retries converge.
10. Divergent payloads for one ticket never win by arrival order.

## 6. Internal Operations

### Ticket resolution

Unknown, malformed, foreign-attempt, expired-before-publication, mutated, or
wrong-job tickets fail without publication. Ticket expiration does not revoke a
submission already published while intake was open.

### Workspace verification

The node verifies the workspace commitment before ticket delivery and again in
the submission transaction. Trustworthy drift requests the generic
configuration-drift route; ambiguous authority requests quarantine. The node
does not select either route itself.

### Submission idempotence

```text
no submission for ticket and job
  -> publish immutable submission

same canonical submission digest
  -> idempotent success

different digest
  -> conflict; publish nothing authoritative
```

### Crash behavior

- Ticket bytes before workset selection are an unreferenced candidate.
- Selected ticket before event publication causes exact event republication.
- Event delivery crash is recovered by delivery sequence and claim state.
- Submission bytes before command acknowledgement remain receivable and
  idempotent.
- A crash before immutable submission publication leaves no receivable result.

### Failure behavior

| Condition | Response |
| --------- | -------- |
| No host job | Node is not scheduled |
| More than one host job | Preflight rejection |
| Ticket mutation or foreign identity | Reject and request quarantine evidence |
| Expired ticket before publication | Reject |
| Oversized or invalid JSON payload | Reject without failure outcome |
| Workspace drift | Request generic rejection or quarantine |
| Intake closed or deadline lost | Reject late publication |
| Identical duplicate | Converge |
| Divergent duplicate | Conflict and alert |

## 7. Cross-Cutting Concerns

Ticket, event, and submission identities use canonical digests and immutable
artifact commitments. Staging paths are Runner-relative and write-once. The host
cannot choose final artifact locations.

Audit events exclude raw prompts, payloads, owner tokens, credentials, absolute
paths, and unbounded validation errors. The submission command performs no
owner-only transition.

## 8. Infrastructure & Environment

The node runs on the certified local environment and uses the committed resource
policy for ticket lifetime, payload limits, JSON limits, delivery limits, and
retention. It consumes the artifact, canonical JSON, workspace, and coordination
standards.

The host session shares the workspace cooperatively read-only. Its staging root
is outside committed workspace inputs or inside one explicit committed
exclusion.

## 9. Dependencies

- Parent Runner CDD-O.
- Delivery bridge node for event transport.
- Outcome and terminal node for later adoption and provenance.
- Permanent standards.
- No pi-subagents or external strategy dependency.

## 10. Testing Strategy

Tests cover:

- zero, one, and multiple host topology;
- complete host executor commitment sensitivity;
- ticket commitment before event publication;
- ticket path, identity, mutation, expiry, and size failures;
- host visibility excludes every privileged field;
- continuation duplicate and sequence recovery;
- valid strict JSON payload publication;
- duplicate-key, malformed UTF-8, unsafe number, depth, and byte rejection;
- publication racing normal, deadline, cancellation, rejection, and quarantine
  closure;
- workspace drift at delivery and publication;
- crash before and after ticket, event, and submission publication;
- identical duplicate convergence and divergent duplicate conflict;
- proof that publication never adopts or writes a final outcome.

## 11. Glossary

### Host continuation

Sequenced event that gives the main harness session one independent task and
opaque submission instructions.

### Host ticket

Committed capability identifying one host job and one fixed staging target
without granting owner authority.

### Staging target

Runner-owned write-once location through which bounded host payload bytes enter
the submission operation.
