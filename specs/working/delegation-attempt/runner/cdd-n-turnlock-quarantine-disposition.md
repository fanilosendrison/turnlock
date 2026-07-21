---
okf_version: "1.0"
kind: "RuntimeArtifact"
format: "cubits-design-doc"
workspace: "turnlock"
date: "2026-07-21"
step_id: 0
id: "CDD-N-TURNLOCK-QUARANTINE-DISPOSITION"
version: "0.1.0"
scope: "quarantine-disposition"
status: "draft"
consumers:
  - "agent-generator"
superseded_by: []
---

# CDD-N: Turnlock Quarantine Disposition

## 1. Objectif & Position

This node exposes read-only quarantine inspection, validates an authenticated
operator-abort request, invokes the fixed core abort operation, and records the
resulting core disposition proof in the Runner workset.

It is a worker node of
[CDD-O Turnlock Runner Execution](cdd-o-turnlock-runner-execution.md). It does not
repair ambiguous evidence, fabricate an attempt terminal envelope, or resume the
quarantined attempt.

## 2. Goals & Non-Goals

### Goals

- Keep automatic progress stopped after quarantine.
- Publish and maintain a durable persistent alert.
- Produce bounded read-only inspection reports.
- Require exact attempt, evidence, state-digest, and Ed25519 authorization.
- Let the core abandon only its own exact pending attempt.
- Record an immutable core operator-abort proof.
- Create a mechanically decidable retention and cleanup endpoint.

### Non-goals

- Automatic timeout from quarantine to failure.
- Runner-authored terminal outcome or rejection.
- Evidence editing, replacement, or continuation.
- Signing on behalf of an operator.
- Reusing a signature for another state or attempt.
- Deleting evidence immediately after disposition.

## 3. Data Contracts (Inputs & Outputs)

### Inspection request

```typescript
interface QuarantineInspectionRequestSketch {
  readonly runnerId: string;
  readonly attemptId: string;
  readonly expectedWorksetDigest?: PayloadDigestV1;
  readonly outputLimitBytes: number;
}
```

Inspection is local and read-only. It discloses no owner token, credentials,
private keys, raw private prompts, or unrestricted paths.

### Inspection report

```typescript
interface QuarantineInspectionReportSketch {
  readonly version: 1;
  readonly runnerId: string;
  readonly turnlockRunId: string;
  readonly delegationId: string;
  readonly attemptId: string;
  readonly worksetId: string;
  readonly quarantineReasonCode: string;
  readonly worksetDigest: PayloadDigestV1;
  readonly pendingCoreStateDigest?: PayloadDigestV1;
  readonly evidenceCommitments: readonly ArtifactCommitmentV2[];
  readonly terminalSelection: "pending";
  readonly disposition: "none" | "resolved-by-core";
  readonly generatedAtEpochMs: number;
}
```

### Operator-abort request

The node accepts `OperatorAbortRequestSketch` from the umbrella CDD. Its detached
Ed25519 signature covers the domain-separated canonical request without the
`authorization` member.

### Core disposition proof contract

```typescript
interface CoreOperatorAbortProofSketch {
  readonly version: 1;
  readonly turnlockRunId: string;
  readonly delegationId: string;
  readonly attemptId: string;
  readonly priorPendingStateDigest: PayloadDigestV1;
  readonly operatorRequestDigest: PayloadDigestV1;
  readonly operatorKeyId: string;
  readonly resultingCoreState: "operator-aborted";
  readonly protocolResultCommitment: ArtifactCommitmentV2;
  readonly committedAtEpochMs: number;
}
```

The core publishes this proof and references it from authoritative state before
emitting the corresponding protocol result.

### Resolved Runner output

The workset becomes `quarantine-resolved`, retains its original quarantine
evidence, stores the proof commitment, blocks every old terminal publication,
and records `resolvedAtEpochMs`. Cleanup eligibility begins only after the
minimum retention interval measured from that timestamp.

## 4. Pipeline

### Read-only inspection

1. Resolve the deterministic attempt namespace.
2. Safe-open and verify the quarantined workset and evidence commitments.
3. Load core state without mutation when its identity remains readable.
4. Produce a bounded report from committed identities and digests.
5. Preserve unknown or unreadable evidence as explicit report failures rather
   than searching for replacements.

### Operator abort

1. Parse the bounded request and require exact quarantine evidence commitment.
2. Reconstruct the canonical `turnlock:operator-abort` subject without the
   authorization field.
3. Resolve `keyId` from the committed trusted public-key registry.
4. Decode and verify the Ed25519 detached signature.
5. Require the core's current pending attempt and state digest to match exactly.
6. Acquire the Runner transaction mutex and revalidate open quarantine, pending
   terminal selection, and absent prior disposition.
7. Commit immutable invocation intent for the fixed core operator-abort API.
8. Release the mutex and invoke the core directly without a shell.
9. Load and verify the core operator-abort proof and protocol outbox result.
10. Reacquire the mutex and require the same quarantine and attempt identity.
11. Atomically record `resolved-by-core`, proof commitment, and resolution time.
12. Publish one sequenced quarantine-disposition event.
13. Leave evidence retained until the policy endpoint permits cleanup.

## 5. Invariants

1. Open quarantine has pending terminal selection and no automatic resume.
2. Inspection never mutates core, workset, evidence, or indexes.
3. The Runner stores no operator private key and cannot sign requests.
4. Signature covers exact attempt, state digest, evidence, and reason.
5. Unknown key, malformed signature, or mismatch commits nothing.
6. Core state-digest compare-and-set is authoritative for abandonment.
7. The Runner accepts only a proof produced by the exact core operation.
8. Operator abort does not fabricate outcome or attempt rejection.
9. Identical authorized repeats converge on the same proof.
10. A different request after disposition conflicts.
11. Late old terminal publication and resume remain forbidden.
12. Retention begins at verified disposition, not quarantine creation.

## 6. Internal Operations

### Alert lifecycle

Quarantine publication creates one persistent sequenced alert. Repeated
inspection does not create duplicate alerts. The alert remains active until the
core proof is selected in the workset and the disposition event is durably
delivered.

### Signature verification

Use native Ed25519 verification against a committed public-key registry. Reject
unknown algorithms, unknown keys, malformed encodings, non-canonical request
bytes, and signatures over any different digest. Never log signature bytes or
private-key material.

### Idempotence

The idempotence identity is the complete canonical operator request digest. A
matching prior core proof and workset disposition is success. A matching core
proof absent from the workset is recoverable. Divergent proof or resulting state
quarantines the disposition operation itself and preserves all evidence.

### Core state already advanced

Do not assume success. Require the exact operator-abort proof and request digest
from core authoritative state. If the core advanced through another valid
operator action, record that distinct disposition only through its own closed
contract. Unexplained advancement remains unresolved.

### Failure behavior

| Condition | Response |
| --------- | -------- |
| Workset not quarantined | Reject operation |
| Terminal route already selected | Reject operator abort |
| Unknown operator key | Authentication failure |
| Signature mismatch | Authentication failure |
| State or evidence digest mismatch | Stale request; no mutation |
| Core still pending after failed invocation | Permit same authorized retry |
| Core proof exists after Runner crash | Verify and adopt proof |
| Core advanced without proof | Preserve unresolved quarantine |
| Disposition event delivery crash | Redeliver same sequence |
| Retention not elapsed | Cleanup remains blocked |

## 7. Cross-Cutting Concerns

Operator requests, proofs, reports, and events use canonical digests and bounded
artifact commitments. Reports reveal only the minimum identities and evidence
references required for diagnosis.

Every authentication and state-CAS failure is auditable without logging secret
or signature material. Quarantine evidence remains immutable. The event stream
does not replace core or workset disposition authority.

## 8. Infrastructure & Environment

The node uses the certified environment, fixed shell-free core API, trusted
Ed25519 public-key registry, local APFS roots, process capture, resource limits,
and Runner coordination standard.

Operator private keys remain external to Turnlock and Runner storage. The
resource policy requires at least 30 days of quarantine evidence retention after
verified disposition under the default profile.

## 9. Dependencies

- Parent delegation-attempt CDD-O for operator-abort request and core proof.
- Parent Runner CDD-O for workset quarantine authority.
- Terminal resume node's fixed process and outbox recovery principles.
- Delivery bridge node for alerts and disposition events.
- Workset cleanup node as downstream consumer of resolved retention state.
- Native Ed25519 support and permanent standards.

## 10. Testing Strategy

Tests cover:

- read-only inspection with complete, missing, corrupt, and oversized evidence;
- report secret and path redaction;
- known and unknown key IDs;
- valid, malformed, wrong-request, wrong-state, and wrong-evidence signatures;
- signature replay across attempts and state digests;
- core compare-and-set race;
- crash before and after core proof and workset disposition;
- identical authorized retry and divergent request conflict;
- core advancement without proof;
- alert and disposition sequence recovery;
- cleanup blocked before disposition and retention expiry;
- proof that no outcome, rejection, resume, or evidence repair occurs.

## 11. Glossary

### Core disposition proof

Core-authored immutable evidence that an authenticated operator abandoned one
exact pending attempt.

### Operator authorization

Detached Ed25519 signature over the canonical state-digest-fenced abort request.

### Quarantine inspection

Bounded read-only projection of committed workset and evidence identities.

### Resolved quarantine

Runner state reached only after validating the core disposition proof; it is not
a successful or failed execution outcome.
