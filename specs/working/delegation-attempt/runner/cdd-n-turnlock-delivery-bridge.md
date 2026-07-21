---
okf_version: "1.0"
kind: "RuntimeArtifact"
format: "cubits-design-doc"
workspace: "turnlock"
date: "2026-07-21"
step_id: 0
id: "CDD-N-TURNLOCK-DELIVERY-BRIDGE"
version: "0.1.0"
scope: "delivery-bridge"
status: "draft"
consumers:
  - "agent-generator"
superseded_by: []
---

# CDD-N: Turnlock Delivery Bridge

## 1. Objectif & Position

This node transports immutable Runner events into one harness session with
at-least-once delivery and mechanically enforced sequential ordering.

It is a worker node of
[CDD-O Turnlock Runner Execution](cdd-o-turnlock-runner-execution.md). Event
producers commit semantic events; this node claims and delivers them. Delivery
never proves host submission, workset terminality, or core workflow progression.

## 2. Goals & Non-Goals

### Goals

- Allocate one contiguous sequence per session.
- Commit predecessor linkage and semantic digest.
- Separate immutable event semantics from recoverable claims.
- Deliver only the lowest undelivered sequence.
- Record authoritative delivered evidence before advancing.
- Rebuild deduplication indexes from the delivered journal.
- Recover process, claim, and acknowledgement crashes.

### Non-goals

- External worker scheduling.
- Workset mutation or terminal selection.
- Exactly-once transport.
- Delivery reordering for throughput.
- Silent skipping of an undeliverable event.
- Treating a dedupe index as authority.

## 3. Data Contracts (Inputs & Outputs)

### Event

```typescript
interface DeliveryEventSketch {
  readonly version: 1;
  readonly eventId: string;
  readonly runnerId: string;
  readonly sessionKey: string;
  readonly sequence: number;
  readonly predecessorEventDigest: PayloadDigestV1 | null;
  readonly invocationId: string;
  readonly ownerGeneration: number;
  readonly semanticDedupeKey: string;
  readonly semanticDigest: PayloadDigestV1;
  readonly eventKind:
    | "host-continuation"
    | "turnlock-terminal"
    | "runner-error"
    | "turnlock-aborted"
    | "quarantine-alert"
    | "quarantine-disposition";
  readonly payloadCommitment: ArtifactCommitmentV2;
  readonly createdAtEpochMs: number;
}
```

Sequence and predecessor fields are part of immutable event semantics.
Transport claim identity and timestamps are excluded from semantic digest.

### Claim

Claims use `DeliveryClaimV1` from the Runner coordination standard. They are
mutable transport metadata and never alter event identity.

### Delivered evidence

```typescript
interface DeliveredEventSketch {
  readonly version: 1;
  readonly eventId: string;
  readonly sessionKey: string;
  readonly sequence: number;
  readonly semanticDigest: PayloadDigestV1;
  readonly payloadCommitment: ArtifactCommitmentV2;
  readonly transportReceiptDigest?: PayloadDigestV1;
  readonly deliveredAtEpochMs: number;
}
```

The delivered journal is authoritative. The dedupe index is derived.

### Gap disposition

```typescript
interface DeliveryGapDispositionSketch {
  readonly version: 1;
  readonly sessionKey: string;
  readonly eventId: string;
  readonly sequence: number;
  readonly semanticDigest: PayloadDigestV1;
  readonly boundedReason: string;
  readonly authorization: {
    readonly algorithm: "ed25519";
    readonly keyId: string;
    readonly signature: string;
  };
}
```

An undeliverable sequence may be terminalized only by this immutable operator
disposition. The signature covers its domain-separated canonical content without
`authorization` and resolves through the trusted operator public-key registry.
A disposition remains visible in the delivered journal and does not renumber
later events.

## 4. Pipeline

### Event allocation

1. Acquire the session delivery mutex.
2. Load the last authoritative event or delivered entry.
3. Allocate sequence one with null predecessor, or previous sequence plus one
   with the previous semantic digest.
4. Publish immutable payload and event artifacts.
5. Atomically publish the pending-event journal entry.
6. Release the mutex.

### Claim and delivery

1. Load the lowest sequence absent from the delivered journal.
2. Require every predecessor to be delivered or explicitly disposed.
3. Validate event, payload, semantic digest, sequence, and predecessor linkage.
4. Acquire a claim through exclusive creation.
5. Deliver the event to the exact configured session with the bounded transport
   deadline.
6. On acknowledged delivery, publish immutable delivered evidence.
7. Atomically advance the delivered journal.
8. Release only the exact claim instance.
9. Update the derived dedupe index after authoritative delivery.

### Recovery

1. Reconcile pending, claimed, delivered, and disposition journals by sequence.
2. Recover a claim only after expiry, definite claimant-instance absence, and
   valid clock evidence.
3. Redeliver the same event identity and sequence when acknowledgement is
   uncertain.
4. Stop at any missing, divergent, or indeterminate sequence.

## 5. Invariants

1. Sequence begins at one and increases contiguously per session.
2. Every sequence after one commits its predecessor semantic digest.
3. One sequence maps to one immutable semantic event.
4. Divergent reuse of event identity, dedupe key, or sequence is a conflict.
5. Only the lowest undelivered event may be claimed.
6. Claim metadata never changes semantic identity.
7. At-least-once delivery may repeat but never reorder semantic sequence.
8. Delivered journal, not dedupe index, is authority.
9. A gap is never skipped silently.
10. Delivery does not mutate workset or core state.
11. Owner tokens and raw secrets never enter events.

## 6. Internal Operations

### Dedupe evaluation

An existing delivered entry with the same semantic dedupe key and digest makes
a repeated event idempotently delivered. The same key with another digest is a
conflict. A missing or corrupt index is rebuilt from the journal before use.

### Claim recovery

Claim age alone is insufficient. Recovery requires policy expiry, process
identity proving absence or reuse, object-identity validation, and no clock
anomaly. An indeterminate claim blocks the sequence and alerts.

### Refencing

A successor does not copy an old event and replace `ownerGeneration`. It
revalidates current workset and core semantics. Still-current semantics retain
the existing event identity; obsolete pending events receive explicit archival
or disposition evidence without delivery.

### Gap behavior

Missing predecessor, digest mismatch, or divergent sequence stops delivery for
that session. Operator inspection may repair a missing non-authoritative index,
but cannot rewrite immutable event semantics. An authenticated disposition is
required when delivery cannot be completed.

### Failure behavior

| Condition | Response |
| --------- | -------- |
| Duplicate identical event | Converge on original sequence |
| Duplicate divergent event | Stop stream and alert |
| Active valid claim | Leave for current claimant |
| Expired claim and absent claimant | Recover same event |
| Indeterminate claimant or clock | Stop at sequence |
| Transport timeout after possible delivery | Redeliver same event later |
| Journal commit crash | Reconcile receipt; redeliver if uncertain |
| Dedupe index corruption | Rebuild from delivered journal |
| Sequence gap | Stop; require recovery or disposition |

## 7. Cross-Cutting Concerns

Events, claims, delivered evidence, receipts, and dispositions are bounded and
artifact-committed. Semantic event digests exclude claim timestamps, process
identity, and owner secrets but include every field changing recipient behavior.

Observability reports sequence, event identity, attempts, and bounded failure
facts without embedding host tasks or terminal payloads. Retention preserves the
journal while any workset, session, quarantine, or audit requirement references
it.

## 8. Infrastructure & Environment

The node consumes the certified local environment, resource policy, artifact,
canonical JSON, and Runner coordination standards. It requires one durable local
journal root reachable by event producers and the bridge.

Transport is bounded by `deliveryAttemptMs`; claim authority is bounded by
`deliveryClaimLeaseMs`. Process and clock anomaly behavior is not redefined
locally.

## 9. Dependencies

- Parent Runner CDD-O.
- Admission, host intake, terminal resume, and quarantine paths as event
  producers.
- Runner coordination standard for sequence, claim, process, and clock rules.
- Harness-specific transport binding configured outside event semantics.

## 10. Testing Strategy

Tests cover:

- first and subsequent sequence allocation;
- predecessor digest linkage;
- concurrent publishers and one sequence winner;
- identical duplicate convergence and divergent conflict;
- lowest-undelivered-only claims;
- live, expired, absent, reused, and indeterminate claimant cases;
- transport acknowledgement before and after bridge crash;
- repeated at-least-once delivery with stable identity;
- delivered journal crash and recovery;
- dedupe index deletion and corruption;
- sequence gap, wrong predecessor, and operator disposition;
- stale-owner refencing without semantic mutation;
- proof that delivery never changes workset or core state.

## 11. Glossary

### Delivery claim

Recoverable temporary authority to deliver one immutable event.

### Delivered journal

Authoritative ordered evidence of successful delivery or explicit disposition.

### Delivery sequence

Contiguous per-session event position with predecessor digest linkage.

### Semantic dedupe key

Stable identity for recipient-visible behavior, independent of transport retry.
