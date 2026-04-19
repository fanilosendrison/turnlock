# Backlog

Items triaged by loop-clean. Checked items are resolved.

## Info-level (hygiene, no urgency)

- [ ] [info] `src/types/config.ts:8` — OrchestratorConfig.phases uses `any` for Phase generic params (intentional ergonomic tradeoff, document with inline comment)
- [ ] [info] `src/errors/base.ts:48` — enrich() mutates OrchestratorError fields in-place (acceptable pattern, document mutation contract in JSDoc)
- [ ] [info] `tests/helpers/run-harness.ts:9` — RunHarness config typed as OrchestratorConfig<any> (expected in test helpers)
- [ ] [info] `tests/helpers/state-builder.ts:29` — buildInitialState uses `as unknown as S` cast (expected in generic test builders)
- [ ] [info] `tests/helpers/protocol-asserts.ts:21` — protocolAsserts.singleBlock uses `as ParsedProtocolBlock` after null check (acceptable in test assertions)
- [ ] [info] `tests/helpers/mock-logger.ts:42` — diskPath assigned but only exposed via hidden __diskPath (TS dead-write workaround, will be functional in GREEN)
- [ ] [info] `tests/contracts/surface.test.ts:134` — Error class mapping uses `as any` casts (necessary for RunLockedError constructor variance)
- [ ] [info] `src/services/logger.ts:15` — Convenience re-exports of LoggingPolicy, OrchestratorEvent, OrchestratorLogger from types/ (document canonical import path in GREEN)
- [ ] [info] `src/bindings/types.ts:3` — MANIFEST_VERSION double re-export chain via bindings/types.ts and bindings/index.ts (convenience, no issue)
- [ ] [info] `tests/bindings/skill-binding.test.ts:9` — makeContext() helper duplicated across 3 binding test files (extract to shared helper when tests stabilize in GREEN)
- [ ] [info] `tests/engine/run-initial-happy-path.test.ts:12` — buildConfig pattern duplicated across 8+ test files (extract shared config builder in GREEN)
- [ ] [info] `tests/lock/lock.test.ts:1` — File at 428 lines, marginally above 400-line threshold (well-structured, no split needed)

## Spec-drift (tool limitation — generic type handling)

- [ ] [info] spec-drift: 10 generic type drift reports are false positives from spec-drift tool not supplying type arguments to prefixed generic types (DelegationBinding, Phase, PhaseIO, PhaseResult, StateFile, ValidationResult)
- [ ] [info] spec-drift: RetryDecision drift — code uses discriminated union `{ retry: true, ... } | { retry: false, ... }` which is stricter than spec's `boolean`. Code is correct; spec NIB-S-CCOR.md:894 should be updated to match the narrower implementation.
