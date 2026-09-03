# Turnlock Delegation Target Migration — Execution TODO

Temporary implementation checklist. Items are marked `[x]` ONLY after implementation + relevant tests pass.

## Phase 0 — Baseline
- [x] Inspect repository structure and read all mandated files
- [x] Run baseline verification (`pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm test:node-package`)
- [x] Record baseline results (including any pre-existing failures) below

## Phase 1 — ADR
- [ ] Create `docs/adr/0001-logical-delegation-targets.md`
- [ ] Create `docs/adr/README.md` (convention explanation)
- [ ] ADR documents context, decision, host meaning, worker meaning, rejected alternatives, consequences/migration

## Phase 2 — Living architecture doc
- [ ] Create `docs/architecture/delegation-model.md`
- [ ] Documents the 3 orthogonal axes table + concrete examples
- [ ] Shows consumer resolution examples (Pi child, LLM API) without leaking into core

## Phase 3 — Public delegation API
- [ ] Add `DelegationTarget` to `src/types/delegation.ts`
- [ ] Make `target` mandatory on `PromptDelegationRequest`
- [ ] Make `target` mandatory on `BatchDelegationRequest`
- [ ] Remove `worker?: string` from public request API
- [ ] Export `DelegationTarget` from `src/index.ts`
- [ ] Update public API contract tests (ts-expect-error proofs)

## Phase 4 — Manifest contract
- [ ] Replace `worker?: string` with mandatory `target: DelegationTarget` in `src/bindings/types.ts`
- [ ] Update `src/bindings/prompt.ts` to serialize target
- [ ] Update `src/bindings/batch.ts` to serialize target
- [ ] Ensure no legacy `worker` field emitted
- [ ] Update binding tests + fixtures

## Phase 5 — Serialization versions
- [ ] Verify PROTOCOL_VERSION=3, STATE_SCHEMA_VERSION=4 assumptions against code
- [ ] Bump MANIFEST_VERSION 2 → 3
- [ ] Document any additional version changes in ADR + TODO (only if technically required)

## Phase 6 — Fail-closed target validation
- [ ] Inspect existing naming conventions (labels, request types)
- [ ] Add runtime validation for target shapes (valid host/worker; reject empty name, unknown kind, host+name)
- [ ] Invalid input fails closed with appropriate Turnlock error
- [ ] Add validation tests

## Phase 7 — Target preserved across retries
- [ ] Inspect `delegation-reemit.ts`, `shared.ts`, retry/recovery code
- [ ] Ensure target preserved exactly across attempts
- [ ] Only attempt-specific fields change (attempt, emittedAt, deadline, resultPath, jobs[].resultPath)
- [ ] Write explicit retry preservation tests (host + worker + name)

## Phase 8 — Legacy manifest v2 compatibility
- [ ] Case A: v2 + worker present → deterministic `target: {kind:"worker",name}` migration
- [ ] Case B: v2 + worker absent → NEVER guessed as host
- [ ] Safe result consumption without re-execution still works
- [ ] Re-emission of ambiguous v2 target fails closed with diagnosable error (existing error conventions)
- [ ] Tests for all three cases

## Phase 9 — Observability
- [ ] `delegation_emit` event gains: target, attempt, jobCount (already has runId/phase/label/kind/timestamp — verify)
- [ ] Update initial emission AND retry/re-emission paths
- [ ] No physical runtime fields (provider/model/executionClass/piSession/subagent) in Turnlock events
- [ ] Update `src/types/events.ts`, taxonomy + ndjson tests, fixtures

## Phase 10 — stdout protocol
- [ ] Verify protocol remains conceptually unchanged (runtime reads manifest for target)
- [ ] PROTOCOL_VERSION unchanged unless technically required
- [ ] Update protocol tests only where required

## Phase 11 — Internal callers, tests, fixtures sweep
- [ ] Grep for `worker:`, `worker?`, `.worker`, `kind: "prompt"`, `kind: "batch"`, `io.delegate(`, `io.delegateBatch(`, `manifestVersion`, `MANIFEST_VERSION`, `delegation_emit`
- [ ] Give every delegation an explicit logical target (host vs worker by intent)
- [ ] Update fixtures in `tests/fixtures/manifests|states|protocol`
- [ ] Update `tests/test-manifest.json` if tests added/removed

## Phase 12 — Strengthened contract tests
- [ ] Public API: DelegationTarget importable, target required, legacy worker absent, @ts-expect-error proofs
- [ ] Prompt binding: host/worker/name preservation, target serialized, no legacy worker field, manifest v3
- [ ] Batch binding: same, disjoint job paths, empty-batch behavior, manifest v3
- [ ] Runtime validation: valid host/worker accepted; empty name, invalid kind rejected
- [ ] Retry: host/worker/name survive; only attempt-specific props change
- [ ] Legacy: v2+worker → worker; v2 without worker never → host; safe resume OK; ambiguous re-emission fails closed
- [ ] Observability: initial emit has target+attempt 0; retry emit has correct target+incremented attempt; valid JSON
- [ ] Durability/regression suite untouched and green (ownership, fencing, artifacts, crash, migration, external requests, protocol, package surface)

## Phase 13 — README
- [ ] Remove "delegates to the host agent" narrow claims
- [ ] Explain logical target + runtime resolution model
- [ ] Add explicit orchestration example (worker("researcher") batch → host synthesis → worker("reviewer"))

## Phase 14 — Stale spec references
- [ ] Remove/replace NIB-T §13/§14/§27 style comments in touched files
- [ ] Reference ADR-0001 / delegation-model.md where useful
- [ ] No new phantom NIB specs

## Phase 15 — Package docs
- [ ] Inspect `files` in package.json
- [ ] Include `docs/adr/**`, `docs/architecture/**` (+ keep existing migration docs)
- [ ] Prove packed artifact contains docs (package-level test if needed)

## Phase 16 — Package/release identity
- [ ] Inspect package.json/backlog.md/README/constants/migrations for version policy
- [ ] MANIFEST_VERSION → 3 (required)
- [ ] Determine correct package release identity per repo policy
- [ ] Fix existing version-drift issue only if safe and coherent; else record exact follow-up
- [ ] No two materially different contracts under same released identity

## Phase 17 — No unrelated semantics changes
- [ ] Preserve phase transitions, single PhaseResult, immutable manifests, per-attempt paths, retry, result validation, SQLite authority, fencing, ownership, crash recovery, external requests, fail-closed
- [ ] Unrelated bugs → backlog.md only

## Phase 18 — Targeted verification per layer (record results)
- [ ] types/public surface tests
- [ ] binding tests
- [ ] retry/reconstruction tests
- [ ] observability tests
- [ ] legacy manifest compatibility tests
- [ ] engine/e2e delegation tests
- [ ] full suite

## Phase 19 — Full verification
- [ ] `pnpm test` green
- [ ] `pnpm typecheck` green
- [ ] `pnpm lint` green
- [ ] `pnpm test:node-package` green
- [ ] crash/durability specialized scripts green

## Phase 20 — Adversarial self-review
- [ ] All 18 review questions answered; defects fixed + tests rerun

## Phase 21 — Final diff review
- [ ] `git diff` reviewed per-file
- [ ] Final full verification after last change

## Phase 22 — Completion + TODO removal
- [ ] All completion criteria checked
- [ ] Remove this TODO file

---

## Baseline results (Phase 0)

- branch: `delegation-logical-targets` (created from `main` @ 0b2eefe)
- `pnpm test` → 552 passed, 0 failed (134 suites)
- `pnpm typecheck` → PASS
- `pnpm lint` → PASS (140 files, 0 warnings)
- `pnpm test:node-package` → 1 passed, 0 failed
- git history checked: `c071836` (July 2026) reduced kinds to prompt/batch and bumped ALL versions to 2 with fail-closed detection intent (manifestVersion mismatch during retry reconstruction)
- Key facts verified: protocol block does not encode worker/target (runtime reads manifest); state v4 stores only ArtifactRef for manifests (no worker field); resume-with-complete-results never reads the manifest; reemit reads manifest via ArtifactRef and currently rejects manifestVersion !== MANIFEST_VERSION
- npm registry: published versions 0.0.1, 0.3.1, 0.8.0, 0.9.0, 0.9.1 — 0.10.0 is UNPUBLISHED; git tags only v0.9.0/v0.9.1; precedent: breaking batches get 0.x minor bumps (0.8.0 taxonomy, 0.10.0 node migration)
- Pre-existing failures: NONE
