---
id: NIB-S-TURNLOCK
type: nib-system
version: "2.0.0"
scope: turnlock
status: approved
consumers: [claude-code]
superseded_by: []
validates: ["src/**/*.ts", "tests/contracts/**/*.test.ts", "tests/properties/**/*.test.ts"]
---

# NIB-S-TURNLOCK — System Brief

**Package**: `turnlock`
**Status**: v2.0 — yield-only phase model.
**NIB-T associated**: `specs/briefs/NIB-T-TURNLOCK.md`

---

## 1. Purpose

`turnlock` is a durable TypeScript runtime for host-assisted workflows. It runs a typed FSM one phase at a time, persists stable state atomically to `state.json`, emits protocol blocks on `stdout` only at yield points, and exits so an external host can perform delegated work and resume the run.

The runtime is host-neutral. It does not know Claude Code, Codex, skills, or agents. It emits opaque delegation manifests and protocol blocks; a parent process interprets them.

## 2. Canonical Model

A turnlock phase is the mechanical span executed between two yields.

Each process invocation executes exactly one phase. A phase must finish by returning exactly one of:

- `io.delegate(...)`
- `io.delegateBatch(...)`
- `io.done(...)`
- `io.fail(...)`

There is no in-process phase-to-phase hop. Chaining happens only by delegation `resumeAt`: the runtime emits a `DELEGATE` block, exits, and the host later resumes the run at the requested phase after writing result files.

Terminal yields (`done`, `fail`) also end the process. Initial runs that complete in one phase emit `DONE` or `ERROR` immediately.

## 3. Core Properties

- **Snapshot-authoritative**: `state.json` is the only durable source of truth for run state. Event logs are audit trails, not replay sources.
- **Fail-closed**: every runtime error is converted into a structured `ERROR` protocol block whenever a run context exists.
- **JSON-only**: state, manifests, result files, events, and protocol payloads are JSON-compatible.
- **Minimal runtime dependencies**: only `zod` and `ulid` are runtime dependencies.
- **Mechanical determinism**: retry, timeout, validation, and dispatch decisions are explicit data-driven decisions.

## 4. Public Contract

Public exports:

- `runOrchestrator(config)`
- `definePhase(fn)`
- Types: `OrchestratorConfig`, `Clock`, `Phase`, `PhaseIO`, `PhaseResult`, delegation request types, policy types, logger/event types.
- Errors: `OrchestratorError` and the concrete error classes.
- Constants: `PROTOCOL_VERSION`, `STATE_SCHEMA_VERSION`.

`Phase<State, Output = unknown>` has the signature:

```ts
type Phase<State extends object, Output = unknown> = (
  state: State,
  io: PhaseIO<State>,
) => Promise<PhaseResult<State, Output>>;
```

`PhaseIO<State>` exposes:

```ts
interface PhaseIO<State extends object> {
  delegate(
    req: PromptDelegationRequest,
    resumeAt: string,
    nextState: State,
  ): PhaseResult<State>;

  delegateBatch(
    req: BatchDelegationRequest,
    resumeAt: string,
    nextState: State,
  ): PhaseResult<State>;

  done<FinalOutput>(output: FinalOutput): PhaseResult<State, FinalOutput>;
  fail(error: Error): PhaseResult<State>;

  readonly logger: OrchestratorLogger;
  readonly clock: Clock;
  readonly runId: string;
  readonly args: readonly string[];
  readonly runDir: string;
  readonly signal: AbortSignal;

  consumePendingResult<T>(schema: ZodSchema<T>): T;
  consumePendingBatchResults<T>(schema: ZodSchema<T>): readonly T[];
  refreshLock(): void;
}
```

`PhaseResult` is a closed union:

```ts
type PhaseResult<State extends object, Output = unknown> =
  | {
      readonly kind: "delegate";
      readonly request: DelegationRequest;
      readonly resumeAt: string;
      readonly nextState: State;
    }
  | { readonly kind: "done"; readonly output: Output }
  | { readonly kind: "fail"; readonly error: Error };
```

## 5. State

`StateFile<State>` remains schema version 2:

```ts
interface StateFile<State> {
  readonly schemaVersion: typeof STATE_SCHEMA_VERSION;
  readonly runId: string;
  readonly orchestratorName: string;
  readonly startedAt: string;
  readonly startedAtEpochMs: number;
  readonly lastTransitionAt: string;
  readonly lastTransitionAtEpochMs: number;
  readonly currentPhase: string;
  readonly phasesExecuted: number;
  readonly accumulatedDurationMs: number;
  readonly data: State;
  readonly pendingDelegation?: PendingDelegationRecord;
  readonly usedLabels: readonly string[];
}
```

The `lastTransitionAt` field name is retained for schema compatibility. It is not renamed in this model change.

## 6. Protocol

The stdout protocol remains closed:

- `DELEGATE`: emitted for `PhaseResult.kind === "delegate"`, exit code 0.
- `DONE`: emitted for `PhaseResult.kind === "done"`, exit code 0.
- `ERROR`: emitted for `PhaseResult.kind === "fail"` or runtime failures, non-zero exit except configured lock conflicts.
- `ABORTED`: emitted on managed signal abort.

No other action is valid. `stdout` is reserved exclusively for these protocol blocks.

## 7. Events

The observable event taxonomy remains 11 variants:

- `orchestrator_start`
- `phase_start`
- `phase_end`
- `delegation_emit`
- `delegation_result_read`
- `delegation_validated`
- `delegation_validation_failed`
- `retry_scheduled`
- `phase_error`
- `lock_conflict`
- `orchestrator_end`

`phase_end.resultKind` is restricted to `"delegate" | "done" | "fail"`.

## 8. Runtime Invariants

- Every phase receives a deep-frozen clone of `state.data`.
- Every phase can commit only one `PhaseResult`; a second `io.*` commit throws `ProtocolError`.
- A resumed phase with loaded delegation results must consume exactly one pending result via the matching `consumePending*` method.
- `pendingDelegation` is cleared only when the resumed phase successfully returns a new `PhaseResult` handled by the engine.
- All state writes are atomic tmp-and-rename writes.
- The run lock is acquired with O_EXCL and released before every managed exit.
- Unknown or malformed committed result kinds fail closed with `ProtocolError`.

## 9. Architecture

- `src/types`: pure public types.
- `src/errors`: pure error taxonomy.
- `src/bindings`: manifest and protocol construction for delegation kinds.
- `src/services`: filesystem, protocol, lock, logger, clock, validation, retry, run directory, and IDs.
- `src/engine`: `runOrchestrator`, resume handling, one-phase dispatch, `PhaseIO` construction, and result handlers.

The engine executes one phase per invocation. `handle-resume` prepares loaded result data and enters the same one-phase dispatch path at `pendingDelegation.resumeAt`.

## 10. Verification

Required checks before accepting implementation changes:

```bash
bun test
bunx biome check src/ tests/
bun tsc --noEmit
```
