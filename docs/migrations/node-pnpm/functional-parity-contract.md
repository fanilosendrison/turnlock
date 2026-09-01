# Node/pnpm functional parity contract

## Baseline

- Source baseline: `2019a151f89fa8c5564e797dd006875286d46d77`
- Historical package line: `v0.9.1` / npm `turnlock@0.9.1` (immutable)
- Migration target: source version `0.10.0`
- Historical suite: 46 TypeScript test files and 457 `test`/`it` declarations

The source baseline is retained in Git. Historical briefs remain read-only. Current SQLite behavior and tests are authoritative where the historical briefs predate the SQLite ownership model.

## Required parity

The Node successor must preserve:

1. protocol block bytes, field order and stdout exclusivity;
2. exit codes for `DELEGATE`, `DONE`, `ERROR`, `ABORTED` and lock conflicts;
3. stderr as newline-delimited JSON events only;
4. run-directory paths and immutable artifact layout;
5. SQLite schema, logical rows, pragmas, transaction boundaries and migrations;
6. ownership, fence-token, lease, CAS and contention outcomes;
7. crash behavior before and after transaction commit and JSON projection;
8. state, manifest, output and event JSON shapes;
9. public exports, declarations and package ESM behavior;
10. opaque `resume_cmd` values, including commands supplied by external Bun consumers.

SQLite database files are not required to be byte-identical across SQLite engines. Their logical content, durability and externally observable outcomes must be equivalent.

## Cutover rule

No Bun lock, type, import, runtime API, package script, test runner or CI invocation may remain active. Every retained Bun literal requires an exact entry in `bun-allowlist.json`; all other references fail closed.
