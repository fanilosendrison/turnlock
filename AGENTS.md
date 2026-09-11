---
okf_version: "1.0"
kind: "KnowledgeAsset"
asset_type: "agent-directives"
domain: "turnlock"
severity: "strict"
name: "Turnlock repository agent directives"
---

# Turnlock repository directives

Use this file as the operational map for the Turnlock repository. Apply it with
all parent workspace instructions. Never duplicate, weaken, or override a parent
permission, security, formatting, naming, or implementation rule.

## General guidelines

- Treat Turnlock as a production TypeScript package with durable runtime and
  protocol compatibility obligations.
- Preserve deterministic mechanical orchestration and explicit semantic yield
  boundaries.
- Preserve fail-closed behavior for unknown, ambiguous, stale, corrupt, or
  incompatible durable state.
- Keep the runtime host-agnostic. Turnlock records logical delegation targets;
  consumer runtimes choose physical execution.
- Use Node.js and pnpm exclusively for repository tooling. Preserve only the
  historical or external-consumer runtime literals admitted by the exact
  migration allowlist.
- When the user mentions an Issue, Project work, backlog work, or a review
  finding, apply the shared GitHub Engineering Projects operational protocol,
  then read `docs/repository-governance/turnlock-engineering.md`.

## Authority by responsibility

Use each source only for the responsibility it owns:

1. `src/`, exported contracts, and tests define current implemented behavior.
2. Accepted ADRs under `docs/adr/` record architectural decisions and their
   amendment history.
3. `docs/architecture/` explains the current architecture and must remain
   synchronized with implementation.
4. `package.json` and `README.md` define the supported package, runtime, and user
   surface.
5. Migration documents define their bounded compatibility and cutover
   contracts.
6. GitHub Issues, Project fields, backlogs, and historical records manage or
   explain work; they do not change technical behavior by themselves.

When code or tests disagree with living documentation, treat code and tests as
authoritative for current behavior, fix the documentation, and record an
architectural correction with a later ADR when required. Report every
inconsistency instead of silently selecting a convenient source.

## Required reading

Before changing runtime behavior, public contracts, persistence, or
architecture, read:

1. `README.md`
2. `docs/architecture/delegation-model.md`
3. `docs/adr/README.md`
4. The ADRs and migration contracts governing the affected concept
5. The implementation and tests that currently exercise the affected contract

Read `docs/sqlite-ownership-migration.md` before changing ownership, lifecycle,
retention, run-directory, or SQLite migration behavior.

## Folder structure

```text
turnlock/
├── AGENTS.md
├── README.md
├── package.json
├── backlog.md
├── backlog.archive.md
├── src/
│   ├── bindings/
│   ├── engine/
│   ├── errors/
│   ├── persistence/
│   ├── services/
│   └── types/
├── tests/
├── scripts/
├── docs/
│   ├── adr/
│   ├── architecture/
│   ├── migrations/
│   ├── repository-governance/
│   └── sqlite-ownership-migration.md
├── dist/                  generated package output
└── .github/workflows/
```

Keep repository-root files limited to package entry points, operational maps,
and established project configuration. Use lowercase kebab-case for new files
and directories except recognized system entry points such as `AGENTS.md` and
`README.md`.

## Engineering work tracking

- Apply the shared GitHub Engineering Projects operational protocol for generic
  Issue and Project operations.
- Use `docs/repository-governance/turnlock-engineering.md` only for Turnlock's
  Project coordinates, fields, views, and repository-specific policy.
- Resolve an unqualified `Issue #N` as `fanilosendrison/turnlock#N`.
- Track all new durable work in Turnlock Engineering and its associated Issues.
- Never append active work to `backlog.md` or `backlog.archive.md`.
- Revalidate every finding against current code and tests before implementation.

## Architectural invariants

### Durable authority

- Treat run-local `turnlock.sqlite3` as the sole workflow authority.
- Treat `state.json` as a repairable projection, never an independent authority.
- Preserve fenced ownership, exact state revisions, CAS transitions, atomic
  bootstrap, and crash-safe migration boundaries.
- Keep the namespace sidecar SQLite database an ephemeral mutex only. Never use
  it as run-state or workflow authority.
- Never infer terminality from free ownership, an expired lease, directory age,
  missing processes, or absent callers.

### Protocol and observability

- Reserve production stdout for exactly the documented Turnlock protocol blocks.
- Emit production events on stderr as newline-delimited JSON only.
- Preserve protocol bytes, field ordering, exit codes, JSON shapes, and manifest
  versions unless an explicit versioned contract change authorizes a break.
- Keep events, artifacts, manifests, accepted external resolutions, and state
  correlated with exact run and request identities.

### Delegation and external effects

- Keep delegation shape, logical target, and physical execution as separate
  concepts.
- Require explicit `host | worker(name)` targets. Never restore an implicit
  singleton or destination default.
- Never add provider, model, subagent, process, or execution-class vocabulary to
  Turnlock core delegation contracts.
- Treat external requests and resolutions as opaque JSON transport. Turnlock
  must not execute, retry, interpret, or compensate the external business
  effect.

### Module boundaries

- Keep public data contracts and pure type definitions under `src/types/` and
  error taxonomy under `src/errors/`.
- Keep orchestration and transition coordination under `src/engine/`.
- Keep durable SQLite authority and schema behavior under
  `src/persistence/sqlite/`.
- Keep bounded technical services under `src/services/` and public bindings
  under `src/bindings/`.
- Do not duplicate protocol, persistence, validation, migration, or lifecycle
  authority across layers.
- Do not edit `dist/` directly; generate it from `src/` with the package build.

## Testing and compatibility

- Add independent tests for every changed invariant, failure mode, migration,
  protocol shape, or public contract.
- Preserve deterministic concurrency tests through explicit synchronization;
  never weaken timing assertions to hide flakiness.
- Update `tests/test-manifest.json` whenever a test file is added, removed, or
  renamed.
- Keep package-consumer tests independent from source-only module resolution.
- Preserve the Node/pnpm cutover policy in
  `docs/migrations/node-pnpm/functional-parity-contract.md` and its allowlist.
- Apply SemVer to public API, protocol, persistence, and package compatibility
  changes according to the parent workspace rules.

## Architectural decisions and documentation

- Add ADRs chronologically under `docs/adr/` using
  `NNNN-lowercase-kebab-title.md`.
- Never silently rewrite an accepted ADR. Use a later ADR to amend or supersede
  it.
- Keep living architecture under `docs/architecture/` synchronized with current
  behavior.
- Keep repository process under `docs/repository-governance/`, separate from
  runtime and product documentation.
- Keep README examples executable; package tests verify their delegation
  snippets.

## Mandatory validation

Use the pinned package manager and run the complete sequence after every
intentional change:

```bash
pnpm run test:policy
pnpm run typecheck
pnpm run lint
pnpm run build
pnpm test
pnpm run test:node-package
pnpm pack --pack-destination "<temporary-directory>"
git diff --check
```

Use `pnpm install --frozen-lockfile --ignore-scripts` first when dependencies
must be installed or the lockfile changes. Do not declare work complete while a
change-caused failure remains unresolved. Report unrelated pre-existing failures
without silently expanding scope.

## Quick navigation

- Product and usage contract: `README.md`
- Current delegation architecture: `docs/architecture/delegation-model.md`
- Architectural decision index: `docs/adr/README.md`
- SQLite ownership and lifecycle migration: `docs/sqlite-ownership-migration.md`
- Node/pnpm parity contract:
  `docs/migrations/node-pnpm/functional-parity-contract.md`
- Engineering Project profile:
  `docs/repository-governance/turnlock-engineering.md`
- Current work pointer: `backlog.md`
- Historical backlog: `backlog.archive.md`
- Package scripts and supported engines: `package.json`
- Test inventory: `tests/test-manifest.json`
