---
okf_version: "1.0"
kind: "KnowledgeAsset"
asset_type: "standard"
domain: "turnlock-delegation-resource-policy"
severity: "strict"
name: "Turnlock Delegation Resource Policy Standard"
id: "STD-TURNLOCK-DELEGATION-RESOURCE-POLICY"
version: "0.1.0"
---

# Turnlock Delegation Resource Policy Standard

## 1. Scope

Apply this standard to every delegation attempt, Runner session, execution
strategy, delivery bridge, and operator-recovery operation introduced by the
delegation-attempt corpus.

This standard owns all behavior-affecting limits that cross component
boundaries. A CDD or NIB may specialize a value only through a validated policy
instance conforming to this standard.

## 2. Policy contract

Represent the complete policy as:

```typescript
interface DelegationResourcePolicyV1 {
  readonly version: 1;
  readonly workerJobCount: number;
  readonly externalConcurrency: number;

  readonly ownerLeaseMs: number;
  readonly ownerHeartbeatMs: number;
  readonly transactionMutexLeaseMs: number;
  readonly deliveryClaimLeaseMs: number;
  readonly bootMonotonicResolutionMs: number;
  readonly maxClockRegressionMs: number;
  readonly maxFutureClockSkewMs: number;

  readonly startupAttempts: number;
  readonly startupTotalBudgetMs: number;
  readonly launchAcknowledgementMs: number;
  readonly observationPollMs: number;
  readonly stopRequestMs: number;
  readonly stopReconciliationMs: number;
  readonly deliveryAttemptMs: number;
  readonly resumeStartupMs: number;

  readonly launchAndObservationReserveMs: number;
  readonly outputNormalizationReserveMs: number;
  readonly publicationAndAdoptionReserveMs: number;
  readonly terminalAndResumeReserveMs: number;

  readonly rpcReplyBytes: number;
  readonly lifecycleArtifactBytes: number;
  readonly rawOutputBytesPerJob: number;
  readonly submissionBytesPerJob: number;
  readonly diagnosticArtifactBytes: number;
  readonly protocolStdoutBytes: number;
  readonly protocolStderrBytes: number;

  readonly jsonInputBytes: number;
  readonly jsonDepth: number;
  readonly jsonObjectMembers: number;
  readonly jsonArrayItems: number;
  readonly jsonStringBytes: number;

  readonly relativePathBytes: number;
  readonly relativePathSegments: number;
  readonly relativePathSegmentBytes: number;

  readonly terminalRetentionDays: number;
  readonly orphanRetentionDays: number;
  readonly unreferencedCandidateRetentionHours: number;
  readonly temporaryArtifactRetentionHours: number;
  readonly quarantineMinimumRetentionDays: number;
}
```

Calculate and commit its semantic digest under the
`turnlock:delegation-resource-policy` domain before admission. Persist the
digest in the Runner session authority and every workset. Recovery must reject
ambient policy drift for an active attempt.

## 3. Default profile

Use this complete default profile when deployment configuration does not supply
an explicit policy:

| Field | Default | Allowed range |
| ----- | -------: | -------------: |
| `workerJobCount` | 8 | 1–8 |
| `externalConcurrency` | 4 | 1–4 and no greater than `workerJobCount` |
| `ownerLeaseMs` | 30,000 | 15,000–60,000 |
| `ownerHeartbeatMs` | 10,000 | 5,000–20,000 |
| `transactionMutexLeaseMs` | 15,000 | 5,000–30,000 |
| `deliveryClaimLeaseMs` | 60,000 | 15,000–120,000 |
| `bootMonotonicResolutionMs` | 1,000 | 1–1,000 |
| `maxClockRegressionMs` | 5,000 | 0–30,000 |
| `maxFutureClockSkewMs` | 60,000 | 5,000–300,000 |
| `startupAttempts` | 3 | 1–3 |
| `startupTotalBudgetMs` | 10,000 | 1,000–30,000 |
| `launchAcknowledgementMs` | 10,000 | 1,000–30,000 |
| `observationPollMs` | 250 | 100–2,000 |
| `stopRequestMs` | 10,000 | 1,000–30,000 |
| `stopReconciliationMs` | 30,000 | 5,000–120,000 |
| `deliveryAttemptMs` | 30,000 | 1,000–120,000 |
| `resumeStartupMs` | 20,000 | 5,000–60,000 |
| `launchAndObservationReserveMs` | 30,000 | 10,000–120,000 |
| `outputNormalizationReserveMs` | 20,000 | 5,000–120,000 |
| `publicationAndAdoptionReserveMs` | 20,000 | 5,000–120,000 |
| `terminalAndResumeReserveMs` | 30,000 | 10,000–120,000 |
| `rpcReplyBytes` | 1,048,576 | 65,536–4,194,304 |
| `lifecycleArtifactBytes` | 4,194,304 | 262,144–16,777,216 |
| `rawOutputBytesPerJob` | 1,048,576 | 65,536–4,194,304 |
| `submissionBytesPerJob` | 1,048,576 | 65,536–4,194,304 |
| `diagnosticArtifactBytes` | 65,536 | 4,096–262,144 |
| `protocolStdoutBytes` | 10,485,760 | 1,048,576–10,485,760 |
| `protocolStderrBytes` | 10,485,760 | 1,048,576–10,485,760 |
| `jsonInputBytes` | 2,097,152 | 65,536–4,194,304 |
| `jsonDepth` | 64 | 8–128 |
| `jsonObjectMembers` | 4,096 | 64–16,384 |
| `jsonArrayItems` | 4,096 | 64–16,384 |
| `jsonStringBytes` | 1,048,576 | 4,096–2,097,152 |
| `relativePathBytes` | 4,096 | 256–4,096 |
| `relativePathSegments` | 64 | 4–128 |
| `relativePathSegmentBytes` | 255 | 32–255 |
| `terminalRetentionDays` | 7 | 1–90 |
| `orphanRetentionDays` | 7 | 1–30 |
| `unreferencedCandidateRetentionHours` | 24 | 1–168 |
| `temporaryArtifactRetentionHours` | 24 | 1–168 |
| `quarantineMinimumRetentionDays` | 30 | 7–365 |

Reject an explicit policy containing an omitted field, unknown field, fractional
value, non-finite value, out-of-range value, or violated relation. Never fill a
partially supplied explicit policy from ambient defaults.

## 4. Relational constraints

Enforce all of these relations:

```text
ownerLeaseMs >= 3 * ownerHeartbeatMs
transactionMutexLeaseMs <= ownerLeaseMs
deliveryClaimLeaseMs >= deliveryAttemptMs
bootMonotonicResolutionMs <= ownerHeartbeatMs / 5
externalConcurrency <= workerJobCount
jsonStringBytes <= jsonInputBytes
submissionBytesPerJob <= jsonInputBytes
```

The configured Turnlock attempt timeout must exceed the fixed post-execution
reserve:

```text
postExecutionReserveMs
  = launchAndObservationReserveMs
  + outputNormalizationReserveMs
  + publicationAndAdoptionReserveMs
  + terminalAndResumeReserveMs
```

Before dispatch, calculate:

```text
maximumExternalRuntimeMs
  <= deadlineAtEpochMs
   - nowEpochMs
   - postExecutionReserveMs
```

Reject dispatch with `insufficient-deadline-margin` when the right-hand side is
not positive or is lower than the committed requested runtime. Do not borrow
from any reserve after dispatch.

## 5. Retry and timeout behavior

Use `startupAttempts` only to establish one dependency process or RPC
connection before any launch acknowledgement. Retries consume
`startupTotalBudgetMs` and must not create more than one external launch intent.

Do not apply hidden retries to:

- Turnlock business attempts;
- divergent artifact publication;
- owner or mutex acquisition;
- launch requests after uncertain acknowledgement;
- result normalization;
- terminal publication;
- operator actions.

The core retry policy remains independent and authoritative after a valid
terminal failure or attempt rejection.

## 6. Size-limit behavior

Bound raw bytes before decoding, parsing, canonicalizing, logging, or copying.
On limit exhaustion:

- stop reading at the configured limit;
- preserve only the bounded permitted diagnostic prefix or digest evidence;
- return the owning closed validation or execution-failure code;
- never parse a truncated JSON value as complete;
- never increase a limit automatically for a retry.

Human-facing messages remain limited to 200 Unicode scalar values even when a
diagnostic artifact permits more bytes.

## 7. Retention behavior

Retain referenced artifacts regardless of age. Age permits collection only when
no authoritative snapshot, delivery claim, resume outbox, quarantine record,
operator proof, or diagnostic hold references the artifact.

Quarantine evidence has no automatic deletion endpoint before both conditions
hold:

1. a core operator-abort or other explicit disposition proof resolves the
   pending attempt; and
2. `quarantineMinimumRetentionDays` has elapsed after that proof.

A cleanup failure never shortens retention. Repeated cleanup must be idempotent.

## 8. Policy evolution

Treat a field addition, field removal, unit change, range change, default change,
or relational-rule change as a versioned policy change. An active attempt keeps
its committed policy version and digest until terminal disposition.

Do not migrate an active workset to a new resource policy in place. A retry may
use a new policy only because it creates a new attempt and workset.

## 9. Conformance

Require tests for:

- the exact default profile;
- every inclusive range boundary;
- every relational constraint;
- partial and unknown-field rejection;
- policy digest drift during recovery;
- exact deadline-reserve arithmetic;
- startup retries without duplicate launch;
- every byte limit before parsing;
- referenced-artifact retention beyond age;
- quarantine retention before and after operator disposition.

## 10. Consumers

The Turnlock core, Runner orchestration, Runner nodes, Pi strategy, delivery
bridge, cleanup operations, and operator tools consume this standard. NIBs may
encode these values but must not choose replacements for them.
