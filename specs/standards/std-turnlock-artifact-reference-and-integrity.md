---
okf_version: "1.0"
kind: "KnowledgeAsset"
asset_type: "standard"
domain: "turnlock-artifact-integrity"
severity: "strict"
name: "Turnlock Artifact Reference and Integrity Standard"
id: "STD-TURNLOCK-ARTIFACT-REFERENCE-AND-INTEGRITY"
version: "0.3.0"
---

# Turnlock Artifact Reference and Integrity Standard

## 1. Scope

Apply this standard whenever a Turnlock core, Runner, strategy, dependency,
process, or recovery operation persists or exchanges an artifact location.

This standard is authoritative for:

- portable artifact reference forms;
- core-owned and Runner-owned artifact roots;
- write-once output targets;
- separation of location from content integrity;
- confinement and safe-open behavior;
- publication ordering;
- immutable artifact verification;
- retention and cleanup safety.

Use
[STD-TURNLOCK-CANONICAL-JSON-AND-DIGEST](std-turnlock-canonical-json-and-digest.md)
for semantic JSON digests.

## 2. Reference contracts

Represent portable artifact locations as:

```typescript
interface RunnerRelativeArtifactRefV2 {
  readonly kind: "runner-relative";
  readonly path: string;
}

interface TurnlockRunRelativeArtifactRefV2 {
  readonly kind: "turnlock-run-relative";
  readonly turnlockRunId: string;
  readonly path: string;
}

interface ContentAddressedArtifactRefV2 {
  readonly kind: "content-addressed";
  readonly digest: `sha256:${string}`;
}

type ArtifactRefV2 =
  | RunnerRelativeArtifactRefV2
  | TurnlockRunRelativeArtifactRefV2
  | ContentAddressedArtifactRefV2;
```

Use `runner-relative` for Runner-owned artifacts. Use
`turnlock-run-relative` for manifests, result envelopes, attempt-terminal
artifacts, resume outbox artifacts, and other locations allocated under one
core-owned run directory. Use `content-addressed` only when both parties are
configured to resolve the same immutable store.

Do not persist an absolute host path as a portable reference. An absolute path
may exist only in a validated runtime root binding.

## 3. Write-once target contracts

A location allocated before bytes exist is a target, not an artifact
commitment:

```typescript
interface ArtifactTargetRefV1 {
  readonly version: 1;
  readonly ref:
    | RunnerRelativeArtifactRefV2
    | TurnlockRunRelativeArtifactRefV2;
  readonly allocationId: string;
  readonly purpose:
    | "manifest"
    | "core-job-result"
    | "attempt-terminal"
    | "resume-outbox"
    | "host-staging"
    | "submission"
    | "strategy-state"
    | "strategy-raw-result"
    | "process-capture"
    | "delivery-event"
    | "diagnostic";
}
```

Require `allocationId` to be a canonical 26-character uppercase ULID generated
by the allocating authority. Derive `allocationId`, `purpose`, and location
before delegating write authority. Exclude content-addressed
references from target allocation because their location depends on bytes that
do not yet exist.

Treat every target as write-once. Publication of identical bytes converges;
publication of different bytes at an occupied target is an integrity conflict.
Do not delete or overwrite an occupied target to make a retry succeed.

The Turnlock core alone allocates core-run targets. The Runner alone allocates
Runner targets. Workers and host sessions receive neither final result targets
nor attempt-terminal targets as write authority.

## 4. Content commitments

Represent an authoritative dependency on artifact content as:

```typescript
interface ArtifactCommitmentV2 {
  readonly ref: ArtifactRefV2;
  readonly contentDigest: `sha256:${string}`;
}
```

Require each digest string to contain exactly 64 lowercase hexadecimal
characters after the `sha256:` prefix.

Treat a reference as a locator, not as proof of content. Whenever artifact
content can influence a stable transition, terminal result, resume decision,
or recovery decision, persist an `ArtifactCommitmentV2` before that transition
becomes authoritative.

For a content-addressed reference, require `ref.digest` and `contentDigest` to
be equal. For a relative reference, always verify `contentDigest` after a safe
open and bounded read.

A JSON artifact may additionally carry a semantic payload digest governed by
the canonical JSON standard. The artifact content digest commits exact stored
octets; the payload digest commits the validated semantic JSON value. Do not
substitute one meaning for the other.

## 5. Trusted root bindings

Resolve every relative reference through one validated runtime binding:

```typescript
interface ArtifactRootBindingV1 {
  readonly version: 1;
  readonly rootKind: "runner" | "turnlock-run";
  readonly logicalRootId: string;
  readonly absolutePath: string;
}
```

Treat `absolutePath` as process-local data. Never persist it as portable
artifact identity or accept it from a host, worker, model output, or arbitrary
protocol field.

For a Runner root, derive `logicalRootId` from the validated Runner
configuration commitment. For a Turnlock run root, require `logicalRootId` to
be the exact `turnlockRunId` and establish the binding by cross-checking the
invoked core, the configured Turnlock run-root policy, and authoritative core
state.

Reject a `turnlock-run-relative` reference when:

- its `turnlockRunId` differs from the bound run;
- no trusted root binding exists;
- the core state does not authorize the referenced attempt or allocation;
- the reference resolves outside the bound run root;
- its purpose conflicts with the core allocation record.

A Runner must not infer a core root by truncating an absolute path received in
a protocol result.

## 6. Relative path validation

Require every persisted relative path to satisfy all of these conditions:

- it contains no empty, current-directory, or parent-directory segment;
- it contains no absolute root, drive prefix, UNC prefix, NUL byte, or alternate
  platform separator;
- it uses the standard forward slash as its persisted separator;
- its encoded length, segment count, and individual segment lengths are bounded
  by the resource policy;
- it resolves beneath the selected trusted root after platform normalization;
- it is produced by the authority that owns that root.

Reject platform-dependent aliases and case-colliding allocations on a
case-insensitive supported filesystem.

## 7. Safe resolution, opening, and publication

Resolve references from an already trusted open root where the supported
platform permits it. Refuse symbolic links while traversing and opening the
target. Verify the opened object rather than trusting a path check performed
before opening.

Require a read operation to:

1. validate the persisted reference syntax;
2. select and validate the exact root binding;
3. resolve beneath that root;
4. open without following symbolic links;
5. verify the opened object type and identity;
6. reject directories, devices, sockets, and other unexpected file types;
7. enforce the applicable byte limit while reading;
8. recompute the exact content digest;
9. compare it with the committed digest before semantic use.

Require a write-once publication to:

1. validate the target and allocating authority;
2. construct bounded bytes in the destination filesystem;
3. write a private temporary regular file;
4. flush bytes and required directory metadata under the environment contract;
5. verify the exact byte digest;
6. publish without following links or replacing divergent existing bytes;
7. reopen and verify the published object;
8. produce the content commitment;
9. commit the authoritative snapshot that selects that commitment.

A pre-open `realpath` check alone is insufficient because it leaves a
check-to-use race. Treat platforms that cannot provide equivalent no-follow,
post-open identity, exclusive publication, and durability guarantees as
unsupported.

## 8. Content-addressed references

Resolve content-addressed references only through one configured shared
artifact store. Derive storage location from the complete digest through a
closed rule; never accept a producer-supplied path alongside the digest.

After opening the candidate, recompute its exact byte digest. Do not trust the
store key or filename as proof that bytes match the reference.

Different bytes under one content digest are an integrity violation. Missing
content is not equivalent to an empty artifact and must fail closed.

## 9. Publication ordering and authority

Publish an immutable artifact before any authoritative snapshot references its
commitment:

```text
construct bounded artifact bytes
  -> publish and verify immutable artifact
  -> commit authoritative snapshot with ArtifactCommitment
```

A crash before immutable publication leaves no committed artifact. A crash
after publication but before snapshot advancement leaves an unreferenced
candidate. Recovery may adopt that candidate only through an explicit owning
contract with exact identity and predecessor checks.

Resolve references from authoritative records, not from host, worker, model, or
ambient directory discovery. If committed bytes change, disappear, or fail
safe-open validation:

- stop the transition that needs them;
- preserve bounded diagnostic evidence when safe;
- classify the condition through the owning contract;
- never refresh the commitment silently;
- never search nearby paths for a plausible replacement.

Treat an integrity failure as an authority or protocol problem when identity
can no longer be trusted. Do not normalize it into an ordinary worker result.

## 10. Retention and cleanup

Retain every artifact while an authoritative snapshot, pending delivery,
quarantine record, resume proof, operator-abort proof, or diagnostic retention
rule references it.

Make cleanup reference-aware and idempotent. Revalidate current authority before
deleting. Never infer safety from age, process ID, or an event stream alone.

Unreferenced temporary, candidate, and conflict artifacts may be collected only
through the bounded resource policy and while holding the owning component's
recoverable cleanup coordination.

## 11. Versioning and conformance

Treat changes to reference kinds, path interpretation, root binding, target
allocation, digest meaning, publication ordering, or safe-open guarantees as
breaking contract changes.

Require tests for:

- parent traversal and current-directory segments;
- absolute, drive-prefixed, UNC, alternate-separator, and NUL paths;
- wrong Turnlock run identity or root binding;
- purpose and allocation mismatch;
- case-colliding targets;
- symlink substitution at every path level;
- post-open replacement races;
- unexpected file types;
- oversized and truncated reads;
- missing content and digest mismatch;
- crash before and after immutable publication;
- identical and divergent duplicate publication;
- unreferenced candidate recovery;
- cleanup racing a referenced artifact.

## 12. Consumers

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
