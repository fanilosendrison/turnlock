---
okf_version: "1.0"
kind: "RuntimeArtifact"
format: "cubits-design-doc"
workspace: "turnlock"
date: "2026-07-21"
step_id: 0
id: "CDD-N-TURNLOCK-OUTCOME-AND-TERMINAL-COORDINATION"
version: "0.1.0"
scope: "outcome-and-terminal-coordination"
status: "draft"
consumers:
  - "agent-generator"
superseded_by: []
---

# CDD-N: Turnlock Outcome and Terminal Coordination

## 1. Objectif & Position

This node owns Runner-side intake closure, submission adoption, outcome
construction, all-terminal evaluation, attempt-rejection selection, and
quarantine selection for one workset.

It is a worker node of
[CDD-O Turnlock Runner Execution](cdd-o-turnlock-runner-execution.md). It consumes
already published host and worker submissions and bounded reconciliation
reports. It does not execute external work, publish the selected envelope at the
core target, invoke resume, or classify core retry policy.

## 2. Goals & Non-Goals

### Goals

- Serialize publication and intake closure.
- Adopt only eligible immutable submissions under the current fence.
- Represent host, worker, and owner-generated outcome provenance accurately.
- Recover partial immutable outcome sets.
- Select exactly one outcomes-complete or attempt-rejected envelope.
- Quarantine unresolved authority without fabricating outcomes.
- Preserve deterministic manifest order independent of completion order.

### Non-goals

- Host or worker execution.
- Strategy lifecycle management.
- Retryability classification.
- Business payload validation.
- Core-target publication or resume.
- Automatic evidence repair.
- Selection by timestamps or filesystem discovery order.

## 3. Data Contracts (Inputs & Outputs)

### Submission inputs

The node consumes committed host and worker submission envelopes from the parent
contracts. Each submission carries exact core, workset, job, executor, source,
and payload or failure identity.

Host submissions carry ticket evidence. Worker submissions carry strategy
execution evidence. These branches are not coerced into one universal execution
commitment.

### Terminal cause

```typescript
interface OwnerTerminalCauseSketch {
  readonly version: 1;
  readonly turnlockRunId: string;
  readonly delegationId: string;
  readonly attemptId: string;
  readonly worksetId: string;
  readonly cause: "deadline-exceeded" | "cancelled-by-user";
  readonly closedIntakeDigest: PayloadDigestV1;
  readonly affectedJobIds: readonly string[];
  readonly selectedAtEpochMs: number;
}
```

The cause is published immutably and selected in the same workset transition
that closes intake. Every owner-generated outcome references its commitment.

### Outcome output

Every output uses `JobOutcomeEnvelopeSketch` and the discriminated provenance
union from the parent CDD-O.

Allowed construction routes are:

| Outcome | Required provenance |
| ------- | ------------------- |
| Host success | Adopted host submission and ticket commitments |
| Worker success | Adopted worker submission and execution evidence |
| Worker observed failure | Adopted worker submission and execution evidence |
| Missing job at deadline | Owner terminal cause `deadline-exceeded` |
| Missing job after cancellation | Owner terminal cause `cancelled-by-user` |

An attempt rejection produces no synthetic per-job outcomes.

### Outcome set

```typescript
interface OutcomeSetSubjectSketch {
  readonly version: 1;
  readonly attemptId: string;
  readonly manifestDigest: PayloadDigestV1;
  readonly outcomes: readonly {
    readonly jobId: string;
    readonly outcomeDigest: PayloadDigestV1;
  }[];
}
```

The list follows manifest order exactly.

### Terminal output

The node atomically selects an embedded `RunnerAttemptTerminalEnvelopeSketch`
and semantic digest inside `WorksetRecord`. Its publication remains
`not-published` for the terminal resume node.

### Quarantine output

Quarantine selects no terminal envelope. It commits closed intake, bounded
reason code, evidence commitment, alert identity, and open disposition state.

## 4. Pipeline

### Normal closure and adoption

1. Acquire the transaction mutex.
2. Reload and verify current owner, workset, manifest, workspace, policy, and
   environment commitments.
3. Scan immutable submissions by expected job identity, not directory order.
4. When every job has one receivable terminal submission, perform the final
   workspace check and close intake with `all-submissions-received`.
5. Validate source-specific evidence for each submission.
6. Record adoption and commitment in manifest order.
7. Release the mutex after the stable workset transition.

### Deadline closure

1. At the authoritative deadline, acquire the mutex and perform one final scan.
2. Close intake irreversibly with `deadline-reached`.
3. Publish and select one terminal-cause commitment listing unresolved jobs.
4. Release the mutex.
5. Return a reconciliation request to the Runner orchestrator.
6. After receiving the bounded report, adopt any submission that was already
   receivable before closure.
7. Construct owner-generated deadline outcomes for remaining jobs.

### User cancellation

Cancellation follows deadline close-first ordering but uses one
`cancelled-by-user` cause. This abort route cannot later be replaced by an
attempt rejection. Later workspace drift remains diagnostic.

### Outcome commit

For every adopted submission or authorized missing job:

1. construct the exact provenance branch;
2. validate core and Runner identity;
3. publish canonical outcome bytes at the core-allocated job target;
4. verify the resulting artifact commitment;
5. atomically advance that job's workset record;
6. preserve identical existing content and quarantine divergence.

### Join selection

After every manifest job has one committed valid outcome, verify the final
workspace boundary, calculate the manifest-ordered outcome-set digest, and
atomically select `outcomes-complete` with workset state
`outcomes-committed`.

### Attempt rejection

For a trusted closed preflight, dependency, capability, deadline-margin, or
workspace-drift failure, close intake if required, preserve prior evidence, and
atomically select `attempt-rejected`. No job outcome is required.

### Quarantine

When identity, integrity, provenance, candidate cardinality, or authority cannot
be trusted, close intake, select `quarantined`, preserve evidence, emit the
persistent alert identity, and leave terminal selection pending.

## 5. Invariants

1. Submission publication and intake closure are mutex-ordered.
2. Adoption is current-owner-only.
3. A host outcome never requires fictional worker execution evidence.
4. An owner-generated outcome always references one immutable terminal cause.
5. `executorSpecDigest` identifies intent but does not replace provenance.
6. Outcome bytes are immutable and write-once at core targets.
7. Valid partial outcome sets survive recovery.
8. Exactly one outcome exists for every manifest job before join.
9. Manifest order controls the outcome-set digest.
10. Success and failure outcomes both satisfy execution terminality.
11. Outcome and rejection terminal routes are mutually exclusive.
12. User cancellation cannot be superseded by rejection.
13. Quarantine selects neither automatic terminal route.
14. The node never emits a retryability decision.

## 6. Internal Operations

### Submission eligibility

Eligibility requires exact attempt, workset, job, executor, source, intake,
deadline publication, workspace, payload, and evidence commitments. Worker
eligibility additionally requires the selected strategy launch. Host eligibility
requires the committed ticket.

### Outcome idempotence

```text
outcome absent
  -> publish and commit

same canonical outcome digest
  -> idempotent success

different canonical outcome digest
  -> quarantine conflict; never overwrite
```

### Missing-job authorization

A missing submission alone is insufficient to construct an outcome. The job
must appear in the selected immutable terminal-cause record, and that cause must
match closed intake. A late external completion cannot alter the cause.

### Rejection precedence

A trusted rejection may win while terminal selection is pending, including
after partial outcomes exist. Those outcomes remain audit evidence. Rejection
cannot win after outcomes-complete or after a selected cancellation cause.

### Workspace drift

Trustworthy drift before final terminal selection chooses
`configuration-drift` rejection. Ambiguous core, attempt, manifest, or workspace
identity chooses quarantine. The node never refreshes the commitment.

### Failure behavior

| Condition | Response |
| --------- | -------- |
| Malformed generic submission | Reject before adoption |
| Late submission | Reject publication or adoption as applicable |
| Divergent duplicate submission | Quarantine |
| Invalid source provenance | Quarantine |
| Missing terminal cause for synthetic outcome | Refuse outcome and quarantine |
| Partial valid outcomes after crash | Retain and commit only missing outcomes |
| Divergent result target bytes | Quarantine |
| Final workspace drift | Attempt rejection if trusted |
| Terminal route already selected | Idempotent same route or conflict |
| Attribution ambiguous | Quarantine with no terminal envelope |

## 7. Cross-Cutting Concerns

Canonical JSON and artifact standards govern submissions, causes, outcomes, and
terminal selection. Strict bounds apply before parsing and canonicalization.

Outcome messages contain no raw provider output, credentials, unrestricted
paths, or owner tokens. Diagnostic evidence is separately committed. Audit
events do not reconstruct adoption or terminal authority.

Cleanup retains every submission, cause, partial outcome, conflict, and
quarantine artifact while current state or policy references it.

## 8. Infrastructure & Environment

The node consumes the certified environment, committed resource policy,
workspace commitment, Runner coordination, canonical JSON, and artifact
standards.

External stop and reconciliation never occur while the transaction mutex is
held. The Runner orchestrator performs those operations and returns a bounded
report to this node.

## 9. Dependencies

- Parent delegation-attempt CDD-O for outcome, rejection, and classification
  contracts.
- Parent Runner CDD-O for workset, owner, intake, and strategy selection.
- Host intake node for host submissions.
- External strategy interface for worker submissions and reconciliation reports.
- Terminal resume node as the downstream consumer of selected terminal state.
- Permanent standards.

## 10. Testing Strategy

Tests cover:

- host, worker, and owner-generated provenance branches;
- rejection of missing or branch-incompatible evidence;
- publication racing each closure cause;
- final scan at the exact deadline boundary;
- deadline and cancellation terminal-cause commitment;
- already receivable submissions after closure;
- partial outcome-set crash recovery;
- identical and divergent outcome publication;
- manifest-order invariance under every completion permutation;
- final workspace drift before join;
- attempt rejection before dispatch and after partial evidence;
- cancellation precedence over later rejection;
- mutually exclusive terminal routes;
- quarantine with no terminal envelope;
- proof that no retryability field or classification leaves this node.

## 11. Glossary

### Adoption

Fenced owner transition accepting one valid unprivileged submission as outcome
evidence.

### All-terminal

Condition in which every manifest job has exactly one committed valid outcome.

### Owner-generated outcome

Deadline or cancellation failure backed by immutable terminal-cause evidence,
not a fabricated executor observation.

### Provenance

Discriminated evidence route from submission or owner terminal cause to final
outcome.

### Terminal-cause evidence

Immutable closure evidence authorizing outcomes for jobs without submissions.
