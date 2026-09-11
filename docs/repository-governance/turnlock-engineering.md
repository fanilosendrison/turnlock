---
okf_version: "1.0"
kind: "KnowledgeAsset"
asset_type: "agent-directives"
domain: "turnlock-repository-governance"
severity: "strict"
name: "Turnlock Engineering GitHub Project profile"
---

# Turnlock Engineering GitHub Project profile

Apply the shared GitHub Engineering Projects operational protocol before using
this profile. This file contains only Turnlock-specific routing, authority,
classification, and workflow policy.

## Fixed routing

- GitHub owner: `fanilosendrison`
- Default repository: `fanilosendrison/turnlock`
- Project title: `Turnlock Engineering`
- Project number: `4`
- Project URL: <https://github.com/users/fanilosendrison/projects/4>
- Project type: private user-owned GitHub Project V2

Resolve an unqualified `Issue #N` as `fanilosendrison/turnlock#N`. Follow an
explicit repository-qualified reference or Issue URL instead when the user
provides one.

## Turnlock authority boundary

Treat GitHub Issues associated with Turnlock Engineering as the canonical source
for future engineering work and the Project as the authority for its
classification, priority, size, area, and workflow state.

Keep technical authority in the repository domain that owns it:

- current public and runtime behavior: `src/`, exported contracts, and tests;
- accepted architectural decisions: `docs/adr/`;
- living architecture explanations: `docs/architecture/`;
- package support and user contract: `package.json` and `README.md`;
- migration contracts and operational history: `docs/migrations/`,
  `docs/sqlite-ownership-migration.md`, and Git history.

Accepted ADRs are immutable once merged. When code or tests disagree with
living documentation, treat code and tests as authoritative for current
behavior, fix the documentation, and record any architectural correction with a
new ADR where required.

An Issue may identify a defect or propose future behavior, but its proposal does
not change current runtime, persistence, protocol, or public-API semantics by
itself.

## Workflow-status mapping

Map the shared protocol's workflow roles to these exact `Status` values:

- unready backlog: `Backlog`
- ready for independent pickup: `Ready`
- active execution: `In progress`
- reviewable result: `Review`
- completed work: `Done`

Preserve the lowercase `p` in `In progress`. `Ready` means that implementation,
investigation, or architecture work is sufficiently defined to be picked up.
`Review` includes verification, CI, hostile audit, and acceptance of an existing
result.

## Classification fields

### Work type

Use the exact `Work type` value that owns the immediate outcome:

- `Architecture`
- `Implementation`
- `Bug`
- `Test gap`
- `Refactor`
- `Docs`
- `Release`
- `Investigation`

Do not force a multi-outcome item into one type when its parts require separate
acceptance or scheduling. Split and link those units instead.

### Area

Use the primary affected subsystem:

- `Core`
- `Persistence`
- `Ownership`
- `Runtime`
- `Delegation`
- `Multi-run`
- `Filesystem`
- `Protocol`
- `Tooling`
- `Packaging`

Choose the area that owns the change, not every subsystem that may be touched by
validation.

### Size

Use `Size` for implementation and reasoning scope, never urgency:

- `XS`
- `S`
- `M`
- `L`
- `XL`

### Priority

Use `Priority` according to the Project contract:

- `P0`: immediate correctness, data-loss, safety, release-blocking, or
  architectural-integrity work.
- `P1`: high-value or foundational work that should be addressed soon.
- `P2`: important planned work without immediate urgency.
- `P3`: useful improvement, cleanup, optimization, or lower-priority
  exploration.

Priority never permits weakening fail-closed behavior, durability, protocol
compatibility, public contracts, or required tests.

## Project views

The intended views are:

- `Engineering board`: unfiltered board of current Project work.
- `Backlog`: table filtered to `Status: Backlog`.
- `Done`: table filtered to `Status: Done`.
- `Architecture`: table filtered to `Work type: Architecture`.
- `Bugs & test gaps`: table filtered to `Work type: Bug` or `Test gap`.

Treat any difference between these declarations and live GitHub configuration as
an inconsistency to report before relying on the affected routing.

## Issue requirements

A normal Turnlock Issue must state:

- the problem;
- the desired outcome;
- relevant constraints;
- mechanically checkable acceptance criteria.

When useful, add a collapsed `Coding agent execution brief` containing detailed
execution guidance. Keep the Issue outcome-oriented: repository architecture,
code, tests, and contracts remain authoritative for technical details.

Populate `Status`, `Priority`, `Area`, `Size`, and `Work type` for every Project
Issue. Use native GitHub parent and sub-issue relationships for decomposed work
and keep a synthesis parent focused on integration rather than duplicating every
sub-issue.

## Backlog migration

Active work belongs only in Turnlock Engineering and its associated GitHub
Issues. Do not add new work to `backlog.md`; it is a stable pointer to the
Project. Keep `backlog.archive.md` as historical engineering evidence and do not
mechanically convert it into closed Issues.

The repository and live Project README record the legacy open-backlog migration
as completed on 2026-09-09. Do not reactivate the local backlog.

## Repository validation

Use the complete validation sequence in `AGENTS.md`. A Project status transition
or Issue closure cannot replace policy tests, type checking, linting, build,
package-surface verification, or the full test suite.
