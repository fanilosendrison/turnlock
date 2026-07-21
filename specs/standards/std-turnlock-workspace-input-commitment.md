---
okf_version: "1.0"
kind: "KnowledgeAsset"
asset_type: "standard"
domain: "turnlock-workspace-integrity"
severity: "strict"
name: "Turnlock Workspace Input Commitment Standard"
id: "STD-TURNLOCK-WORKSPACE-INPUT-COMMITMENT"
version: "0.1.0"
---

# Turnlock Workspace Input Commitment Standard

## 1. Scope

Apply this standard whenever concurrent or recoverable Turnlock execution reads
a shared Git workspace whose committed inputs must remain stable for one
attempt.

This standard is authoritative for:

- the closed workspace input policy;
- the semantic subject of workspace policy and manifest digests;
- required Git and filesystem inputs;
- drift verification boundaries;
- the distinction between drift detection and snapshot isolation;
- the terminal response to trustworthy drift.

Use
[STD-TURNLOCK-CANONICAL-JSON-AND-DIGEST](std-turnlock-canonical-json-and-digest.md)
for policy and manifest digests. Use
[STD-TURNLOCK-ARTIFACT-REFERENCE-AND-INTEGRITY](std-turnlock-artifact-reference-and-integrity.md)
for any persisted manifest artifact.

## 2. Workspace contracts

Represent the closed policy as:

```typescript
interface WorkspaceInputPolicyV1 {
  readonly version: 1;
  readonly includeRoots: readonly string[];
  readonly excludedPatterns: readonly string[];
  readonly includeUntracked: boolean;
  readonly includeIgnored: boolean;
  readonly includeSubmodules: boolean;
}
```

Represent the committed attempt input as:

```typescript
interface WorkspaceInputCommitmentV1 {
  readonly version: 1;
  readonly logicalWorkspaceId: string;
  readonly relativeWorkingDirectory: string;
  readonly policy: WorkspaceInputPolicyV1;
  readonly policyDigest: PayloadDigestV1;
  readonly manifestDigest: PayloadDigestV1;
}
```

Require `policyDigest` to use the `turnlock:workspace-policy` domain and
`manifestDigest` to use the `turnlock:workspace-manifest` domain from the
canonical JSON standard.

Treat the resolved absolute workspace path as a runtime binding. Do not include
machine-local absolute paths in the portable workspace commitment.

## 3. Closed policy requirements

Resolve every included root and exclusion from validated configuration before
external dispatch. Do not accept an undefined category such as "relevant
files" or an executor-selected path.

Require the policy to determine:

- which logical roots participate;
- how exclusions are matched;
- whether untracked files participate;
- whether ignored files can participate;
- whether submodule state participates;
- which dedicated Runner staging namespace is excluded;
- how path identities and ordering are represented deterministically.

Normalize and validate policy paths before digesting them. Reject roots or
patterns that escape the logical workspace, overlap the Runner control root
unsafely, or produce platform-dependent membership.

Changing policy membership creates a different commitment and therefore a
different attempt input.

## 4. Git workspace manifest subject

Construct the version 1 workspace manifest from official Git primitives and
bounded filesystem reads. Do not implement a project-local parser for Git index
or object formats when official Git can provide the required facts.

According to the committed policy, include all of the following semantic facts:

- the repository HEAD object ID, or an explicit unborn-HEAD marker;
- every Git index entry, including its path, stage, mode, and object ID;
- the current content of tracked working-tree files that differ from the index;
- each included untracked file and its current content;
- each included ignored file when `includeIgnored` is true;
- executable mode information relevant to checkout semantics;
- symbolic-link targets rather than dereferenced target content;
- the superproject gitlink object ID for each included submodule;
- the checked-out submodule HEAD object ID required by the selected submodule
  policy;
- the versioned inclusion and exclusion policy itself by its policy digest.

Represent path identity losslessly and order manifest entries deterministically.
Do not use locale-dependent ordering, filesystem discovery order, or human Git
formatting as semantic identity.

Reject unresolved index conflicts, unreadable selected inputs, unsupported file
types, path escapes, and ambiguous submodule state unless a later versioned
policy defines their exact semantics.

## 5. Commitment production

Produce the workspace commitment through this conceptual sequence:

```text
validate logical workspace and relative working directory
  -> close and canonicalize WorkspaceInputPolicyV1
  -> calculate policyDigest
  -> enumerate required Git and filesystem facts
  -> build deterministic workspace manifest
  -> calculate manifestDigest
  -> commit WorkspaceInputCommitmentV1 before dispatch
```

Keep Runner control, staging, raw output, submission, and temporary namespaces
outside included roots or inside one explicit exclusion committed by the policy.
This prevents Runner writes from invalidating their own input commitment.

## 6. Required verification boundaries

Recompute and compare the commitment at all three boundaries:

1. immediately before external dispatch;
2. immediately before submission publication or adoption;
3. immediately before final attempt terminal commitment.

At each boundary, compare logical workspace identity, relative working
directory, policy digest, and manifest digest. Do not compare only a subset.

The final boundary applies before either an all-terminal join or a successful
attempt terminal record becomes authoritative. Once a terminal record is
committed, later workspace mutations do not retroactively alter that attempt.

## 7. Drift response

When recomputation differs and core, attempt, workset, and manifest identities
remain trustworthy, apply the following response unless a validated
`cancelled-by-user` intake closure already fixed an abort route:

- stop the operation at the detecting boundary;
- do not refresh the workspace commitment under the same attempt;
- close intake before requesting external stop when intake was open;
- atomically select a fenced `configuration-drift` attempt rejection in the
  authoritative workset;
- preserve already committed outcomes as audit evidence without consuming them
  as a successful terminal result;
- publish the already selected terminal envelope at the core-defined path;
- resume the core through the committed attempt-rejection path;
- let the core apply the permanent classification and retry policy.

A previously committed user-cancellation closure retains the abort route because
no successful payload can advance the workflow; record later drift as diagnostic
evidence. When corruption or authority ambiguity prevents trustworthy
attribution to the current attempt, quarantine instead. Do not fabricate a drift
rejection from an untrusted identity.

## 8. Concurrency semantics and limitations

Treat the commitment as a drift detector, not as an immutable filesystem
snapshot. It proves that selected facts matched at each verification boundary;
it does not prove that every reader observed the same bytes at one instant.

Require every participant that overlaps in wall-clock execution to be
cooperatively read-only for included workspace inputs. Schedule mutations in a
later Turnlock phase after terminal coordination.

Do not claim adversarial read-only enforcement when same-user workers retain
arbitrary shell access. Strong isolation requires a separate user, sandbox,
read-only mount, or privileged broker outside this version of the standard.

## 9. Recovery

On recovery, load the committed policy and manifest digest from authoritative
Runner state. Recompute at the next required boundary instead of adopting
ambient current state as the original input.

A replacement external launch within the same attempt is permitted only when
the workspace commitment and every other committed resolver input still match.
A changed workspace requires a new Turnlock attempt.

Do not reconstruct workspace authority from audit events or external worker
observations.

## 10. Versioning and conformance tests

Treat any change to policy fields, included Git facts, path identity,
submodule treatment, exclusion semantics, or drift boundaries as a versioned
standard change.

Require tests for:

- HEAD-only changes;
- staged index changes and non-zero-stage conflict entries;
- tracked working-tree modifications;
- included and excluded untracked files;
- included and excluded ignored files;
- executable mode changes;
- symbolic-link target changes;
- submodule gitlink and checked-out HEAD changes;
- deterministic ordering across filesystem discovery permutations;
- Runner staging exclusion;
- drift at each of the three required boundaries;
- drift after some outcomes exist but before terminal commitment;
- recovery without refreshing the attempt commitment;
- corruption that requires quarantine rather than drift rejection.

## 11. Consumers

The following conception documents consume this standard without redefining
it:

- [CDD-O Turnlock Delegation Attempt Execution](../working/delegation-attempt/cdd-o-turnlock-delegation-attempt-execution.md);
- [CDD-O Turnlock Runner Execution](../working/delegation-attempt/runner/cdd-o-turnlock-runner-execution.md);
- [CDD-N Attempt Admission and Handoff](../working/delegation-attempt/runner/cdd-n-turnlock-attempt-admission-and-handoff.md);
- [CDD-N Workset Preparation](../working/delegation-attempt/runner/cdd-n-turnlock-workset-preparation.md);
- [CDD-N Host Intake](../working/delegation-attempt/runner/cdd-n-turnlock-host-intake.md);
- [CDD-N Outcome and Terminal Coordination](../working/delegation-attempt/runner/cdd-n-turnlock-outcome-and-terminal-coordination.md);
- [CDD-N Terminal Resume](../working/delegation-attempt/runner/cdd-n-turnlock-terminal-resume.md);
- [CDD-N Quarantine Disposition](../working/delegation-attempt/runner/cdd-n-turnlock-quarantine-disposition.md);
- [CDD-N Delivery Bridge](../working/delegation-attempt/runner/cdd-n-turnlock-delivery-bridge.md);
- [CDD-N Workset Cleanup](../working/delegation-attempt/runner/cdd-n-turnlock-workset-cleanup.md);
- [CDD-I Turnlock External Execution Strategy](../working/delegation-attempt/runner/cdd-i-turnlock-external-execution-strategy.md);
- [CDD-S Pi Subagents Execution](../working/delegation-attempt/strategies/pi-subagents/cdd-s-pi-subagents-execution.md).
