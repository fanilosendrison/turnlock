---
okf_version: "1.0"
kind: "KnowledgeAsset"
asset_type: "standard"
domain: "turnlock-data-integrity"
severity: "strict"
name: "Turnlock Canonical JSON and Digest Standard"
id: "STD-TURNLOCK-CANONICAL-JSON-AND-DIGEST"
version: "0.1.0"
---

# Turnlock Canonical JSON and Digest Standard

## 1. Scope

Apply this standard to every JSON value whose digest crosses a Turnlock core,
Runner, strategy, dependency, process, or recovery boundary.

Use this standard for semantic identity, idempotence, commitment comparison,
and integrity verification. Do not use raw input bytes, insertion order, locale,
or implementation-specific serialization as semantic identity.

This standard is authoritative for:

- the interoperable JSON value domain;
- canonical byte production;
- SHA-256 digest representation;
- digest subject separation;
- digest comparison and verification;
- conformance requirements for the selected implementation.

Artifact byte integrity is governed separately by
[STD-TURNLOCK-ARTIFACT-REFERENCE-AND-INTEGRITY](std-turnlock-artifact-reference-and-integrity.md).

## 2. Normative contract

Represent a semantic JSON digest as:

```typescript
interface PayloadDigestV1 {
  readonly canonicalization: "rfc8785";
  readonly digestAlgorithm: "sha256";
  readonly value: `sha256:${string}`;
}
```

Require `value` to contain exactly 64 lowercase hexadecimal characters after
the `sha256:` prefix. Reject alternate algorithm names, uppercase hexadecimal,
truncated values, and unprefixed digests.

Treat two payload digests as equal only when all three fields are exactly equal.
Do not normalize an unknown representation into a known one during validation.

## 3. Accepted JSON domain

Before semantic use, require every input to satisfy all of these conditions:

- the encoded input is bounded before parsing;
- the encoding is strict UTF-8 without malformed sequences or a byte-order
  mark;
- object member names are unique within each object;
- strings contain Unicode scalar values and no unpaired surrogate code points;
- numbers are finite and interoperably representable in the committed numeric
  domain;
- integers that must remain exact survive an IEEE 754 binary64 round trip, or
  are represented by a contract-defined string form;
- arrays, objects, strings, and nesting depth satisfy the consuming contract's
  closed limits;
- no extension value such as `NaN`, infinity, `undefined`, comments, or trailing
  commas is accepted.

Detect duplicate object member names before an ordinary JSON parser can discard
that information. Do not attempt duplicate detection by inspecting an already
materialized object.

## 4. Canonicalization and digest pathway

Produce a payload digest through exactly this conceptual pathway:

```text
bounded raw bytes
  -> strict UTF-8 validation
  -> duplicate-member-aware JSON parse
  -> interoperable JSON-domain validation
  -> typed contract validation
  -> domain-separated digest subject
  -> RFC 8785 canonical UTF-8 bytes
  -> SHA-256
  -> lowercase prefixed hexadecimal representation
```

Apply RFC 8785 to the validated semantic value. Do not implement canonical JSON
as recursive key sorting around `JSON.stringify`, and do not hash a pretty
printed or transport-specific representation.

A digest field must not occur inside its own digest subject. If a persisted
record carries both content and its digest, construct the subject from the
contractually listed content fields and exclude the digest field.

## 5. Digest subject separation

Wrap every semantic value in a stable domain and schema version before RFC 8785
canonicalization:

```typescript
interface CanonicalDigestSubjectV1<T> {
  readonly domain: `turnlock:${string}`;
  readonly version: number;
  readonly value: T;
}
```

Use a positive integer `version`. Register one fixed domain for each semantic
subject family. Never reuse a domain for values with different authority or
meaning, even when their current JSON shapes happen to match.

The initial domain registry is:

- `turnlock:delegation-manifest`;
- `turnlock:job-payload`;
- `turnlock:executor-spec`;
- `turnlock:workspace-policy`;
- `turnlock:workspace-manifest`;
- `turnlock:host-ticket`;
- `turnlock:submission`;
- `turnlock:outcome`;
- `turnlock:attempt-rejection`;
- `turnlock:semantic-event`;
- `turnlock:resume-command`.

A consuming NIB may add a domain only when it defines the complete digest
subject and its schema version. Changing a domain, subject membership, or
version changes the digest by design and requires an explicit compatibility
transition.

## 6. Verification and idempotence

When consuming committed JSON:

1. validate the declared digest representation;
2. parse and validate the candidate through the pathway in section 4;
3. reconstruct the registered domain-separated subject;
4. recompute the digest;
5. compare the complete digest object exactly;
6. accept equality as content identity and reject divergence.

Do not trust a digest supplied by the same untrusted producer without
recomputation. Do not select between divergent values by timestamp, discovery
order, path order, or retry count.

Identical canonical subjects must converge to the same digest across supported
processes and platforms. Different registered domains must not converge merely
because their embedded `value` members are equal.

## 7. Implementation dependency

Select a maintained implementation of strict JSON parsing and RFC 8785 through
an ADR. Pin and constrain that implementation through a Dependency Contract.

Require the Dependency Contract to cover:

- exact package and source identity;
- strict UTF-8 behavior;
- duplicate member detection;
- Unicode and numeric behavior;
- RFC 8785 conformance;
- error behavior and resource limits;
- supported runtime versions;
- upstream RFC test vectors;
- maintenance and vulnerability response.

Do not replace the selected implementation with project-local canonicalization
logic unless a later ADR explicitly authorizes that change.

## 8. Security and resource limits

Bound bytes before parsing and bound structure before canonicalization. Treat
limit exhaustion as a closed validation failure, not as partial input.

Never place secrets, owner tokens, credentials, unrestricted local paths, or
raw private model context into a digest subject merely to make it unique. A
digest is an identifier and integrity commitment, not encryption.

Compare fixed-format digest values without accepting abbreviations. Use a
constant-time comparison when the surrounding threat model treats digest
guessing as sensitive; otherwise exact byte equality remains sufficient for
integrity semantics.

## 9. Versioning and conformance tests

Treat any change to the accepted JSON domain, canonicalization algorithm,
digest algorithm, domain registry, or subject membership as a versioned
contract change.

Require tests for:

- official RFC 8785 vectors;
- semantically equal objects with different source member order;
- duplicate members;
- malformed UTF-8 and unpaired surrogates;
- numeric boundary and round-trip cases;
- excluded self-digest fields;
- domain separation for equal embedded values;
- lowercase digest formatting;
- bounded depth, collection, string, and byte failures;
- cross-process and cross-platform digest stability.

## 10. Consumers

The following conception documents consume this standard without redefining
it:

- [CDD-O Turnlock Delegation Attempt Execution](../working/cdd-o-turnlock-delegation-attempt-execution.md);
- [CDD-I Turnlock Runner Workset Contract](../working/cdd-i-turnlock-runner-workset-contract.md);
- [CDD-S Pi Subagents Execution](../working/cdd-s-pi-subagents-execution.md).
