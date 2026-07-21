---
okf_version: "1.0"
kind: "RuntimeArtifact"
format: "implementation-plan"
workspace: "turnlock"
date: "2026-07-21"
step_id: 0
id: "PLAN-TURNLOCK-DELEGATION-ATTEMPT-SPECIFICATION-RESTRUCTURING"
version: "0.4.0"
scope: "delegation-attempt-specification-restructuring"
status: "active"
---

# Turnlock Delegation Attempt Specification Restructuring Plan

## 1. Objective

Restructure the delegation-attempt conception corpus into a valid CDD DAG,
close the authority and recovery gaps found by active audit, and prevent NIB or
runtime construction before external dependencies are mechanically proven.

The target architecture remains:

```text
Turnlock core
  -> commits one neutral delegation attempt and resume outbox contract

Turnlock Runner orchestration
  -> owns durable workset coordination and terminal selection

Host intake and external execution strategy
  -> publish unprivileged submissions

Current Runner owner
  -> adopts, commits, joins, and starts fixed core resume

Turnlock core
  -> validates, classifies, retries, or resumes the FSM
```

## 2. Source Material

The restructuring preserves valid requirements from:

- [Turnlock Runners](consumers/TURNLOCK-RUNNERS.md);
- [Mixed Parallel Delegations](consumers/TURNLOCK-MIXED-PARALLEL-DELEGATIONS.md);
- [Pi Subagents Normative Draft](consumers/TURNLOCK-PI-SUBAGENTS-NORMATIVE-SPEC.md);
- the active hostile-audit findings resolved on 2026-07-21.

The consumer drafts remain non-authoritative and unchanged until the replacement
corpus is baselined.

## 3. Resolved Design Decisions

The correction increment selects:

1. a Runner CDD-O with child CDD-Ns instead of a broad operational CDD-I;
2. a narrow external-execution CDD-I implemented by harness strategies;
3. a maintained pi-subagents fork API rather than a Turnlock broker around an
   uncorrelatable dependency;
4. typed Turnlock-run-relative targets instead of absolute path strings;
5. a fixed structured core resume API with a core-owned durable outbox;
6. immutable strategy-state candidates selected only by `WorksetRecord`;
7. discriminated outcome provenance instead of universal fictional execution
   evidence;
8. a permanent Runner coordination standard;
9. core-owned operator abandonment for quarantine, with read-only Runner
   inspection;
10. permanent environment and resource-policy standards;
11. a breaking manifest-v2 drain gate instead of in-place suspended-attempt
    conversion.

These decisions are candidates for permanent ADR extraction after the corrected
corpus passes hostile review. The rationale remains in session and audit history
until then.

## 4. Target Corpus

```text
specs/
├── dependencies/
│   ├── dc-pi-subagents.md
│   ├── dc-jsonc-parser.md
│   └── dc-canonicalize.md
├── standards/
│   ├── std-turnlock-artifact-reference-and-integrity.md
│   ├── std-turnlock-canonical-json-and-digest.md
│   ├── std-turnlock-delegation-execution-environment.md
│   ├── std-turnlock-delegation-resource-policy.md
│   ├── std-turnlock-runner-coordination.md
│   └── std-turnlock-workspace-input-commitment.md
└── working/
    └── delegation-attempt/
        ├── cdd-o-turnlock-delegation-attempt-execution.md
        ├── runner/
        │   ├── cdd-o-turnlock-runner-execution.md
        │   ├── cdd-n-turnlock-attempt-admission-and-handoff.md
        │   ├── cdd-n-turnlock-workset-preparation.md
        │   ├── cdd-n-turnlock-host-intake.md
        │   ├── cdd-n-turnlock-outcome-and-terminal-coordination.md
        │   ├── cdd-n-turnlock-terminal-resume.md
        │   ├── cdd-n-turnlock-quarantine-disposition.md
        │   ├── cdd-n-turnlock-delivery-bridge.md
        │   ├── cdd-n-turnlock-workset-cleanup.md
        │   └── cdd-i-turnlock-external-execution-strategy.md
        └── strategies/
            └── pi-subagents/
                └── cdd-s-pi-subagents-execution.md
```

### 4.1 Umbrella delegation CDD-O

[CDD-O Turnlock Delegation Attempt Execution](../specs/working/delegation-attempt/cdd-o-turnlock-delegation-attempt-execution.md)
owns end-to-end topology, core authority, identity hierarchy, terminal envelopes,
failure classification, retry, operator abort, and manifest migration.

### 4.2 Runner CDD-O and nodes

[CDD-O Turnlock Runner Execution](../specs/working/delegation-attempt/runner/cdd-o-turnlock-runner-execution.md)
owns `WorksetRecord`, the Runner DAG, owner fencing, strategy-state selection,
and terminal-route coordination.

Child CDD-Ns own strict admission, preparation, host intake, outcomes, terminal
resume, quarantine disposition, delivery, and cleanup pipelines. Each node has
one bounded input/output role and does not hide further delegation.

### 4.3 External execution interface and Pi strategy

[CDD-I Turnlock External Execution Strategy](../specs/working/delegation-attempt/runner/cdd-i-turnlock-external-execution-strategy.md)
owns only worker preflight, commitments, state candidates, launch observation,
submission proposals, stop, and reconciliation.

[CDD-S Pi Subagents Execution](../specs/working/delegation-attempt/strategies/pi-subagents/cdd-s-pi-subagents-execution.md)
implements that worker subset. It does not implement admission, Runner ownership,
outcome adoption, terminal selection, resume, or delivery.

## 5. Permanent Standards

### Artifact references

[Artifact Reference and Integrity](../specs/standards/std-turnlock-artifact-reference-and-integrity.md)
now distinguishes Runner-relative, Turnlock-run-relative, and content-addressed
references. Core output allocations use typed write-once targets and become
content commitments only after publication.

### Canonical data

[Canonical JSON and Digest](../specs/standards/std-turnlock-canonical-json-and-digest.md)
owns strict JSON-domain, RFC 8785, SHA-256, and domain separation. Its exact
implementation pair is pinned by
[DC jsonc-parser](../specs/dependencies/dc-jsonc-parser.md) and
[DC canonicalize](../specs/dependencies/dc-canonicalize.md).

### Coordination

[Runner Coordination](../specs/standards/std-turnlock-runner-coordination.md)
owns process-instance identity, PID reuse, owner lease, mutex, clock anomaly,
takeover, delivery sequence, and claim recovery.

### Environment and resources

[Delegation Execution Environment](../specs/standards/std-turnlock-delegation-execution-environment.md)
defines the exact certified platform, runtime, filesystem, process, network, and
provider profile.

[Delegation Resource Policy](../specs/standards/std-turnlock-delegation-resource-policy.md)
defines complete defaults, allowed bounds, timing relations, size limits,
deadline reserves, and retention endpoints.

### Workspace

[Workspace Input Commitment](../specs/standards/std-turnlock-workspace-input-commitment.md)
remains authoritative for Git input membership, drift checks, and cooperative
read-only overlap.

## 6. Dependency Gates

### 6.1 pi-subagents

[DC pi-subagents](../specs/dependencies/dc-pi-subagents.md) pins the actually
inspected fork version and commit and records an incompatible verdict. This
closes the prior unverified assumption without pretending that the required API
already exists.

The fork must ship a versioned public integration API providing:

- caller-committed launch key and request digest;
- idempotent equal launch and divergent conflict;
- durable acknowledgement before success reply;
- restart-safe inspect and stop by caller key;
- strict non-destructive per-job results;
- explicit digest-scoped retention acknowledgement.

After implementation and conformance tests exist, a new Dependency Contract
supersedes the negative contract. The Pi CDD-S cannot baseline before that
superseding contract reports compatibility.

### 6.2 Strict JSON and RFC 8785

The selected dependency pair is `jsonc-parser` 3.3.1 and `canonicalize` 3.0.0,
with native fatal UTF-8 and SHA-256. A runtime-dependency ADR remains mandatory
before construction changes `package.json`.

## 7. Core Construction Consequences

The future core NIB lot must cover:

- protocol version 3, manifest version 3, and neutral per-job targets;
- stable delegation and attempt identities;
- typed Turnlock-run-relative target allocation;
- manifest, policy, environment, workspace, and resume-operation commitments;
- outcome provenance and attempt-terminal envelopes;
- no-failure success reduction before retry resolution;
- core resume outbox publication before `state.json` advancement;
- fixed `resume-delegation-attempt` and
  `inspect-or-reemit-current-result` operations;
- authenticated state-digest-fenced operator abort;
- manifest-v2 admission closure, inventory, drain, and refusal gates.

Existing historical NIBs remain unchanged.

## 8. Runner Construction Consequences

The future Runner NIB lot must cover:

- deterministic attempt namespace;
- admitted and prepared workset states;
- owner lease and process-instance fencing;
- recoverable transaction mutex;
- complete workset preparation before side effects;
- immutable strategy-state candidate selection;
- host ticket and submission publication;
- source-specific outcome provenance;
- terminal cause, partial outcomes, join, rejection, and quarantine;
- typed core-target publication;
- structured direct process invocation and bounded capture;
- outbox inspection before stale-request archival;
- delivery sequence and claim recovery;
- signed core operator-abort proof consumption;
- deterministic reference-set derivation;
- dependency retention acknowledgement;
- reference-aware retention and cleanup.

## 9. Work Sequence

1. Keep all corrected CDDs and new standards at `draft` or pre-baseline version.
2. Run link, metadata, Markdown, and corpus-claim validation.
3. Evolve the pi-subagents fork through its own RED/GREEN construction process.
4. Publish and pin the compatible fork release.
5. Replace the negative pi-subagents contract with a compatible superseding
   Dependency Contract.
6. Extract the runtime-dependency and architecture ADRs.
7. Run a fresh hostile review across CDDs, standards, Dependency Contracts, and
   current core code.
8. Resolve every remaining finding.
9. Baseline the conception corpus.
10. Generate new NIB-S, NIB-M, and NIB-T construction documents.
11. Implement tests RED, then production code GREEN.
12. Drain protocol-v2 and manifest-v2 pending attempts under the migration
    gate.
13. Activate protocol and manifest version 3 only after the zero-pending proof.
14. Supersede the old consumer drafts and transition construction documents.

## 10. Acceptance Criteria

This restructuring increment is complete when:

- every CDD has the exact typology-specific 11-header structure;
- all links resolve after domain hierarchy migration;
- the Runner interface contains no admission, coordination, resume, or delivery
  pipeline;
- every durable I/O boundary belongs to the Runner CDD-O or one CDD-N;
- no portable cross-boundary path remains an untyped string;
- no resume contract contains an arbitrary command string;
- strategy state has one authoritative selector;
- every outcome route has representable provenance;
- lease, mutex, process, clock, claim, and sequence behavior has a permanent
  oracle;
- quarantine has inspection, alert, core disposition, retention, and cleanup
  endpoints;
- all behavior-affecting limits and environment assumptions are closed;
- protocol-v2 and manifest-v2 pending state has a mechanical refusal and drain
  path;
- the all-success vector bypasses the retry resolver;
- the current incompatible pi-subagents dependency is never presented as
  dispatch-capable;
- no existing historical NIB or runtime source file is modified.

Baseline remains separately blocked until the compatible pi-subagents release,
its superseding contract, required ADRs, and a zero-finding hostile review exist.

## 11. Risks and Controls

### Dependency remains unavailable

Risk: the Pi strategy cannot dispatch immediately after document correction.

Control: fail preflight before side effects. Dependency unavailability is safer
than an unprovable uncertain-spawn recovery path.

### Corpus fragmentation

Risk: child documents drift or duplicate authority.

Control: the umbrella CDD-O owns end-to-end laws, the Runner CDD-O owns workset
state, and each node references rather than redefines parent contracts.

### Standards become implementation documents

Risk: permanent laws contain package or low-level module choices.

Control: standards own cross-boundary behavior; Dependency Contracts pin
packages; future NIBs own exact module signatures and algorithms.

### Breaking migration races

Risk: an old controller creates a new v2 attempt during upgrade inventory.

Control: close v2 admission and hold the upgrade lock before inventory, drain,
recheck, and v3 activation.

### False completion

Risk: document correction is mistaken for dependency or runtime implementation.

Control: all CDDs remain draft, the current pi-subagents contract remains
incompatible, and construction cannot begin before the explicit gates pass.
