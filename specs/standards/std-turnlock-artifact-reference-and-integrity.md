---
okf_version: "1.0"
kind: "KnowledgeAsset"
asset_type: "standard"
domain: "turnlock-artifact-integrity"
severity: "strict"
name: "Turnlock Artifact Reference and Integrity Standard"
id: "STD-TURNLOCK-ARTIFACT-REFERENCE-AND-INTEGRITY"
version: "0.1.0"
---

# Turnlock Artifact Reference and Integrity Standard

## 1. Scope

Apply this standard whenever a Turnlock core, Runner, strategy, dependency,
process, or recovery operation persists or exchanges a reference to an
artifact.

This standard is authoritative for:

- portable artifact reference forms;
- separation of location from content integrity;
- confinement and safe-open behavior;
- publication ordering;
- immutable artifact verification;
- retention and cleanup safety.

Use
[STD-TURNLOCK-CANONICAL-JSON-AND-DIGEST](std-turnlock-canonical-json-and-digest.md)
for semantic JSON digests.

## 2. Reference and commitment contracts

Represent portable artifact locations as:

```typescript
type ArtifactRefV1 =
  | {
      readonly kind: "runner-relative";
      readonly path: string;
    }
  | {
      readonly kind: "content-addressed";
      readonly digest: `sha256:${string}`;
    };
```

Represent an authoritative dependency on artifact content as:

```typescript
interface ArtifactCommitmentV1 {
  readonly ref: ArtifactRefV1;
  readonly contentDigest: `sha256:${string}`;
}
```

Require each digest string to contain exactly 64 lowercase hexadecimal
characters after the `sha256:` prefix.

Treat a reference as a locator, not as proof of content. Whenever artifact
content can influence a stable transition, terminal result, resume decision,
or recovery decision, persist an `ArtifactCommitmentV1` before that transition
becomes authoritative.

For a content-addressed reference, require `ref.digest` and `contentDigest` to
be equal. For a Runner-relative reference, always verify `contentDigest` after a
safe open and bounded read.

A JSON artifact may additionally carry a semantic payload digest governed by
the canonical JSON standard. The artifact content digest commits exact stored
octets; the payload digest commits the validated semantic JSON value. Do not
substitute one meaning for the other.

## 3. Runner-relative references

Require a Runner-relative path to satisfy all of these conditions:

- it is relative to one configured Runner artifact root;
- it contains no empty, current-directory, or parent-directory segment;
- it contains no absolute root, drive prefix, UNC prefix, NUL byte, or alternate
  platform separator;
- it uses the standard forward slash as its persisted separator;
- its complete encoded length and segment count are bounded;
- it resolves beneath the same Runner root after platform normalization;
- it is produced by a Runner-owned allocation rule rather than accepted as
  command-line path authority from a host or worker.

Do not persist an absolute host path as a portable artifact reference. An
absolute path may exist only as a runtime binding that never serves as durable
cross-boundary identity.

## 4. Safe resolution and opening

Resolve untrusted references from an already trusted Runner root. Refuse
symbolic links while traversing and opening the target. Verify the opened object
rather than trusting a path check performed before opening.

Require the read operation to:

1. validate the persisted reference syntax;
2. resolve beneath the configured root;
3. open without following symbolic links;
4. verify the opened object type and identity;
5. reject directories, devices, sockets, and other unexpected file types;
6. enforce the applicable byte limit while reading;
7. recompute the exact content digest;
8. compare it with the committed digest before semantic use.

Treat platforms that cannot provide equivalent no-follow and post-open identity
checks as unsupported for untrusted Runner-relative artifacts.

A pre-open `realpath` check alone is insufficient because it leaves a time-of-
check/time-of-use race.

## 5. Content-addressed references

Resolve content-addressed references only through one configured Runner artifact
store. Derive storage location from the complete digest through a closed Runner
rule; never accept a producer-supplied path alongside the digest.

After opening the candidate, recompute its exact byte digest. Do not trust the
store key or filename as proof that bytes match the reference.

Different bytes under one content digest are an integrity violation. Missing
content is not equivalent to an empty artifact and must fail closed.

## 6. Publication ordering

Publish an immutable artifact before any authoritative snapshot references its
commitment.

The stable ordering is:

```text
construct bounded artifact bytes
  -> write temporary artifact
  -> validate exact byte digest
  -> durably publish immutable artifact
  -> commit authoritative snapshot with ArtifactCommitment
```

Do not expose a temporary path as a stable reference. A crash before immutable
publication leaves no committed artifact. A crash after publication but before
snapshot advancement leaves an unreferenced candidate that recovery may verify
and adopt only through the owning contract.

Never overwrite an immutable artifact. Repeated publication of identical bytes
under the same semantic identity converges. Divergent bytes are preserved as
conflict evidence and never selected by timing.

## 7. Authority and mutation rules

Resolve references from authoritative records, not from host, worker, or model
arguments. A producer may provide bytes through one fixed staging location or
opaque ticket, but it cannot choose the final artifact reference.

If committed artifact bytes change, disappear, or fail safe-open validation:

- stop the transition that needs them;
- preserve bounded diagnostic evidence when safe;
- classify the condition through the owning contract;
- never refresh the commitment silently;
- never search nearby paths for a plausible replacement.

Treat an integrity failure as an authority or protocol problem when identity can
no longer be trusted. Do not normalize such a failure into an ordinary worker
result.

## 8. Host tickets and control artifacts

Commit every host ticket as an `ArtifactCommitmentV1` in the authoritative
workset before delivering the ticket identity to the host session.

Require the Runner-owned submission command to resolve the opaque ticket
identity, safe-open the committed ticket, verify its exact content digest, and
only then evaluate expiration, attempt identity, job identity, intake, and
payload staging.

Apply the same commitment rule to manifests, attempt rejections, strategy state,
submissions, final outcomes, resume proofs, and any diagnostic artifact that can
change control behavior.

Owner tokens and other secret control values must not appear in portable
references, content-addressed keys, or semantic artifact identities.

## 9. Retention and cleanup

Retain every artifact while an authoritative snapshot, pending delivery,
quarantine record, resume proof, or diagnostic retention rule references it.

Make cleanup reference-aware and idempotent. Revalidate current authority before
deleting. Never infer safety from age, process ID, or an event stream alone.

Unreferenced temporary and conflict artifacts may be collected only through a
bounded policy that cannot race a current publication or recovery operation.

## 10. Versioning and conformance tests

Treat changes to reference kinds, path interpretation, digest meaning,
publication ordering, or safe-open guarantees as versioned contract changes.

Require tests for:

- parent traversal and current-directory segments;
- absolute, drive-prefixed, UNC, alternate-separator, and NUL paths;
- symlink substitution at every path level;
- post-open replacement races;
- unexpected file types;
- oversized and truncated reads;
- missing content;
- content digest mismatch;
- content-addressed store-key mismatch;
- crash before and after immutable publication;
- identical and divergent duplicate publication;
- host ticket mutation;
- cleanup racing a referenced artifact.

## 11. Consumers

The following conception documents consume this standard without redefining
it:

- [CDD-O Turnlock Delegation Attempt Execution](../working/cdd-o-turnlock-delegation-attempt-execution.md);
- [CDD-I Turnlock Runner Workset Contract](../working/cdd-i-turnlock-runner-workset-contract.md);
- [CDD-S Pi Subagents Execution](../working/cdd-s-pi-subagents-execution.md).
