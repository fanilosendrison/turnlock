---
id: NIB-M-PUBLIC-API
type: nib-module
version: "2.0.0"
scope: turnlock
module: public-api
status: approved
consumers: [claude-code]
superseded_by: []
validates: ["src/index.ts", "src/define-phase.ts", "src/constants.ts", "src/types/**/*.ts", "tests/contracts/surface.test.ts"]
---

# NIB-M-PUBLIC-API — Public Surface

**Package**: `turnlock`
**System brief**: `NIB-S-TURNLOCK`

---

## 1. Purpose

This module defines the package surface consumed by orchestrator authors and host integrations. Internal services remain private.

Files covered:

- `src/index.ts`
- `src/define-phase.ts`
- `src/constants.ts`
- `src/types/config.ts`
- `src/types/phase.ts`
- `src/types/delegation.ts`
- `src/types/events.ts`
- `src/types/policies.ts`

## 2. Exported Values

`src/index.ts` exports:

- `runOrchestrator`
- `definePhase`
- `OrchestratorError`
- concrete error classes
- `PROTOCOL_VERSION`
- `STATE_SCHEMA_VERSION`

It type-exports:

- `Clock`
- `OrchestratorConfig`
- `Phase`
- `PhaseIO`
- `PhaseResult`
- delegation request types
- `OrchestratorEvent`
- `OrchestratorLogger`
- policy types
- `OrchestratorErrorKind`

No engine service, filesystem service, protocol parser, lock primitive, logger implementation, validator, retry resolver, or run-directory helper is public.

## 3. Constants

```ts
export const PROTOCOL_VERSION = 2 as const;
export const STATE_SCHEMA_VERSION = 2 as const;
```

Only these two constants are part of the public package contract.

## 4. OrchestratorConfig

```ts
export interface OrchestratorConfig<State extends object = object> {
  readonly name: string;
  readonly initial: string;
  readonly phases: Readonly<Record<string, Phase<State, unknown>>>;
  readonly initialState: State;
  readonly resumeCommand: (runId: string) => string;
  readonly stateSchema?: ZodSchema<State>;
  readonly retry?: RetryPolicy;
  readonly timeout?: TimeoutPolicy;
  readonly logging?: LoggingPolicy;
  readonly retentionDays?: number;
  readonly runDirRoot?: string;
}
```

Rules:

- `name`, `initial`, and phase keys are kebab-case.
- `initial` must be present in `phases`.
- `initialState` is required.
- `resumeCommand` is required and must return the command the host uses with `--run-id <id> --resume`.
- `runDirRoot` is optional and participates in run-directory resolution.

## 5. Phase

```ts
export type Phase<
  State extends object = object,
  Output = unknown,
> = (
  state: State,
  io: PhaseIO<State>,
) => Promise<PhaseResult<State, Output>>;
```

`Phase<State>` pins state and leaves output unconstrained. `Phase<State, Output>` pins terminal output for authors that want stricter local typing.

There is no in-process input channel in the phase signature.

## 6. PhaseIO

```ts
export interface PhaseIO<State extends object> {
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

`delegate` is used for prompt-style delegations. `delegateBatch` is used for batch delegations. Both persist `nextState`, set the next phase through `resumeAt`, emit `DELEGATE`, and exit.

`done` emits `DONE` and exits. `fail` emits `ERROR` and exits.

## 7. PhaseResult

```ts
export type PhaseResult<State extends object = object, Output = unknown> =
  | {
      readonly kind: "delegate";
      readonly request: DelegationRequest;
      readonly resumeAt: string;
      readonly nextState: State;
    }
  | { readonly kind: "done"; readonly output: Output }
  | { readonly kind: "fail"; readonly error: Error };
```

The union is closed. Runtime code must fail closed on any malformed committed `kind`.

## 8. Delegation Types

Delegation requests are JSON-compatible descriptions of host work. The runtime treats prompts, workers, job IDs, and labels as opaque data except for structural validation and label uniqueness.

`DelegationRequest` is the union of:

- `PromptDelegationRequest`
- `BatchDelegationRequest`

## 9. Events

`OrchestratorEvent` is the public observable event union. The `phase_end` event has:

```ts
{
  eventType: "phase_end";
  runId: string;
  phase: string;
  durationMs: number;
  resultKind: "delegate" | "done" | "fail";
  timestamp: string;
}
```

## 10. definePhase

```ts
export function definePhase<
  State extends object = object,
  Output = unknown,
>(fn: Phase<State, Output>): Phase<State, Output> {
  return fn;
}
```

`definePhase` is a runtime no-op. Its only purpose is local TypeScript inference and readability.

## 11. Public Surface Tests

Required coverage:

- exact runtime exports
- forbidden internal exports
- constants values
- dependency policy (`zod`, `ulid` only)
- `Phase<State, Output>` compile behavior
- absence of removed `PhaseIO` methods
- `definePhase` pass-through behavior
- closed error kind mapping
