---
id: NIB-M-PUBLIC-API
type: nib-module
version: "1.0.0"
scope: cc-orchestrator-runtime
module: public-api
status: approved
consumers: [claude-code]
superseded_by: []
---

# NIB-M-PUBLIC-API — Surface publique (exports, `definePhase`, constantes)

**Package** : `cc-orchestrator-runtime`
**Source NX** : §5.2 (Layer 1), §6.1-§6.8 (contrat public), §5.6 (dépendances minimales)
**NIB-T associé** : §27 (C-GL-01 à C-GL-13 surface, C-ER-01 à C-ER-03 errors, C-FC-01 à C-FC-12 fail-closed), §22 (T-CP composition récursive), §22.bis (T-TM temporal)
**NIB-S référencé** : §6 (contrat public intégral), I-9 (surface stable), §5.6 (dépendances), §6.9 (fonctions + constantes)

---

## 1. Purpose

Module qui **matérialise la surface publique** du package :

1. **`src/index.ts`** — entry point npm, ré-exporte tous les types, classes, fonctions, constantes publics.
2. **`definePhase`** — helper de typage pass-through (no-op runtime, utile pour inférence TS).
3. **Constantes** `PROTOCOL_VERSION` et `STATE_SCHEMA_VERSION`.
4. **Types centraux** (`OrchestratorConfig`, `Phase`, `PhaseIO`, `PhaseResult`, `DelegationRequest` variants, `RetryPolicy`, `TimeoutPolicy`, `LoggingPolicy`, `OrchestratorLogger`, `OrchestratorEvent`) — **définis** ici (pas seulement ré-exportés) pour les types purement déclaratifs qui n'ont pas de module "propriétaire" évident.

**Principe normatif structurant — surface minimale et stable (I-9 NIB-S)** : seul ce qui est listé en §6 NIB-S est exporté. Tout service L4 interne reste interne. Toute violation (ex. export de `resolveRetryDecision` ou `SkillBinding`) = breaking du contrat.

**Fichiers cibles** :
- `src/index.ts` — entry point (ré-exports + `definePhase` + constantes)
- `src/types/config.ts` — `OrchestratorConfig`, `Clock`
- `src/types/phase.ts` — `Phase`, `PhaseIO`, `PhaseResult`
- `src/types/delegation.ts` — `DelegationRequest` variants
- `src/types/policies.ts` — `RetryPolicy`, `TimeoutPolicy`, `LoggingPolicy`
- `src/types/events.ts` — `OrchestratorLogger`, `OrchestratorEvent` union
- `src/constants.ts` — `PROTOCOL_VERSION`, `STATE_SCHEMA_VERSION`, `DEFAULT_*`

**LOC cible** : ~300-400 cumulée (la plupart des définitions de types).

---

## 2. Fichiers + contenu

### 2.1 `src/constants.ts`

```ts
export const PROTOCOL_VERSION = 1 as const;
export const STATE_SCHEMA_VERSION = 1 as const;
// Defaults réexportés depuis retry-resolver pour un seul point d'accès.
export {
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_BACKOFF_BASE_MS,
  DEFAULT_MAX_BACKOFF_MS,
} from "./services/retry-resolver";
export const DEFAULT_TIMEOUT_MS = 600_000;  // 10 min, §9.3
export const DEFAULT_RETENTION_DAYS = 7;
// DEFAULT_IDLE_LEASE_MS réexporté depuis lock.
export { DEFAULT_IDLE_LEASE_MS } from "./services/lock";
```

**Note** : les constantes `DEFAULT_*` des policies ne sont **pas** exportées publiquement. Elles vivent internes. Seules `PROTOCOL_VERSION` et `STATE_SCHEMA_VERSION` sont dans la surface publique (testé C-GL-05, C-GL-06).

### 2.2 `src/types/config.ts`

```ts
import type { ZodSchema } from "zod";
import type { Phase } from "./phase";
import type { RetryPolicy, TimeoutPolicy, LoggingPolicy } from "./policies";

export interface OrchestratorConfig<State extends object = object> {
  readonly name: string;
  readonly initial: string;
  readonly phases: Readonly<Record<string, Phase<State, any, any>>>;
  readonly initialState: State;
  readonly resumeCommand: (runId: string) => string;
  readonly stateSchema?: ZodSchema<State>;
  readonly retry?: RetryPolicy;
  readonly timeout?: TimeoutPolicy;
  readonly logging?: LoggingPolicy;
  readonly retentionDays?: number;
}

export interface Clock {
  nowWall(): Date;
  nowWallIso(): string;
  nowEpochMs(): number;
  nowMono(): number;
}
```

### 2.3 `src/types/phase.ts`

```ts
import type { ZodSchema } from "zod";
import type { Clock } from "./config";
import type { DelegationRequest, SkillDelegationRequest, AgentDelegationRequest, AgentBatchDelegationRequest } from "./delegation";
import type { OrchestratorLogger } from "./events";

export type Phase<State, Input = void, Output = void> = (
  state: State,
  io: PhaseIO<State>,
  input?: Input
) => Promise<PhaseResult<State, Output>>;

export interface PhaseIO<State extends object> {
  transition<NextInput = void>(
    nextPhase: string,
    nextState: State,
    input?: NextInput
  ): PhaseResult<State>;

  delegateSkill(req: SkillDelegationRequest, resumeAt: string, nextState: State): PhaseResult<State>;
  delegateAgent(req: AgentDelegationRequest, resumeAt: string, nextState: State): PhaseResult<State>;
  delegateAgentBatch(req: AgentBatchDelegationRequest, resumeAt: string, nextState: State): PhaseResult<State>;

  done<FinalOutput>(output: FinalOutput): PhaseResult<State>;
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

export type PhaseResult<State, Output = void> =
  | { readonly kind: "transition"; readonly nextPhase: string; readonly nextState: State; readonly input?: unknown }
  | { readonly kind: "delegate"; readonly request: DelegationRequest; readonly resumeAt: string; readonly nextState: State }
  | { readonly kind: "done"; readonly output: Output }
  | { readonly kind: "fail"; readonly error: Error };
```

### 2.4 `src/types/delegation.ts`

```ts
import type { RetryPolicy, TimeoutPolicy } from "./policies";

export type DelegationRequest =
  | SkillDelegationRequest
  | AgentDelegationRequest
  | AgentBatchDelegationRequest;

export interface SkillDelegationRequest {
  readonly kind: "skill";
  readonly skill: string;
  readonly args?: Record<string, unknown>;
  readonly label: string;
  readonly retry?: RetryPolicy;
  readonly timeout?: TimeoutPolicy;
}

export interface AgentDelegationRequest {
  readonly kind: "agent";
  readonly agentType: string;
  readonly prompt: string;
  readonly label: string;
  readonly retry?: RetryPolicy;
  readonly timeout?: TimeoutPolicy;
}

export interface AgentBatchDelegationRequest {
  readonly kind: "agent-batch";
  readonly agentType: string;
  readonly jobs: ReadonlyArray<{
    readonly id: string;
    readonly prompt: string;
  }>;
  readonly label: string;
  readonly retry?: RetryPolicy;
  readonly timeout?: TimeoutPolicy;
}
```

### 2.5 `src/types/policies.ts`

```ts
import type { OrchestratorLogger } from "./events";

export interface RetryPolicy {
  readonly maxAttempts: number;
  readonly backoffBaseMs: number;
  readonly maxBackoffMs: number;
}

export interface TimeoutPolicy {
  readonly perDelegationMs: number;
}

export interface LoggingPolicy {
  readonly logger?: OrchestratorLogger;
  readonly enabled: boolean;
  readonly persistEventLog?: boolean;
}
```

### 2.6 `src/types/events.ts`

```ts
import type { OrchestratorErrorKind } from "../errors/base";

export interface OrchestratorLogger {
  emit(event: OrchestratorEvent): void;
}

export type OrchestratorEvent =
  | { eventType: "orchestrator_start"; runId: string; orchestratorName: string; initialPhase: string; timestamp: string }
  | { eventType: "phase_start"; runId: string; phase: string; attemptCount: number; timestamp: string }
  | { eventType: "phase_end"; runId: string; phase: string; durationMs: number; resultKind: "transition" | "delegate" | "done" | "fail"; timestamp: string }
  | { eventType: "delegation_emit"; runId: string; phase: string; label: string; kind: "skill" | "agent" | "agent-batch"; jobCount: number; timestamp: string }
  | { eventType: "delegation_result_read"; runId: string; phase: string; label: string; jobCount: number; filesLoaded: number; timestamp: string }
  | { eventType: "delegation_validated"; runId: string; phase: string; label: string; timestamp: string }
  | { eventType: "delegation_validation_failed"; runId: string; phase: string; label: string; zodErrorSummary: string; timestamp: string }
  | { eventType: "retry_scheduled"; runId: string; phase: string; label: string; attempt: number; delayMs: number; reason: string; timestamp: string }
  | { eventType: "phase_error"; runId: string; phase: string; errorKind: OrchestratorErrorKind; message: string; timestamp: string }
  | { eventType: "lock_conflict"; runId: string; reason: "expired_override" | "stolen_at_release"; currentOwnerToken?: string; timestamp: string }
  | { eventType: "orchestrator_end"; runId: string; orchestratorName: string; success: boolean; durationMs: number; phasesExecuted: number; timestamp: string };
```

### 2.7 `src/index.ts` — entry point

```ts
// Entry point du package npm. Ré-exporte uniquement la surface publique §6 NIB-S.

// Fonctions principales
export { runOrchestrator } from "./engine/run-orchestrator";
export { definePhase } from "./define-phase";

// Constantes
export { PROTOCOL_VERSION, STATE_SCHEMA_VERSION } from "./constants";

// Types — config
export type { OrchestratorConfig, Clock } from "./types/config";

// Types — phase
export type { Phase, PhaseIO, PhaseResult } from "./types/phase";

// Types — delegation
export type {
  DelegationRequest,
  SkillDelegationRequest,
  AgentDelegationRequest,
  AgentBatchDelegationRequest,
} from "./types/delegation";

// Types — policies
export type { RetryPolicy, TimeoutPolicy, LoggingPolicy } from "./types/policies";

// Types — events + logger
export type { OrchestratorLogger, OrchestratorEvent } from "./types/events";

// Errors — classe abstraite + 11 concrètes + kind union
export { OrchestratorError } from "./errors/base";
export type { OrchestratorErrorKind } from "./errors/base";
export {
  InvalidConfigError,
  StateCorruptedError,
  StateMissingError,
  StateVersionMismatchError,
  DelegationTimeoutError,
  DelegationSchemaError,
  DelegationMissingResultError,
  PhaseError,
  ProtocolError,
  AbortedError,
  RunLockedError,
} from "./errors/concrete";
```

### 2.8 `src/define-phase.ts`

```ts
import type { Phase } from "./types/phase";

/**
 * Helper de typage pass-through. Utile pour l'inférence TS :
 *
 *   const myPhase = definePhase<MyState, MyInput, MyOutput>(async (state, io, input) => {
 *     return io.done({ ok: true });
 *   });
 *
 * No-op à l'exécution — retourne exactement la fonction passée.
 */
export function definePhase<State, Input = void, Output = void>(
  fn: Phase<State, Input, Output>
): Phase<State, Input, Output> {
  return fn;
}
```

**Règle** : `definePhase` est un **pass-through no-op runtime** (C-GL-11). TS l'utilise pour inférer les types Input/Output depuis les paramètres explicites. Pas de validation ni wrapping.

---

## 3. Règles transversales

### 3.1 Surface exportée — liste exhaustive (C-GL-01)

**Fonctions** : `runOrchestrator`, `definePhase`.

**Constantes** : `PROTOCOL_VERSION`, `STATE_SCHEMA_VERSION`.

**Classes** : `OrchestratorError` (abstract), 11 sous-classes concrètes.

**Types** (22) : `OrchestratorConfig`, `Phase`, `PhaseIO`, `PhaseResult`, `DelegationRequest`, `SkillDelegationRequest`, `AgentDelegationRequest`, `AgentBatchDelegationRequest`, `RetryPolicy`, `TimeoutPolicy`, `LoggingPolicy`, `OrchestratorLogger`, `OrchestratorEvent`, `OrchestratorErrorKind`, `Clock`.

### 3.2 Non-exportés (C-GL-02)

Explicitement interdits dans `src/index.ts` :
- Services L4 : `clock` singleton, `generateRunId`, `abortableSleep`, `readState`, `writeStateAtomic`, `resolveRunDir`, `cleanupOldRuns`, `writeProtocolBlock`, `parseProtocolBlock`, `validateResult`, `summarizeZodError`, `resolveRetryDecision`, `classify`, `createLogger`, `acquireLock`, `refreshLock`, `releaseLock`.
- Bindings : `skillBinding`, `agentBinding`, `agentBatchBinding`, `DelegationBinding`, `DelegationManifest`.
- Engine internals : `runDispatchLoop`, `runHandleResume`, `DispatchContext`, `LoadedResults`, `LockHandle`, `StateFile`, `PendingDelegationRecord`.
- Constantes internes : `DEFAULT_MAX_ATTEMPTS`, `DEFAULT_BACKOFF_BASE_MS`, `DEFAULT_MAX_BACKOFF_MS`, `DEFAULT_TIMEOUT_MS`, `DEFAULT_RETENTION_DAYS`, `DEFAULT_IDLE_LEASE_MS`, `MANIFEST_VERSION`.

**Test C-GL-02** vérifie que le module `cc-orchestrator-runtime` n'expose pas ces symboles.

### 3.3 Types exportés en `type` uniquement (pas valeurs runtime)

Tous les `export type { ... }` sont effacés à la compilation (TS type-only export). N'apparaissent pas dans le JS compilé. Les consommateurs peuvent les utiliser pour typer leurs orchestrateurs sans runtime overhead.

### 3.4 `ValidationPolicy` n'existe pas (C-GL-03)

Conformément à M12 (v0.5 NX) : la validation passe exclusivement via les schémas zod fournis à `consumePending*`. Aucun `ValidationPolicy` dans la surface publique.

### 3.5 `OrchestratorErrorKind` fermé (C-GL-12, C-GL-13)

Union de **11** valeurs exactes listées en §6.6 NIB-S. Toute addition = breaking change. Chaque sous-classe d'erreur a un `kind` littéral correspondant à une de ces 11 valeurs.

### 3.6 Dépendances minimales (C-GL-07, C-GL-08)

`package.json` `dependencies` contient **exactement** :

```json
{
  "dependencies": {
    "zod": "^3.x",
    "ulid": "^2.x"
  }
}
```

Aucune sous-dépendance ne doit apporter d'API visible au consommateur (isolé). Testé par inspection du `package.json` (C-GL-07).

### 3.7 Typage `OrchestratorConfig<State>` (C-GL-09, C-GL-10)

- `OrchestratorConfig<State extends object = object>` — accepte `State` générique avec défaut `object`.
- `Phase<State, Input, Output>` — 3 génériques optionnels (Input/Output default to void).
- Compile sur `OrchestratorConfig<MyState>` typé.

---

## 4. Patterns ergonomiques attendus (pour les consommateurs)

### 4.1 Définition d'un orchestrateur

```ts
import { runOrchestrator, definePhase, type OrchestratorConfig } from "cc-orchestrator-runtime";
import { z } from "zod";

interface MyState {
  readonly count: number;
}

const phases = {
  "start": definePhase<MyState>(async (state, io) => {
    return io.transition("work", { count: state.count + 1 });
  }),
  "work": definePhase<MyState>(async (state, io) => {
    return io.delegateSkill(
      { kind: "skill", skill: "my-skill", label: "main", args: { foo: "bar" } },
      "done",
      { ...state, count: state.count + 1 }
    );
  }),
  "done": definePhase<MyState>(async (state, io) => {
    const result = io.consumePendingResult(z.object({ verdict: z.string() }));
    return io.done({ verdict: result.verdict, count: state.count });
  }),
};

const config: OrchestratorConfig<MyState> = {
  name: "my-orchestrator",
  initial: "start",
  phases,
  initialState: { count: 0 },
  resumeCommand: (runId) => `bun run ./main.ts --run-id ${runId} --resume`,
  stateSchema: z.object({ count: z.number() }),
};

runOrchestrator(config);
// La Promise résout quand le process exit, jamais rejette.
```

### 4.2 Custom logger

```ts
import type { OrchestratorLogger, OrchestratorEvent } from "cc-orchestrator-runtime";

const sink: OrchestratorEvent[] = [];
const customLogger: OrchestratorLogger = { emit: (ev) => sink.push(ev) };

runOrchestrator({
  ...config,
  logging: { enabled: true, logger: customLogger, persistEventLog: false },
});
```

### 4.3 Inspection d'erreur côté catch (pour consommateurs avancés)

```ts
import { RunLockedError, OrchestratorError } from "cc-orchestrator-runtime";

// Attention : runOrchestrator ne reject JAMAIS. Cette section n'est JAMAIS exécutée.
// Le pattern est uniquement pour un consommateur qui compose (wrappper higher-order).
// try {
//   await runOrchestrator(config);
// } catch (err) {
//   if (err instanceof RunLockedError) { ... }
// }
```

**Note importante** : la Promise de `runOrchestrator` ne rejette jamais (fail-closed I-4). Les erreurs sont exposées via le **bloc ERROR sur stdout** + exit code. Les consommateurs qui veulent inspecter doivent parser le bloc protocole.

---

## 5. Tests NIB-T

| Groupe | Tests |
|---|---|
| Surface publique | C-GL-01 (exports exacts), C-GL-02 (non-exports), C-GL-03 (pas de ValidationPolicy) |
| Classes d'erreur | C-GL-04 (tous instanceof OrchestratorError), C-ER-01/02/03 |
| Constantes | C-GL-05 (PROTOCOL_VERSION === 1), C-GL-06 (STATE_SCHEMA_VERSION === 1) |
| Dépendances | C-GL-07 (zod + ulid uniquement), C-GL-08 (pas de sous-dep visible) |
| Typage | C-GL-09 (OrchestratorConfig<State>), C-GL-10 (Phase<State, Input, Output>), C-GL-11 (definePhase pass-through) |
| Union kind fermée | C-GL-12 (11 valeurs exactes), C-GL-13 (mapping kind ↔ classe) |
| Fail-closed | C-FC-01 à C-FC-12 (tous les cas couverts par l'engine, testés via la surface publique) |
| Composition récursive | T-CP-01 à T-CP-03, P-CP-a/b (§22) |
| Temporal | T-TM-01 à T-TM-12, P-TM-a/b/c/d (§22.bis) |

---

## 6. Constraints

- **Fichiers purement déclaratifs sauf `definePhase` et `run-orchestrator`** (déjà dans NIB-M-RUN-ORCHESTRATOR).
- **Aucune logique dans `src/index.ts`** — seulement `export`. Les ré-exports sont élidés à la compilation TS.
- **`definePhase` no-op pur** — `function(fn) { return fn; }`. Pas de typeof checks, pas de wrapping.
- **Pas d'import de `z.object`** ou de zod runtime dans les types publics — uniquement `import type { ZodSchema }`. Les consommateurs importent zod eux-mêmes.
- **`package.json` `main`, `types`, `exports`** configurés pour pointer vers `./dist/index.js` + `./dist/index.d.ts`.
- **Aucun side effect** à l'import du package (pas de code qui s'exécute au `import` autre que l'évaluation des modules TypeScript ESM standard).

---

## 7. Integration snippets

### 7.1 Package.json minimal

```json
{
  "name": "cc-orchestrator-runtime",
  "version": "0.1.0",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "types": "./dist/index.d.ts"
    }
  },
  "dependencies": {
    "zod": "^3.22.0",
    "ulid": "^2.3.0"
  },
  "engines": {
    "node": ">=22"
  }
}
```

---

## 8. Definition of Done (DoD)

1. **7 fichiers créés** :
   - `src/index.ts` (entry point ré-exports)
   - `src/constants.ts`
   - `src/define-phase.ts`
   - `src/types/config.ts`
   - `src/types/phase.ts`
   - `src/types/delegation.ts`
   - `src/types/policies.ts`
   - `src/types/events.ts`
2. **`src/index.ts`** ré-exporte exactement la surface §3.1 (ni plus, ni moins).
3. **`definePhase`** pass-through no-op.
4. **`PROTOCOL_VERSION = 1 as const`** et `STATE_SCHEMA_VERSION = 1 as const`.
5. **Types centraux** définis dans `src/types/*` — pas dupliqués ailleurs.
6. **Aucun symbole non-public** ré-exporté (C-GL-02).
7. **`OrchestratorErrorKind`** union de 11 valeurs exactement (C-GL-12).
8. **`package.json` `dependencies`** : zod + ulid uniquement (C-GL-07).
9. **Tests NIB-T** : §27 (C-GL + C-ER + C-FC), §22 (T-CP), §22.bis (T-TM).
10. **LOC cumulée** : 300-400 (surtout déclarations de types).

---

## 9. Relation avec les autres NIB-M

- **Consomme** :
  - `NIB-M-RUN-ORCHESTRATOR` (`runOrchestrator` ré-exporté)
  - `NIB-M-ERRORS` (classes ré-exportées)
  - Services L4 uniquement pour constantes internes (DEFAULT_*) — non ré-exportées
- **Consommé par** : le consommateur final du package npm.
- **Fixe les types** consommés par :
  - `NIB-M-DISPATCH-LOOP` (types `PhaseIO`, `PhaseResult`, `OrchestratorConfig`)
  - `NIB-M-HANDLE-RESUME` (mêmes)
  - `NIB-M-BINDINGS` (`DelegationRequest` variants)
  - `NIB-M-LOGGER` (`OrchestratorEvent`, `LoggingPolicy`)

---

## 10. Metadata

| Champ | Valeur |
|---|---|
| Source NX | §5.2, §5.6, §6 (intégral), §6.9 |
| NIB-T associé | §27 (C-GL, C-ER, C-FC), §22 (T-CP), §22.bis (T-TM) |
| Invariants NIB-S couverts | I-9 (surface stable), §6 (contrat public complet) |
| Fichiers produits | 8 fichiers (index + constants + define-phase + 5 types) |
| LOC cible | 300-400 cumulée |
| Exporté publiquement | oui — **c'est** la surface publique |

---

*cc-orchestrator-runtime — Implicit-Free Execution — "Reliability precedes intelligence."*
