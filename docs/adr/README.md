# Architecture Decision Records

This directory holds Architecture Decision Records (ADRs) for turnlock.

## Convention

- One file per decision: `NNNN-lowercase-kebab-title.md`
- `NNNN` is a zero-padded, monotonically increasing sequence number
  (0001, 0002, …).
- The newest decisions have the highest numbers.
- Decisions are immutable once merged. Do not rewrite history: if a
  decision is superseded, record a new ADR and link back to the old one.
- Every ADR must contain at minimum: **Status**, **Date**, **Context**,
  **Decision**, **Consequences** — and **Rejected alternatives** where
  alternatives were seriously considered.
- The ADR explains *why* a decision was made; the living documentation
  (`docs/architecture/`) explains *how* the current system works. When code
  and docs disagree, the code and its tests are authoritative; fix the docs
  and record the correction.

## Index

| # | Title | Status |
| - | ----- | ------ |
| [0001](0001-logical-delegation-targets.md) | Separate Logical Delegation Targets from Runtime Execution | accepted |
