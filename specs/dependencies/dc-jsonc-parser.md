---
okf_version: "1.0"
kind: "RuntimeArtifact"
format: "dependency-contract"
workspace: "turnlock"
date: "2026-07-21"
step_id: 0
id: "DC-JSONC-PARSER"
type: "dependency-contract"
version: "0.1.0"
dependency_version: "3.3.1"
scope: "strict-json-tokenization-and-parsing"
status: "active"
consumers:
  - "turnlock-core"
  - "turnlock-runner"
referenced_by:
  - "STD-TURNLOCK-CANONICAL-JSON-AND-DIGEST"
superseded_by: []
source_repository: "https://github.com/microsoft/node-jsonc-parser"
source_commit: "3c9b4203d663061d87d4d34dd0004690aef94db5"
package_integrity: "sha512-HUgH65KyejrUFPvHFPbqOY0rsFip3Bo5wb4ngvdi1EpCYWUQDC5V+Y7mZws+DLkr4M//zQJoanu1SP+87Dv1oQ=="
---

# Dependency Contract — jsonc-parser

## 0. Identity

- **Package:** `jsonc-parser`
- **Version:** `3.3.1`
- **Source tag:** `v3.3.1`
- **Source commit:** `3c9b4203d663061d87d4d34dd0004690aef94db5`
- **License:** MIT
- **Runtime dependencies:** None declared

<!-- markdownlint-disable MD013 -->

- **Registry integrity:** `sha512-HUgH65KyejrUFPvHFPbqOY0rsFip3Bo5wb4ngvdi1EpCYWUQDC5V+Y7mZws+DLkr4M//zQJoanu1SP+87Dv1oQ==`

<!-- markdownlint-enable MD013 -->

Use this dependency only for token-aware strict JSON syntax validation and
materialization. Native `TextDecoder` owns the byte-to-string boundary. Turnlock
owns semantic I-JSON, schema, and resource validation.

## 1. Interface

Import documented package exports only:

```typescript
import {
  parse,
  visit,
  type JSONVisitor,
  type ParseError,
  type ParseOptions,
} from "jsonc-parser";
```

Use strict parse options equivalent to:

```typescript
const options: ParseOptions = {
  allowTrailingComma: false,
  disallowComments: true,
  allowEmptyContent: false,
};
```

Use `visit` before `parse` so every object-property token is observable before
object materialization.

Reject the UTF-8 BOM byte prefix `EF BB BF` before decoding. Decode bounded
bytes with:

```typescript
new TextDecoder("utf-8", {
  fatal: true,
  ignoreBOM: true,
}).decode(bytes);
```

`ignoreBOM: true` keeps an unexpected U+FEFF visible rather than silently
stripping it. Reject a leading U+FEFF after decode as defense in depth.

## 2. Behavioral Contract

### Strict parsing pathway

1. Enforce the consuming raw-byte limit.
2. Reject the UTF-8 BOM prefix.
3. Decode with fatal UTF-8.
4. Visit tokens with comments and trailing commas disabled.
5. Maintain one exact property-name set per object frame.
6. Reject the second occurrence of an exact decoded property name.
7. Require no tokenizer or visitor error.
8. Parse with the same strict options and require an empty `ParseError[]`.
9. Validate Unicode scalar values, numeric domain, depth, members, items, and
   string limits.
10. Pass the semantic value to the consuming typed schema.

Escaped and literal property spellings that decode to the same JavaScript string
are duplicates. Never keep a first or last duplicate value.

### Resource behavior

Stop token visitation on the first duplicate, syntax error, or structural limit.
Do not materialize a value after a failed visit. Bound error summaries and never
include unrestricted private input.

### Semantic limits

The package materializes JavaScript numbers and strings. Turnlock must reject:

- non-finite numbers;
- exact integers outside the consuming binary64-safe domain;
- unpaired UTF-16 surrogate code units in values or property names;
- typed-schema violations;
- resource-policy violations.

The package does not provide these semantic guarantees by itself.

## 3. Error Semantics

| Failure | Turnlock result |
| ------- | --------------- |
| Input byte limit | Closed size validation failure |
| BOM | Malformed JSON input |
| Fatal UTF-8 decode | Malformed JSON input |
| Comment or trailing comma | Malformed JSON input |
| Duplicate property | Duplicate-member validation failure |
| `ParseError` | Malformed JSON with bounded summary |
| Visitor throw | Parser dependency failure |
| Unsupported number or Unicode | I-JSON domain failure |

Never retry the same bytes under relaxed options. Never fall back to native
`JSON.parse` after strict validation fails.

## 4. Integration Patterns

Use local visitor stacks and error collections for each input. Share only the
stateless package module. Do not retain parsed private values beyond the owning
operation.

CI must verify exact lockfile version, registry integrity, source commit,
duplicate-key vectors, JSON syntax vectors, UTF-8 boundaries, and certified Bun
and Node behavior. Runtime startup verifies the committed dependency identity
but does not run the full suite.

The canonical value produced by this contract is passed to
[DC-CANONICALIZE](dc-canonicalize.md) only after all semantic and typed validation
succeeds.

## 5. Consumer Constraints

- Pin version `3.3.1` exactly; do not use a range.
- Add the package only after the runtime-dependency ADR approves it.
- Enable no JSONC or JSON5 extension.
- Detect duplicates during token visitation before `parse`.
- Reject BOM rather than tolerating or stripping it.
- Bound bytes before dependency use and structure during visitation.
- Treat unknown parser behavior as a closed dependency failure.
- Write a superseding contract before any package upgrade.

## 6. Known Limitations

- Strictness depends on explicit parse options.
- Duplicate rejection requires consumer-maintained object-frame sets over
  documented visitor events.
- UTF-8 validity must be established before passing a string to the package.
- I-JSON Unicode and numeric constraints require Turnlock semantic validation.
- The package does not own Turnlock schema, domain separation, or digest rules.
