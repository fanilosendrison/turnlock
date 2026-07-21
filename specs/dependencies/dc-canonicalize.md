---
okf_version: "1.0"
kind: "RuntimeArtifact"
format: "dependency-contract"
workspace: "turnlock"
date: "2026-07-21"
step_id: 0
id: "DC-CANONICALIZE"
type: "dependency-contract"
version: "0.1.0"
dependency_version: "3.0.0"
scope: "rfc8785-canonicalization"
status: "active"
consumers:
  - "turnlock-core"
  - "turnlock-runner"
referenced_by:
  - "STD-TURNLOCK-CANONICAL-JSON-AND-DIGEST"
superseded_by: []
source_repository: "https://github.com/erdtman/canonicalize"
source_commit: "aba9209d044f2729c51141d8a73b11e80816e42c"
package_integrity: "sha512-yYLfHyDMIXRyRqsKBRLX023riFLpXY2YOfdtqKXZRZy9qsfOJ9U+4F9YZL7MEzL5+ziN2x2nlBvY/Voi3EBljA=="
---

# Dependency Contract — canonicalize

## 0. Identity

- **Package:** `canonicalize`
- **Version:** `3.0.0`
- **Source tag:** `v3.0.0`
- **Source commit:** `aba9209d044f2729c51141d8a73b11e80816e42c`
- **License:** Apache-2.0
- **Runtime dependencies:** None declared

<!-- markdownlint-disable MD013 -->

- **Registry integrity:** `sha512-yYLfHyDMIXRyRqsKBRLX023riFLpXY2YOfdtqKXZRZy9qsfOJ9U+4F9YZL7MEzL5+ziN2x2nlBvY/Voi3EBljA==`

<!-- markdownlint-enable MD013 -->

Use this dependency only to produce RFC 8785 canonical JSON text from an
already validated Turnlock semantic subject.

## 1. Interface

Import the documented default export:

```typescript
import canonicalize from "canonicalize";

const canonicalText: string | undefined = canonicalize(validatedSubject);
```

Require a defined string result. Encode it with native UTF-8 and hash the exact
bytes with native `node:crypto` SHA-256.

Do not invoke the package CLI at runtime. Do not import private source files.

## 2. Behavioral Contract

### Preconditions

Before calling `canonicalize`, require that:

- [DC-JSONC-PARSER](dc-jsonc-parser.md) accepted the original JSON bytes;
- the semantic value passed typed-schema validation;
- every string and property name contains only Unicode scalar values;
- every number belongs to the consuming interoperable binary64 domain;
- no `undefined`, function, symbol, bigint, `NaN`, or infinity exists;
- every resource-policy structural limit passed;
- the complete registered Turnlock domain and schema-version wrapper exists;
- no digest field occurs inside its own digest subject.

### Postconditions

Treat the returned JavaScript string as RFC 8785 canonical JSON text. Encode
with UTF-8 without BOM. Equal validated semantic subjects must produce identical
bytes on every certified process. Different domain wrappers intentionally
produce different bytes when their embedded values are equal.

Calculate the digest as lowercase full-length SHA-256 hexadecimal prefixed by
`sha256:`. The package does not perform hashing.

### Persistence

Canonical text is an intermediate representation. Persist it only when an
owning contract explicitly requires canonical bytes, such as an attempt-terminal
or core-outbox artifact. Otherwise persist the original validated contract form
and its semantic digest according to the artifact standard.

## 3. Error Semantics

| Failure | Turnlock result |
| ------- | --------------- |
| Undefined return | Canonicalization dependency failure |
| Package throw | Canonicalization dependency failure |
| UTF-8 encode failure | Runtime dependency failure |
| Official vector mismatch | Dependency incompatible; reject startup |
| Recomputed digest mismatch | Consumer integrity or protocol failure |

Do not fall back to recursive key sorting, native `JSON.stringify`, pretty
printing, or locale-sensitive ordering.

## 4. Integration Patterns

Construct the domain-separated subject in Turnlock code, call the stateless
default export once, encode once, and hash once. Keep canonical bytes bounded by
the committed resource policy.

CI must verify:

- exact package, integrity, source commit, and lockfile identity;
- official RFC 8785 vectors;
- Unicode ordering and escaping vectors;
- ECMAScript number serialization boundaries;
- semantically equal objects with different source order;
- domain separation for equal embedded values;
- cross-process Node and Bun byte equality;
- lowercase digest formatting.

Runtime startup verifies committed package identity. It does not substitute a
small local vector set for the complete CI contract suite.

## 5. Consumer Constraints

- Pin version `3.0.0` exactly; do not use a range.
- Add the package only after the runtime-dependency ADR approves it.
- Never pass unvalidated parsed input directly to `canonicalize`.
- Never include self-digest fields in the subject.
- Use native SHA-256 and full lowercase hexadecimal.
- Bound canonical output before persistence.
- Treat an undefined result or throw as closed dependency failure.
- Write a superseding contract before any package upgrade.

## 6. Known Limitations

- The package assumes input already belongs to the RFC 8785/I-JSON domain.
- It does not parse bytes, detect duplicate members, validate Unicode scalar
  values, enforce numeric policy, or validate Turnlock schemas.
- It does not provide domain separation or hashing.
- Its correctness remains dependent on the certified JavaScript number and
  string behavior of the pinned runtimes.
