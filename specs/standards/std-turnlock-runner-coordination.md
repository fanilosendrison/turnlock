---
okf_version: "1.0"
kind: "KnowledgeAsset"
asset_type: "standard"
domain: "turnlock-runner-coordination"
severity: "strict"
name: "Turnlock Runner Coordination Standard"
id: "STD-TURNLOCK-RUNNER-COORDINATION"
version: "0.1.0"
---

# Turnlock Runner Coordination Standard

## 1. Scope

Apply this standard to every Runner owner lease, workset transaction mutex,
delivery claim, takeover, and sequential session-delivery decision.

This standard is authoritative for:

- process-instance identity;
- owner fencing and lease state;
- mutex ownership and abandoned-mutex recovery;
- clock anomaly handling;
- delivery sequence allocation and claims;
- stale-owner and stale-claim rejection.

Use
[STD-TURNLOCK-DELEGATION-RESOURCE-POLICY](std-turnlock-delegation-resource-policy.md)
for durations and numeric bounds. Use
[STD-TURNLOCK-DELEGATION-EXECUTION-ENVIRONMENT](std-turnlock-delegation-execution-environment.md)
for supported process and filesystem probes. Use
[STD-TURNLOCK-ARTIFACT-REFERENCE-AND-INTEGRITY](std-turnlock-artifact-reference-and-integrity.md)
for handoff and journal commitments.

## 2. Process-instance identity

Represent a local liveness endpoint and process instance as:

```typescript
interface LocalLivenessEndpointRefV1 {
  readonly kind: "runner-unix-socket";
  readonly endpointId: string;
}

interface ProcessInstanceIdentityV1 {
  readonly version: 1;
  readonly platformBootId: string;
  readonly pid: number;
  readonly processStartIdentity: string;
  readonly livenessEndpointRef: LocalLivenessEndpointRefV1;
  readonly livenessPublicKey: string;
}
```

Require `platformBootId` to change after host reboot. Require
`processStartIdentity` to distinguish two processes that reuse one PID during
the same boot. Before acquiring coordination authority, generate an ephemeral
Ed25519 key pair and bind a private Runner-root Unix-domain liveness endpoint.
Use a canonical ULID as `endpointId`; resolve its socket path through a closed
Runner rule rather than artifact-reference semantics. Persist only the public
key and opaque endpoint reference.

A liveness probe sends a fresh random challenge and accepts
`same-instance-live` only when the endpoint returns a valid Ed25519 signature
under `livenessPublicKey` over the domain-separated challenge and complete
process identity. The private key remains in process memory and is destroyed on
exit.

Never treat PID equality, PID liveness, endpoint-file existence, a lock-file
modification time, or a public key alone as proof that a process instance is
still current. Remove a stale socket object only after the combined process
probe proves absence or reuse and the opened socket object still matches the
recorded endpoint identity.

A process probe returns exactly one verdict:

```typescript
type ProcessProbeVerdictV1 =
  | { readonly kind: "same-instance-live" }
  | { readonly kind: "instance-absent-or-reused" }
  | { readonly kind: "indeterminate"; readonly reason: string };
```

Return `instance-absent-or-reused` only when the OS process/start probe proves
absence or reuse and no valid liveness response exists. Return `indeterminate`
when permissions, endpoint connectivity, unsupported platform behavior, corrupt
identity, or inconsistent OS and challenge probes prevent a positive
conclusion. Never convert `indeterminate` into absence.

## 3. Owner lease contract

Represent one coordination clock sample as:

```typescript
interface CoordinationClockSampleV1 {
  readonly platformBootId: string;
  readonly wallEpochMs: number;
  readonly bootMonotonicMs: number;
}
```

`bootMonotonicMs` comes from one operating-system monotonic clock shared by
processes during the same boot. It is never compared across different
`platformBootId` values.

Represent one logical Runner-session lease as:

```typescript
interface OwnerLeaseV1 {
  readonly version: 1;
  readonly runnerId: string;
  readonly sessionKey: string;
  readonly generation: number;
  readonly ownerToken: string;
  readonly process: ProcessInstanceIdentityV1;
  readonly acquiredAtEpochMs: number;
  readonly heartbeatAtEpochMs: number;
  readonly heartbeatAtBootMonotonicMs: number;
  readonly leaseDurationMs: number;
  readonly leaseUntilEpochMs: number;
  readonly state: "active" | "handoff-ready";
  readonly handoffCommitment?: ArtifactCommitmentV2;
}
```

Require `generation` to begin at one and increase exactly once for each
successful new owner. Require `ownerToken` to be a fresh secret for each
generation. Never persist the token in worker-facing, host-facing, delivery, or
diagnostic artifacts.

An owner-only transition is authorized only when one critical section observes:

- the current lease generation and token;
- the same workset generation;
- an unexpired active lease;
- the same live process instance;
- the transaction mutex held by the caller.

A heartbeat may extend only the exact current generation and token. It must not
resurrect an expired generation after a successor has committed ownership.

## 4. Lease acquisition and takeover

Initial acquisition uses exclusive creation of the session lease authority.
Concurrent initial candidates permit exactly one winner.

A successor may take ownership only through one of these proofs:

1. the prior owner selected `handoff-ready` with a valid immutable handoff
   commitment, released every transaction mutex, and stopped initiating owner
   transitions;
2. on the same boot, the lease is expired under boot-monotonic time, the process
   probe returns `instance-absent-or-reused`, and no clock anomaly exists; or
3. `platformBootId` changed, proving the prior process cannot remain live, and
   the new boot's wall-clock sanity check succeeds.

Expiry alone is insufficient. Process absence alone is insufficient while an
unexpired lease exists. A probe result of `same-instance-live` rejects takeover.
A probe result of `indeterminate` stops automatic takeover and requests
quarantine or operator inspection according to the owning workset contract.

Takeover occurs under the recoverable session-acquisition mutex and commits one
atomic lease replacement with `generation + 1` and a fresh token. The successor
must not reconcile or mutate worksets before that replacement is authoritative.

A returning prior owner fails every owner-only transition because its generation
and token no longer match, even if it later acquires the transaction mutex.

## 5. Clock contract

Use epoch milliseconds for persisted Turnlock deadlines and audit timestamps.
Use the operating-system boot-monotonic clock for lease, mutex, and claim expiry
within one boot. Use a process monotonic clock only for local operation duration.

On the same boot, expiry is exactly:

```text
now.bootMonotonicMs
  >= lastRenewal.bootMonotonicMs
   + committedLeaseDurationMs
   + bootMonotonicResolutionMs
```

The added resolution margin prevents a coarse floor-valued uptime sample from
expiring authority early. Never decide same-boot expiry from wall time. Keep
`leaseUntilEpochMs` only for cross-checking and human diagnosis.

For two successive same-boot samples, calculate:

```text
wallDelta = current.wallEpochMs - previous.wallEpochMs
monoDelta = current.bootMonotonicMs - previous.bootMonotonicMs
clockDelta = wallDelta - monoDelta
```

A negative `clockDelta` whose magnitude exceeds `maxClockRegressionMs`, or a
positive `clockDelta` exceeding `maxFutureClockSkewMs`, produces
`clock-indeterminate`. A decreasing boot-monotonic value under the same boot ID
is also indeterminate.

After a boot-ID change, never compare boot-monotonic values. The old process is
necessarily absent, but deadline, cleanup, and takeover operations still require
the new wall clock not to precede the last committed wall observation by more
than `maxClockRegressionMs`. Otherwise operator inspection is required.

Each lease, mutex, or claim update verifies duration against the resource
policy, wall/monotonic consistency, and matching boot identity. Automatic
takeover, claim recovery, deadline terminalization, and cleanup stop on
`clock-indeterminate`.

Never use an external executor timestamp to decide Runner intake, expiry, or
ownership.

## 6. Transaction mutex contract

Represent the short workset mutex as:

```typescript
interface TransactionMutexV1 {
  readonly version: 1;
  readonly scopeRef: string;
  readonly holderId: string;
  readonly holderProcess: ProcessInstanceIdentityV1;
  readonly acquiredAtEpochMs: number;
  readonly acquiredAtBootMonotonicMs: number;
  readonly leaseDurationMs: number;
  readonly leaseUntilEpochMs: number;
}
```

Acquire the mutex through exclusive creation. Bound every critical section by
`transactionMutexLeaseMs`; long external calls, model execution, waiting, and
unbounded parsing are forbidden while it is held.

Release requires exact equality of `scopeRef`, `holderId`, process identity, and
the opened mutex object identity. An old holder must never unlink or replace a
successor's mutex.

Recover an abandoned mutex only when:

- its lease is expired;
- its process probe returns `instance-absent-or-reused`;
- its record and opened object identity are valid;
- no clock anomaly exists.

Preserve already published immutable candidates during recovery. After
acquisition, reload authoritative state and reconstruct the candidate-to-
snapshot relation before selecting any transition.

Malformed mutex state, indeterminate process identity, or object replacement
during recovery fails closed. Never delete a mutex merely because it is old.

## 7. Delivery sequence contract

Every semantic event for one `sessionKey` carries a durable sequence:

```typescript
interface DeliverySequenceV1 {
  readonly sessionKey: string;
  readonly sequence: number;
  readonly predecessorEventDigest: string | null;
}
```

Allocate `sequence` under the session delivery mutex. The first event uses one
and a null predecessor. Every later event uses the previous sequence plus one
and commits the previous event's semantic digest.

A duplicate semantic event retains its original event identity and sequence.
A divergent event claiming an allocated sequence is a conflict. Do not repair a
conflict by renumbering existing events.

The bridge may claim only the lowest not-yet-delivered sequence. It must not skip
a missing, inflight, or indeterminate predecessor. An explicit immutable
operator disposition signed by a committed trusted Ed25519 operator key is
required to terminalize an undeliverable gap.

## 8. Delivery claims

Represent claim metadata separately from immutable event semantics:

```typescript
interface DeliveryClaimV1 {
  readonly version: 1;
  readonly eventId: string;
  readonly sessionKey: string;
  readonly sequence: number;
  readonly claimantId: string;
  readonly claimantProcess: ProcessInstanceIdentityV1;
  readonly claimedAtEpochMs: number;
  readonly claimedAtBootMonotonicMs: number;
  readonly leaseDurationMs: number;
  readonly leaseUntilEpochMs: number;
}
```

Claim recovery follows the same expiry, process-probe, object-identity, and clock
rules as transaction-mutex recovery. Successful delivery commits delivered
evidence before releasing the claim. The delivered journal is authoritative;
the deduplication index is derived and rebuildable.

At-least-once transport may repeat an event, but the receiving session observes
non-decreasing contiguous semantic sequence.

## 9. Graceful handoff

Graceful shutdown performs this bounded sequence:

1. stop initiating new owner transitions;
2. complete or safely abandon the current short transaction;
3. persist a stable workset and delivery boundary;
4. publish an immutable handoff artifact committing the owner generation, last
   stable workset digests, delivery sequence, and absence of a held mutex;
5. atomically mark the lease `handoff-ready` with that commitment;
6. stop heartbeats and relinquish process authority.

A successor verifies the handoff commitment and current mutex absence under the
session-acquisition mutex before incrementing the fence. The prior process may
still be exiting, but the committed handoff state and new fence prevent any
further authorized mutation.

Graceful handoff does not close intake, stop external execution, create an
outcome, or select an attempt terminal route. A successor still increments the
fence generation before reconciliation.

## 10. Failure behavior

Apply these closed responses:

| Condition | Response |
| --------- | -------- |
| Active matching owner | Reject takeover |
| Expired lease and absent/reused process | Permit fenced takeover |
| Expired lease and live process | Reject takeover and alert |
| Process probe indeterminate | Stop automatic recovery |
| Clock anomaly | Stop time-dependent transitions |
| Stale owner mutation | Commit nothing |
| Abandoned mutex proven | Recover, reload, and reconcile |
| Mutex state malformed | Quarantine owning scope |
| Delivery predecessor missing | Stop delivery at the gap |
| Sequence or digest conflict | Quarantine delivery stream |
| Expired claim and absent claimant | Recover the same event |

## 11. Conformance

Require deterministic tests for:

- simultaneous initial owner acquisition;
- heartbeat and exact-boundary expiry;
- PID reuse in one boot;
- host reboot with a reused PID;
- valid, forged, stale, and unreachable liveness endpoints;
- live, absent, reused, and indeterminate combined process probes;
- cross-process boot-monotonic comparability;
- same-boot clock rollback and future timestamp anomalies;
- boot-ID change with sane and regressed wall clocks;
- takeover generation monotonicity;
- stale owner after takeover;
- mutex holder crash before and after candidate publication;
- old-holder release racing successor acquisition;
- contiguous sequence allocation;
- duplicate and divergent sequence publication;
- claim crash before and after delivered evidence;
- delivery gap handling;
- graceful handoff without cancellation side effects.

## 12. Consumers

The Runner orchestration, its nodes, and every execution strategy consume this
standard. No consumer may define a weaker local lease, mutex, process identity,
claim, or delivery-order rule.
