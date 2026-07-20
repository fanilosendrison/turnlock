---
id: NIB-M-DISPATCH-LOOP
type: nib-module
version: "2.0.0"
scope: turnlock
module: dispatch-loop
status: approved
consumers: [claude-code]
superseded_by: []
validates: ["src/engine/dispatch-loop.ts", "src/engine/delegate-handler.ts", "src/engine/delegation-reemit.ts", "src/engine/terminal-handlers.ts", "src/engine/phase-io.ts", "src/engine/context.ts", "src/engine/shared.ts", "src/types/phase.ts", "tests/engine/run-composition.test.ts", "tests/engine/run-deep-freeze.test.ts", "tests/engine/run-per-attempt-isolation.test.ts", "tests/integration/ping-pong.test.ts"]
---

# NIB-M-DISPATCH-LOOP — One-Phase Dispatch

**Package**: `turnlock`
**System brief**: `NIB-S-TURNLOCK`

---

## 1. Purpose

This module executes exactly one phase for the current process invocation, handles the resulting yield, writes durable state, emits observable events/protocol blocks, releases the run lock, and exits.

Covered files:

- `src/engine/dispatch-loop.ts`
- `src/engine/phase-io.ts`
- `src/engine/delegate-handler.ts`
- `src/engine/delegation-reemit.ts`
- `src/engine/terminal-handlers.ts`
- `src/engine/context.ts`
- `src/engine/shared.ts`
- `src/types/phase.ts`

## 2. Signature

```ts
export async function runDispatchLoop<S extends object>(
  ctx: DispatchContext<S>,
  state: StateFile<S>,
  loadedResults?: LoadedResults,
): Promise<never>;

export interface LoadedResults {
  readonly label: string;
  readonly kind: "prompt" | "batch";
  readonly data: unknown | readonly unknown[];
}
```

The function never returns during normal runtime execution. It exits through protocol handlers. In tests, `doExit` throws a controlled test signal.

## 3. Algorithm

`runDispatchLoop` performs these steps in order:

1. Read `state.currentPhase` and set `ctx.currentPhase`.
2. Resolve the phase from `ctx.config.phases`.
3. Throw `ProtocolError` if the phase does not exist.
4. Refresh the run lock.
5. Create per-phase guards:
   - `committed`
   - `committedResult`
   - `consumedCount`
6. Capture `pendingDelegation` at phase entry.
7. Determine whether this invocation is a resume phase with matching loaded results.
8. Deep-clone and deep-freeze `state.data`.
9. Build `PhaseIO`.
10. Emit `phase_start`.
11. Execute the phase.
12. Require exactly one committed `PhaseResult`; otherwise throw `PhaseError`.
13. If a `DelegationSchemaError` occurs during result consumption and retry budget remains, execute the retry branch.
14. Otherwise convert exceptions through `emitFatalError`.
15. Compute phase duration and new accumulated duration.
16. For resume phases, require exactly one consume call.
17. Validate that the committed result kind is one of `delegate`, `done`, or `fail`.
18. Emit `phase_end`.
19. Dispatch to the matching result handler.

No step loops back to another phase in the same process.

## 4. PhaseIO Construction

`buildPhaseIO` creates the object passed to phases.

Commit methods:

- `delegate(request, resumeAt, nextState)`
- `delegateBatch(request, resumeAt, nextState)`
- `done(output)`
- `fail(error)`

Each commit method:

1. Checks the `committed` guard.
2. Throws `ProtocolError("PhaseResult already committed")` on a second commit.
3. Stores the committed result.
4. Returns the result for the phase to return.

Utility methods and fields:

- `consumePendingResult(schema)`
- `consumePendingBatchResults(schema)`
- `refreshLock()`
- `logger`
- `clock`
- `runId`
- `args`
- `runDir`
- `signal`

## 5. Deep Freeze

The state passed to a phase is a structured clone of `state.data`, frozen recursively. Mutation attempts fail at runtime. Authors must return new state through `delegate` or `delegateBatch`.

## 6. Result Consumption

`consumePendingResult` is valid only for non-batch pending delegations. `consumePendingBatchResults` is valid only for batch pending delegations.

Rules:

- Calling either method without a pending delegation throws `ProtocolError`.
- Calling the wrong method for the pending kind throws `ProtocolError`.
- Calling more than once throws `ProtocolError`.
- Missing loaded result data throws `DelegationMissingResultError`.
- Zod validation failure emits `delegation_validation_failed` and throws `DelegationSchemaError`.
- Successful validation emits `delegation_validated`.

After a resumed phase returns, the dispatch loop verifies that exactly one consume call occurred.

## 7. Delegate Handler

`handleDelegate`:

1. Validates `resumeAt` against configured phase keys.
2. Validates label format and label uniqueness.
3. Validates batch job IDs.
4. Resolves effective retry and timeout policies.
5. Builds the delegation manifest.
6. Writes the manifest atomically.
7. Writes `state.json` with:
   - `data = result.nextState`
   - `phasesExecuted + 1`
   - updated `lastTransitionAt`
   - updated `pendingDelegation`
   - appended `usedLabels`
8. Emits `delegation_emit`.
9. Writes a `DELEGATE` protocol block to stdout.
10. Releases the lock.
11. Exits 0.

If this is a resumed phase, the previous `pendingDelegation` is replaced by the new one.

## 8. Done Handler

`handleDone`:

1. Serializes the output to JSON.
2. Writes `output.json` atomically.
3. Writes `state.json` with:
   - `phasesExecuted + 1`
   - accumulated duration
   - no `pendingDelegation`
4. Emits `orchestrator_end` with `success: true`.
5. Writes a `DONE` protocol block to stdout.
6. Releases the lock.
7. Exits 0.

## 9. Fail Handler

`handleFail`:

1. Classifies the error kind.
2. Writes `state.json` with:
   - `phasesExecuted + 1`
   - accumulated duration
   - no `pendingDelegation`
3. Emits `phase_error`.
4. Emits `orchestrator_end` with `success: false`.
5. Writes an `ERROR` protocol block to stdout.
6. Releases the lock.
7. Exits 1.

## 10. Retry Branch

When result validation fails inside a resumed phase, `reemitDelegationAttempt` may re-emit the same delegation with a bumped attempt. This helper lives in `src/engine/delegation-reemit.ts` and is shared with `handle-resume`.

1. Emit `retry_scheduled`.
2. Sleep according to the resolved retry decision.
3. Read the previous manifest.
4. Reconstruct a new manifest with attempt-specific paths.
5. Atomically write the manifest.
6. Atomically update `state.json` with the new pending delegation metadata.
7. Emit `delegation_emit`.
8. Write `DELEGATE`.
9. Release the lock.
10. Exit 0.

## 11. Fatal Error Path

`emitFatalError` wraps unknown errors as `PhaseError`, enriches them with run context, persists the current state best-effort, emits `phase_error` and `orchestrator_end`, writes an `ERROR` protocol block, releases the lock, and exits 1.

## 12. Malformed Result Kind

The TypeScript union is closed, but runtime values can be mutated or cast unsafely. After phase execution and before `phase_end`, the dispatch loop must verify the committed kind. Unknown values fail closed through `ProtocolError`.

## 13. Non-Goals

- No in-process chaining to another phase.
- No persisted in-memory input channel between phases.
- No host-specific delegation execution.
- No stdout output outside protocol blocks.
