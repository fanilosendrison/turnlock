---
okf_version: "1.0"
kind: "RuntimeArtifact"
format: "cubits-design-doc"
workspace: "turnlock"
date: "2026-07-21"
step_id: 0
id: "CDD-N-TURNLOCK-WORKSET-CLEANUP"
version: "0.1.0"
scope: "workset-cleanup"
status: "draft"
consumers:
  - "agent-generator"
superseded_by: []
---

# CDD-N: Turnlock Workset Cleanup

## 1. Objectif & Position

This node computes the authoritative artifact reference set for terminal or
resolved worksets and removes only artifacts whose ownership, retention, and
concurrency gates prove them collectible.

It is a worker node of
[CDD-O Turnlock Runner Execution](cdd-o-turnlock-runner-execution.md). Cleanup is
separate from terminal resume and quarantine disposition so a cleanup crash can
never alter workflow or disposition authority.

## 2. Goals & Non-Goals

### Goals

- Derive liveness from authoritative snapshots and journals.
- Retain every artifact required by pending resume, delivery, quarantine,
  operator proof, orphan reconciliation, or diagnostics.
- Collect abandoned temporary and unselected candidate artifacts after policy.
- Release dependency results only after the Runner supplies explicit digest
  acknowledgement receipts.
- Make every deletion and retry idempotent.
- Produce bounded cleanup evidence without becoming authority.

### Non-goals

- Age-only deletion.
- Event-replay state reconstruction.
- Terminal, resume, or quarantine transitions.
- External process termination.
- Deletion of unresolved conflict evidence.
- Recursive deletion from an untrusted path.

## 3. Data Contracts (Inputs & Outputs)

### Cleanup input

```typescript
interface WorksetCleanupInputSketch {
  readonly runnerId: string;
  readonly cleanupOperationId: string;
  readonly nowEpochMs: number;
  readonly resourcePolicyDigest: PayloadDigestV1;
  readonly environmentProfileDigest: PayloadDigestV1;
  readonly scope:
    | { readonly kind: "workset"; readonly attemptId: string }
    | { readonly kind: "runner" };
  readonly dependencyRetentionReceipts:
    readonly ArtifactCommitmentV2[];
}
```

### Reference-set output

```typescript
interface AuthoritativeReferenceSetSketch {
  readonly version: 1;
  readonly runnerId: string;
  readonly generatedFromCommitments: readonly ArtifactCommitmentV2[];
  readonly liveArtifactCommitments: readonly ArtifactCommitmentV2[];
  readonly blockedReasons: readonly string[];
  readonly referenceSetDigest: PayloadDigestV1;
}
```

The set digest uses `turnlock:cleanup-reference-set`. The set includes
transitive commitments from worksets, selected strategy state,
submissions, outcomes, terminal causes, terminal publication, resume,
delivery, quarantine, operator disposition, diagnostics, and unresolved
external execution.

### Dependency release request

```typescript
interface DependencyRetentionReleaseRequestSketch {
  readonly strategyId: string;
  readonly callerLaunchKey: string;
  readonly resultDigests: Readonly<Record<string, string>>;
}
```

When a required receipt is absent, the node outputs these requests and performs
no deletion that depends on them. The Runner orchestrator obtains receipts from
the selected strategy and invokes the node again.

### Cleanup report

```typescript
interface CleanupReportSketch {
  readonly version: 1;
  readonly cleanupOperationId: string;
  readonly referenceSetDigest: PayloadDigestV1;
  readonly deletedCommitments: readonly ArtifactCommitmentV2[];
  readonly retainedCommitments: readonly ArtifactCommitmentV2[];
  readonly dependencyRetentionReceipts: readonly ArtifactCommitmentV2[];
  readonly conflicts: readonly string[];
  readonly completedAtEpochMs: number;
}
```

The report is audit evidence and does not authorize deletion on a later run
without recomputing the reference set.

## 4. Pipeline

1. Validate the committed environment and resource policy.
2. Acquire the cleanup coordination mutex for the exact Runner scope.
3. Load current owner lease, every applicable workset, selected strategy state,
   delivery journal, claims, quarantine records, and retention holds.
4. Validate every authoritative snapshot and commitment before deriving
   references.
5. Traverse only contract-declared reference fields and build the complete live
   set.
6. Enumerate candidate artifacts through trusted root allocators, never through
   untrusted recursive paths.
7. Classify each candidate as live, age-blocked, claim-blocked,
   quarantine-blocked, orphan-blocked, conflict evidence, or collectible.
8. Revalidate current authority immediately before each destructive batch.
9. For external dependency results, verify a supplied digest-scoped retention
   receipt or output a release request and stop that deletion path.
10. Delete only exact opened objects proven collectible and still unchanged.
11. Publish the bounded cleanup report.
12. Release only the exact cleanup mutex instance.

## 5. Invariants

1. Current authoritative references override age.
2. Event age, process ID, filename, and directory position do not prove safety.
3. Open quarantine evidence is never collectible.
4. Resolved quarantine remains retained for the policy minimum.
5. Pending or uncertain delivery retains event and payload artifacts.
6. Incomplete resume retains terminal, invocation, captures, and core outbox.
7. Unresolved strategy orphans retain correlation and stop evidence.
8. Divergent conflicts remain retained until explicit disposition.
9. Dependency result reads never imply cleanup permission.
10. Every deletion checks the opened object identity and expected commitment.
11. Repeating cleanup cannot delete newly referenced artifacts.

## 6. Internal Operations

### Reference traversal

Traverse strict versioned records only. Unknown schema versions, unknown
reference fields, malformed snapshots, or missing committed children block the
affected scope. Do not infer references from arbitrary JSON strings or event
text.

### Candidate eligibility

A temporary artifact becomes eligible after
`temporaryArtifactRetentionHours`. An unselected state candidate becomes
eligible after `unreferencedCandidateRetentionHours` only when no selected
snapshot or external side-effect authorization references its operation.

Terminal and orphan evidence observe their own day-based policies. Quarantine
evidence observes disposition plus `quarantineMinimumRetentionDays`.

### Dependency retention

Calculate the exact caller launch key and result digests only after all local
generic and diagnostic references are released, then output a retention release
request. On a later invocation, verify the Runner-supplied dependency receipt
before allowing local correlation evidence to be collected. A missing or
divergent receipt retains everything needed to retry.

### Race handling

Before deletion, reopen the authoritative snapshot or generation marker and
require the same reference-set inputs. If authority changed, abandon the batch
and recompute. A missing candidate is idempotent success only when it was not
live; a missing live artifact remains an integrity failure.

### Failure behavior

| Condition | Response |
| --------- | -------- |
| Snapshot or journal invalid | Block affected scope |
| Unknown schema version | Block affected scope |
| Active claim or resume | Retain related artifacts |
| Open quarantine | Retain all evidence |
| Resolved quarantine before floor | Retain all evidence |
| Dependency acknowledgement timeout | Retain correlation and results |
| Object identity changes before delete | Skip and report conflict |
| Authority changes during batch | Stop and recompute |
| Already deleted collectible candidate | Idempotent success |
| Cleanup process crash | Repeat from authoritative state |

## 7. Cross-Cutting Concerns

Cleanup uses trusted root bindings, safe opens, exact byte commitments, and
Runner coordination. It emits bounded counts and digests rather than private
artifact contents or absolute paths.

The reference set is deterministic for one authoritative input set and clock
observation. Reports never become a substitute for current snapshots. Cleanup
errors do not shorten retention or advance workset state.

## 8. Infrastructure & Environment

The node requires local APFS safe-open and object-identity guarantees, the
certified process and clock profile, and the complete resource policy. It uses a
Runner-scoped cleanup mutex distinct from workset transactions and delivery
claims.

All roots are trusted runtime bindings. Recursive shell deletion and deletion by
string prefix are forbidden.

## 9. Dependencies

- Parent Runner CDD-O, which obtains dependency retention receipts through the
  external strategy interface.
- Terminal resume node for resume references.
- Delivery bridge node for event and claim references.
- Quarantine disposition node for operator proof and retention start.
- Artifact, resource, environment, canonical JSON, and coordination standards.

## 10. Testing Strategy

Tests cover:

- complete transitive reference-set derivation;
- referenced artifacts older than every policy threshold;
- unreferenced temporary and strategy candidates at each time boundary;
- pending and completed resume;
- pending, claimed, delivered, and gap-disposed events;
- open and resolved quarantine before and after retention floor;
- unresolved strategy orphans and conflict evidence;
- dependency acknowledgement success, timeout, divergence, and crash;
- object substitution and authority changes during deletion;
- missing live versus missing collectible artifacts;
- cleanup crash and repeated idempotence;
- proof that no workset, terminal, resume, or disposition state advances.

## 11. Glossary

### Authoritative reference set

Complete transitive set of artifact commitments required by current state and
retention holds.

### Collectible artifact

Unreferenced artifact whose ownership, age, claim, disposition, and object
identity all permit deletion.

### Retention acknowledgement

Dependency receipt authorizing later collection of exact result digests.

### Retention hold

Authoritative condition preventing collection regardless of artifact age.
