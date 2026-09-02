# Backlog Archive

Resolved items moved from backlog.md. Preserves audit trail.

## 2026-04-20 loop-clean iter-0

- [x] [major] `src/engine/dispatch-loop.ts` — file is 982 lines, exceeds 400-line threshold. Split into dispatch-loop.ts (core loop), dispatch-handlers.ts (delegate/done/fail handlers), phase-io.ts (PhaseIO builder). (structure)
- [x] [minor] `src/services/error-classifier.ts` — `classify()` now returns `"unknown"` for runtime error kinds outside the recognized union. Regression coverage verifies the return value remains inside `ErrorCategory`. (correctness)
- [x] [minor] `src/services/state-io.ts` — Zod-transformed state data is reconstructed immutably with `{ ...current, data: result.data }`; the historical mutation no longer exists. (correctness)
- [x] [nit] `src/engine/context.ts` — `LoadedResults.data` now uses `unknown`, with the ordered-array batch variant documented explicitly. (typing / senior-review)
- [x] [info] `src/services/run-dir.ts` — direct removal is intentional for expired ephemeral run directories; trash semantics are not required. (hygiene)
- [x] [info] `src/engine/context.ts` — `IS_TEST` is an immutable module constant, not a mutable singleton. (hygiene)
- [x] [info] `src/services/logger.ts` — the silent `stderrEmit` catch is an intentional resilience boundary that prevents logging failures from masking orchestration outcomes. (correctness)
- [x] [info] legacy `src/services/lock.ts` — obsolete after the file-lock implementation was removed. (hygiene)
- [x] [info] legacy `src/engine/dispatch-loop.ts` terminal serialization — already handled by the terminal artifact flow; the original finding identified no defect. (correctness)
- [x] [info] `RetryDecision` specification drift — the historical NIB was retired in commit `4f1fd4e`; the stricter discriminated union in code and tests is authoritative. (spec-drift)
- [x] [info] generic-type specification drift — acknowledged false positives from retired specification tooling, with no source defect to correct. (spec-drift-tooling)

## 2026-04-22 discovery session

- [x] [major] `src/engine/preflight.ts` — phase values are validated as functions before mode-specific I/O. Unit coverage rejects `null`, string, and number values; process-level coverage verifies invalid config creates no run directory. (correctness / fail-closed)

## 2026-04-20 external review

- [x] [major] `tests/properties/properties.test.ts` — resolved by commit `82517d4`: the assertion-free RED scaffolds were removed and replaced by process-level E2E coverage. The historical NIB containing P-01..P-30 was retired in commit `4f1fd4e`; recreating obsolete labels would not test the current yield-only, SQLite-authoritative runtime. (cheat-detection / tests)
- [x] [major] `src/services/state-io.ts` — superseded by the SQLite-authoritative persistence architecture. The legacy `writeStateAtomic()` helper has no production caller and is excluded from the package surface. The production projection writer in `src/persistence/sqlite/run-state-store.ts` already performs file fsync, atomic rename, and parent-directory fsync under an ownership fence. (durability / correctness)
- [x] [minor] `src/engine/dispatch-loop.ts` — cyclic state cannot reach dispatch in the SQLite-authoritative runtime: state is serialized to JSON before bootstrap or commit and parsed from JSON before every dispatch. Cycles fail at the persistence boundary, so cycle protection in `deepFreeze()` would only cover an internal out-of-contract call. (adversarial-input / correctness)
- [x] [nit] legacy `src/services/lock.ts` — obsolete after migration to SQLite ownership. PID remains diagnostic metadata; lease expiry and monotonic fence tokens are the authoritative takeover mechanism. (dead-code-semantic)

## 2026-04-23 loop-clean audit iter-0

- [x] [notable] `src/engine/handle-resume.ts` + legacy `src/engine/dispatch-handlers.ts` — retry delegation re-emission is centralized in `src/engine/delegation-reemit.ts` and reused by both resume retry paths. The legacy dispatch-handlers module was removed by commit `f2839d9`. (duplication)
- [x] [minor] `src/services/retry-resolver.ts` + `src/services/error-classifier.ts` — `isOrchestratorError()` is exported from the classifier and reused by the retry resolver as the single canonical guard. (duplication)
- [x] [minor] legacy `src/engine/dispatch-handlers.ts` — resolved by commit `f2839d9`, which replaced the oversized module with cohesive handler modules. (file-size)
- [x] [minor] `tests/` — the current coding-standards scanner reproduced 23 `foo`/`bar` findings over scanner-covered test source files. Fixtures were renamed to descriptive values; a full `tests/` scanner pass now reports zero findings. (The historical count of 30 predates current suite contents; remaining `foo` literals live only in non-source data fixtures the scanner intentionally ignores.) (naming / tests)

## 2026-09-02 main review

- [x] [major] `src/services/run-dir.ts` (+ `src/engine/run-orchestrator.ts`, `src/engine/preflight.ts`, `src/types/config.ts`, `src/persistence/sqlite/{ownership,run-database,node-sqlite-driver,sqlite-driver}.ts`, new `src/persistence/sqlite/run-liveness.ts`, `tests/ownership/retention-cleanup.integration.test.ts`) — retention cleanup can no longer delete a RUN_DIR whose SQLite ownership is HELD with a live lease. `cleanupOldRuns()` now requires an explicit `RunDirRetentionProtection` policy and consults it with the single cleanup-pass time boundary (one `Date.now()` for both the retention threshold and every lease-liveness decision) before any deletion; the orchestrator injects `createRunRetentionProtection(nodeSqliteDriver)`, a strictly read-only inspection (`openRunDatabaseReadOnly` — never creates the DB, never runs DDL, never mutates pragmas) that reuses the ownership layer's single live-lease definition (`isOwnershipLive`: HELD + `now < lease_until_epoch_ms`, shared with the CAS acquisition path). Ambiguous states — unreadable DB, schema version mismatch, run identity mismatch, missing rows, incoherent HELD ownership — fail closed (directory kept); only proven-FREE or expired-lease runs and legacy no-DB directories remain deletable. `retentionDays` is validated in preflight as finite, integer, ≥ 0 (`0` keeps its existing meaning: "no retention delay"), so `-1`/`NaN`/`Infinity`/`1.5` are rejected before any filesystem effect. RED proof before the fix: `foreign run with live SQLite ownership survives orchestrator retention cleanup` failed on unmodified HEAD with `expected: active foreign run survives cleanup; actual: run directory was deleted` (`false !== true`) after bootstrapping a genuine HELD/live-lease DB for run B via `bootstrapNewRunAtomic`, aging its RUN_DIR by 100 days, and triggering the real cleanup through `runOrchestratorInternal`; the same test is GREEN after the fix. Edge coverage: expired lease + old → deleted; expired lease + fresh dir → kept; current run kept regardless of age; unreadable DB kept; HELD with NULL lease kept; no-DB legacy dir deleted (existing semantics preserved); another orchestrator's live-DB run untouched; `retentionDays = 0` semantics; invalid `retentionDays` rejected in preflight with no RUN_DIR deleted. Full suite 533/533, typecheck, lint, build, `test:policy`, and `test:node-package` all green. (durability / correctness)
