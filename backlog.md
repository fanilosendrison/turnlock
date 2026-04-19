# Backlog

Items triaged by loop-clean. Checked items are resolved.

## 2026-04-20 loop-clean iter-0

- [x] [major] `src/engine/dispatch-loop.ts` — file is 982 lines, exceeds 400-line threshold. Split into dispatch-loop.ts (core loop), dispatch-handlers.ts (delegate/done/fail handlers), phase-io.ts (PhaseIO builder). (structure)
- [ ] [minor] `src/services/error-classifier.ts` — classify() missing explicit exhaustive default return after switch. Fragile if OrchestratorErrorKind extended. (correctness)
- [ ] [minor] `src/services/state-io.ts:131` — readState() mutates parsedObj.data after Zod parse instead of reconstructing immutably. (correctness)
- [ ] [info] `src/services/run-dir.ts:42` — cleanupOldRuns() uses fs.rmSync instead of trash. Acceptable for ephemeral run dir cleanup. (hygiene)
- [ ] [info] `src/engine/context.ts:30` — IS_TEST module-level IIFE is immutable constant, not mutable singleton. Acceptable. (hygiene)
- [ ] [info] `src/services/logger.ts:36` — createLogger() silent catch in stderrEmit is intentional exception to I-4 for logger resilience. (correctness)
- [ ] [info] `src/services/lock.ts:62` — acquireLock() silent override on corrupted lock file lacks explanatory comment. (hygiene)
- [ ] [info] `src/engine/dispatch-loop.ts:685` — handleDone() JSON.stringify edge case for non-serializable values already handled per NIB-M-STATE-IO section 6. (correctness)
- [ ] [info] spec-drift: RetryDecision — code uses discriminated union (retry: true | false) vs spec boolean. Code is stricter than spec. Reconcile spec to match code. (spec-drift)
- [ ] [info] spec-drift: 11 generic type false positives from spec-drift tooling (DelegationBinding, Phase, PhaseIO, PhaseResult, StateFile, ValidationResult, DispatchContext). Tooling limitation, not real drift. (spec-drift-tooling)
