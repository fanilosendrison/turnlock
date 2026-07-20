---
okf_version: "1.0"
kind: "RuntimeArtifact"
format: "implementation-plan"
workspace: "turnlock"
date: "2026-07-21"
step_id: 0
id: "PLAN-TURNLOCK-DELEGATION-ATTEMPT-SPECIFICATION-RESTRUCTURING"
version: "0.1.0"
scope: "delegation-attempt-specification-restructuring"
status: "active"
---

# Turnlock Delegation Attempt Specification Restructuring Plan

## 1. Objective

Restructure the current mixed-delegation and runner drafts into a bounded,
coherent design corpus before producing normative implementation briefs.

The restructuring preserves the frozen architecture:

```text
Turnlock core
  -> commits a neutral delegation attempt

Turnlock Runner
  -> owns durable execution coordination

Harness adapter
  -> translates the committed execution intent

Workers
  -> publish unprivileged submissions

Current owner
  -> adopts, commits, joins, and resumes
```

The restructuring does not implement runtime behavior. It separates conception,
dependency contracts, normative construction briefs, and eventual public
consumer documentation.

## 2. Source Material

The extraction uses the following drafts as non-authoritative source material:

- [Turnlock Runners](consumers/TURNLOCK-RUNNERS.md)
- [Mixed Parallel Delegations](consumers/TURNLOCK-MIXED-PARALLEL-DELEGATIONS.md)

The frozen decisions from the architecture review supersede contradictory
content in those drafts.

## 3. Disposition of the Current Drafts

### 3.1 Mixed parallel delegations

`TURNLOCK-MIXED-PARALLEL-DELEGATIONS.md` is not incrementally corrected.
It still contains rejected contracts, including:

- a core-level `pendingWorkset`;
- a public `kind: "workset"`;
- harness-specific executors in the core manifest;
- worker-owned final result writes;
- `--resume-workset`;
- runner-owned retryability decisions;
- multiple host jobs;
- child scheduling owned by Turnlock.

It remains unchanged while its valid conceptual material is extracted. After
the replacement corpus is baselined, it becomes a short superseded record or
is removed, with Git history preserving the full draft.

### 3.2 Turnlock Runners

`TURNLOCK-RUNNERS.md` contains reusable mechanisms for protocol parsing,
handoff evidence, spool claiming, delivery deduplication, and recovery.
Its current yield vocabulary, bridge topology, and retry contracts are not the
new authority.

Its reusable concepts are revalidated and extracted into the generic Runner
CDD. The existing document is superseded only after the replacement corpus is
baselined.

## 4. Target Conception Corpus

### 4.1 CDD-O: delegation attempt execution

Path:
[CDD-O Turnlock Delegation Attempt Execution](design/cdd-o-turnlock-delegation-attempt-execution.md)

Role:

- define the end-to-end execution graph;
- define authority boundaries;
- define identity scopes;
- define the all-terminal barrier;
- define submission, adoption, outcome, retry, and resume semantics;
- define global failure and recovery invariants.

It excludes exact Zod schemas, exact filesystem algorithms, and Pi RPC calls.

### 4.2 CDD-I: Runner workset contract

Planned path:
`docs/design/cdd-i-turnlock-runner-workset-contract.md`

Role:

- define the harness-neutral Runner interface;
- define `WorksetRecord` semantics;
- define owner lease and transaction mutex semantics;
- define intake, fencing, submissions, immutable commits, and recovery;
- define generic artifact, digest, workspace, and resume contracts;
- retain only revalidated spool and handoff behavior.

It excludes Pi-specific agents, models, lifecycle states, and RPC operations.

### 4.3 CDD-S: Pi subagents execution

Planned path:
`docs/design/cdd-s-pi-subagents-execution.md`

Role:

- define the Pi strategy implementing the Runner interface;
- delegate child scheduling to pi-subagents;
- define the single-group topology;
- define resolved intent, runtime bindings, launches, and observations;
- define Pi artifact reconciliation and worker submission publication;
- define `fresh` context and cooperative read-only workspace behavior.

It excludes core state transitions and generic Runner rules already owned by
CDD-O and CDD-I.

## 5. Permanent Decisions to Extract as ADRs

The conception cycle produces ADRs for decisions whose rationale must outlive
the construction documents:

1. Worksets remain Runner-level while the core retains
   `pendingDelegation`.
2. The core retains neutral `prompt | batch` protocol shapes and per-job neutral
   targets.
3. pi-subagents owns child scheduling and lifecycle for the Pi strategy.
4. Version 1 permits one Pi group and at most one host job per attempt.
5. RFC 8785 canonical JSON is used before SHA-256 digesting.
6. The selected RFC 8785 and strict I-JSON implementation is an approved
   runtime dependency.

Package selection belongs to the dependency ADR, not to the CDD-O.

## 6. Dependency Contracts

After the CDD corpus is baselined, create bounded Dependency Contracts for:

- the exact pinned pi-subagents release and commit;
- its public RPC operations and reply shapes;
- its lifecycle artifacts and forward-compatibility rules;
- the selected strict I-JSON and RFC 8785 implementation.

Runtime startup performs a bounded protocol handshake. Full dependency contract
verification remains a CI responsibility.

## 7. Normative Construction Lot

The baselined CDD corpus is translated into a new NIB lot. The lot owns exact
schemas, algorithms, errors, constants, and test vectors.

### 7.1 Core scope

The core construction briefs cover:

- neutral per-job targets;
- manifest version 3;
- `delegationId` and `attemptId`;
- manifest and payload digests;
- `PendingDelegationRecord` evolution;
- strict `JobOutcomeEnvelope` validation;
- fatal outcome protocol violations;
- execution failure aggregation;
- retry resolution;
- successful payload unwrapping before lazy business validation.

### 7.2 Runner scope

The Runner construction briefs cover:

- owner lease;
- recoverable transaction mutex;
- `WorksetRecord` transitions;
- host tickets and submissions;
- worker submissions;
- intake closure;
- final outcome commit;
- all-terminal join;
- stale owner and stale attempt rejection;
- attempt selection followed by execution of the core-provided `resumeCmd`.

### 7.3 Pi strategy scope

The Pi construction briefs cover:

- RPC handshake and preflight;
- one static parallel group;
- profile input commitment;
- launch-specific runtime bindings;
- exactly one eligible launch;
- job-level execution observations;
- Pi raw output normalization;
- deadline stop and bounded reconciliation;
- tolerant parsing of version-compatible Pi artifacts.

### 7.4 Tests

The TDD brief covers observable behavior, including:

- invalid topology rejected before dispatch;
- crash windows before and after spawn acknowledgement;
- stale fencing tokens;
- late and divergent submissions;
- launch supersession;
- workspace drift;
- malformed or foreign outcomes;
- multiple execution failures and deterministic aggregation;
- duplicate resume attempts;
- deadline closure with running or paused Pi jobs.

## 8. Authority Boundaries

The corpus preserves one authority per concern:

- `state.json`: Turnlock workflow progression;
- `WorksetRecord`: Runner execution coordination;
- Pi lifecycle artifacts: child technical lifecycle;
- submission artifacts: unprivileged result proposals;
- final outcome files: committed Runner-to-core handoff;
- code and tests: source of truth after construction completes.

No document may assign the same mutable state transition to two layers.

## 9. Work Sequence

1. Extract and review CDD-O.
2. Extract and review CDD-I.
3. Extract and review CDD-S.
4. Run a cross-document hostile review of the three-document conception lot.
5. Resolve all decisional findings and baseline the CDDs.
6. Extract the ADRs.
7. Select and document dependencies.
8. Produce Dependency Contracts.
9. Produce the NIB-S, NIB-M, and NIB-T extension lot.
10. Run claim verification and a fresh blind-spot sweep.
11. Supersede the two current drafts.
12. Implement through the RED then GREEN construction sequence.
13. Replace construction documents with maintained public consumer
    documentation derived from code and tests.

## 10. Current Authorized Increment

This increment creates only:

- this restructuring plan;
- the CDD-O for delegation attempt execution.

It does not:

- modify either current draft;
- modify approved NIBs;
- select a canonical JSON package;
- create the CDD-I or CDD-S;
- implement runtime or Runner code.

## 11. Acceptance Criteria

This increment is complete when:

- both new files carry valid OKF metadata;
- the CDD-O follows the required CDD anatomy;
- the CDD-O contains no rejected `pendingWorkset`, `kind: "workset"`, or
  `--resume-workset` contract;
- the core remains host-neutral;
- the Runner-level workset boundary is explicit;
- the Pi strategy is referenced but not mechanically specified;
- every frozen invariant has a unique conceptual owner;
- Markdown formatting and repository links validate;
- no existing specification or source file is modified.

## 12. Risks and Controls

### 12.1 Stale draft leakage

Risk: obsolete examples are copied into the new corpus.

Control: frozen decisions override draft text, and the extraction is reviewed
against an explicit rejected-contract checklist.

### 12.2 Cross-layer duplication

Risk: both core and Runner claim ownership of join or execution state.

Control: CDD-O defines scoped authorities and the later CDD-I cannot redefine
core behavior.

### 12.3 Pi coupling in generic contracts

Risk: agent names, models, RPC events, or Pi status fields leak into the core or
generic Runner interface.

Control: all Pi mechanics are delegated to CDD-S and its Dependency Contract.

### 12.4 False reproducibility claims

Risk: runtime observations or launch bindings enter the pre-dispatch spec hash.

Control: committed intent, runtime bindings, and execution observations remain
separate artifacts.

### 12.5 Specification drift during construction

Risk: implementation starts before the design corpus is coherent.

Control: no NIB or implementation work begins until the three CDDs pass the
hostile review and are baselined.
