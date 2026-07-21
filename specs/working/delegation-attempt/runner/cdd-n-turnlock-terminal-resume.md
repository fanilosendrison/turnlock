---
okf_version: "1.0"
kind: "RuntimeArtifact"
format: "cubits-design-doc"
workspace: "turnlock"
date: "2026-07-21"
step_id: 0
id: "CDD-N-TURNLOCK-TERMINAL-RESUME"
version: "0.1.0"
scope: "terminal-resume"
status: "draft"
consumers:
  - "agent-generator"
superseded_by: []
---

# CDD-N: Turnlock Terminal Resume

## 1. Objectif & Position

This node materializes an already selected Runner terminal envelope, invokes the
fixed Turnlock core resume operation, validates the resulting protocol output,
and durably hands off the next core result.

It is a worker node of
[CDD-O Turnlock Runner Execution](cdd-o-turnlock-runner-execution.md). It does not
select outcomes, rejection, retry, or workflow progression.

## 2. Goals & Non-Goals

### Goals

- Publish the exact selected terminal envelope at the core-allocated target.
- Replace opaque shell commands with a structured resume operation.
- Resolve executable, argv, working directory, and environment from trusted
  deployment commitments.
- Capture bounded process status, signal, stdout, and stderr.
- Recover exact core output after the core advances but Runner capture is lost.
- Make duplicate invocation idempotent by `invocationId` and core outbox.
- Durably route the next `DELEGATE`, `DONE`, `ERROR`, or `ABORTED` result.

### Non-goals

- Terminal-route selection.
- Failure aggregation or retry policy.
- Reconstruction of a command from ambient defaults.
- Shell evaluation.
- Blind archival of a stale invocation after core state advances.
- Repair of divergent core and Runner authority.

## 3. Data Contracts (Inputs & Outputs)

### Selected terminal input

The node requires a workset whose terminal selection is
`outcomes-complete` or `attempt-rejected`, whose publication is pending or
identically complete, and whose resume state is not completed by a divergent
invocation.

### Invocation intent contract

```typescript
interface CoreInvocationIntentSketch {
  readonly version: 1;
  readonly operation: "resume-delegation-attempt";
  readonly invocationId: string;
  readonly resumeOperationDigest: PayloadDigestV1;
  readonly coreExecutableCommitment: PayloadDigestV1;
  readonly argv: readonly string[];
  readonly workingDirectoryIdentity: string;
  readonly environmentAllowlistDigest: PayloadDigestV1;
  readonly stdoutTarget: ArtifactTargetRefV1;
  readonly stderrTarget: ArtifactTargetRefV1;
}
```

The stdout and stderr targets are Runner-relative with purpose
`process-capture`. `argv` is generated from the closed resume-operation schema.
It contains no shell metacharacter interpretation. The executable never comes
from the attempt's portable input.

### Process observation

```typescript
interface CoreProcessObservationSketch {
  readonly version: 1;
  readonly invocationIntentCommitment: ArtifactCommitmentV2;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly stdoutCommitment?: ArtifactCommitmentV2;
  readonly stderrCommitment?: ArtifactCommitmentV2;
  readonly startedAtEpochMs: number;
  readonly endedAtEpochMs?: number;
  readonly observationState: "complete" | "supervisor-lost";
}
```

A lost supervisor is not interpreted as a core failure. Recovery consults core
state and the outbox.

### Core outbox result

The core-owned `CoreResumeOutboxSketch` from the parent CDD commits the exact
protocol artifact before `state.json` advances. The fixed operation
`inspect-or-reemit-current-result` accepts `invocationId`, run identity, and
expected operation digest and returns only that committed result.

### Output

The node commits one validated protocol result and publishes one immutable
handoff or terminal delivery event. A replacement `DELEGATE` enters a new
attempt admission path and never mutates the old workset into the new attempt.

## 4. Pipeline

1. Resolve the deterministic workset by attempt identity.
2. Acquire the mutex and verify current owner, terminal selection, publication,
   resume state, manifest, core pending state, and fixed environment identity.
3. Construct the exact canonical terminal envelope bytes already embedded in
   the workset.
4. Publish them write-once at the core terminal target and verify the content
   and semantic digests.
5. Atomically record terminal publication in the workset.
6. Construct and publish immutable invocation intent and capture targets.
7. Atomically set resume state to `in-progress` with the same `invocationId`.
8. Release the mutex before process start.
9. Spawn the fixed core executable directly with the closed argv and environment
   allowlist; redirect stdout and stderr to bounded capture targets.
10. Observe exit status and signal when the supervisor remains alive.
11. Load core authoritative state and locate the outbox commitment for the
    invocation.
12. If capture is absent or incomplete after core advancement, invoke the fixed
    inspect-or-reemit operation.
13. Require exact equality between the validated protocol artifact, outbox
    commitment, operation digest, invocation identity, and resulting core state.
14. Commit the process observation and protocol result in the workset.
15. Publish the next immutable sequenced handoff or terminal event.
16. Mark the old workset `resumed` only after durable event publication.

## 5. Invariants

1. Resume starts only from a selected and published terminal route.
2. Terminal publication reproduces embedded selected bytes exactly.
3. No raw command string, shell dialect, or mutable `PATH` decides execution.
4. One structured operation maps to one stable `invocationId`.
5. The core publishes a complete immutable transition candidate before one
   authoritative state replacement selects its outbox.
6. An unselected core candidate is never emitted as protocol output.
7. Runner capture is evidence, not the sole source of recoverable core output.
8. Core and Runner operation digests must match.
9. A new `DELEGATE` creates a new attempt and workset.
10. Duplicate invocation converges on one outbox result.
11. Divergent outbox, protocol, or core state quarantines the old workset.
12. Process stderr never enters stdout protocol parsing.
13. Workset `resumed` implies durable downstream handoff or delivery.

## 6. Internal Operations

### Terminal publication

If no target artifact exists, publish selected canonical bytes. If identical
bytes exist, record the verified commitment idempotently. If different bytes
exist, preserve conflict evidence and quarantine. Never recompute route
selection from ambient state.

### Trusted process launch

The deployment profile resolves executable identity before admission. The node
builds argv from typed fields and passes a closed environment allowlist. It sets
capture limits before process start and never concatenates a shell command.

### Protocol validation

Require exactly one complete compatible protocol block, bounded stdout, coherent
process/outbox identity, and an allowed action. The outbox artifact is parsed
through strict protocol rules even when stdout appears valid.

### Lost-supervisor recovery

```text
Runner supervisor lost
  -> reload workset invocation intent
  -> inspect core state for matching outbox
  -> if present, safe-open and validate exact result
  -> if state advanced but local bytes missing, request exact re-emission
  -> commit observation and continue handoff
```

If core state remains pending and no matching live process or outbox exists, the
same invocation may be retried under the core run lock. If core state advanced
without a matching outbox, quarantine; do not archive and guess.

### Duplicate resume

An existing completed record with identical invocation and outbox is success.
An in-progress record is reconciled before spawning. A different invocation for
the same terminal selection is a conflict.

### Failure behavior

| Condition | Response |
| --------- | -------- |
| Terminal not selected | Refuse resume |
| Terminal target divergent | Quarantine |
| Core expects another attempt | Inspect conflict; do not launch blindly |
| Executable or environment drift | Reject before launch; quarantine if late |
| Capture complete but outbox absent | Preserve core protocol failure evidence |
| Supervisor lost and matching outbox exists | Recover exact result |
| Core advanced without matching outbox | Quarantine |
| Multiple protocol blocks | Protocol violation |
| New replacement attempt | Durable handoff to new admission |
| Event publication crash | Republish same sequenced event |

## 7. Cross-Cutting Concerns

Invocation intent, process observation, terminal bytes, outbox, and events use
canonical digests and artifact commitments. Output limits apply before parsing.

Executable identity, environment, and working directory are committed but
secrets and absolute portable paths are excluded from semantic events. Bounded
stderr may be retained as diagnostic evidence and never controls protocol.

Cleanup retains invocation intent, captures, outbox, terminal, and handoff until
the workset is resumed, downstream delivery is durable, and policy permits
collection.

## 8. Infrastructure & Environment

The node requires the exact certified platform, direct process spawn, trusted
executable binding, process identity probes, local APFS durability, and resource
limits. It uses the core run-root binding for terminal and outbox artifacts and
the Runner root for invocation and process observations.

The core fixed API exposes only versioned `resume-delegation-attempt` and
`inspect-or-reemit-current-result` operations for this scope. Adding a shell
fallback is forbidden.

## 9. Dependencies

- Parent delegation-attempt CDD-O for core outbox and resume operation.
- Parent Runner CDD-O for workset and ownership.
- Outcome and terminal node for selected terminal input.
- Admission and handoff node for replacement `DELEGATE` output.
- Delivery bridge node for terminal session transport.
- Permanent environment, resource, artifact, canonical JSON, and coordination
  standards.

## 10. Testing Strategy

Tests cover:

- refusal before terminal selection;
- identical and divergent terminal target publication;
- argv boundary preservation and shell-metacharacter non-evaluation;
- executable, working directory, and environment drift;
- every exit, signal, stdout, stderr, and protocol combination;
- crash before and after invocation intent, process start, transition-candidate
  publication, candidate selection in core state, stdout emission, observation
  commit, event publication, and resumed state;
- zero, one, multiple, identical, and divergent unselected core candidates;
- supervisor loss with exact outbox recovery;
- state advance without outbox quarantine;
- duplicate invocation convergence and divergent invocation conflict;
- replacement `DELEGATE`, `DONE`, `ERROR`, and `ABORTED` routing;
- proof that stale requests are not archived before outbox inspection.

## 11. Glossary

### Core outbox

Core-owned immutable protocol result referenced by `state.json` before stdout
emission.

### Fixed core operation

Versioned shell-free entry point selected by trusted Runner configuration.

### Invocation intent

Immutable commitment of operation identity, executable policy, argv, working
directory, environment, and capture targets.

### Supervisor loss

Runner process disappearance that makes exit observation unavailable without
proving that the core failed.
