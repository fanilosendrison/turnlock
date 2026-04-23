---
id: NIB-M-RUN-ORCHESTRATOR
type: nib-module
version: "1.0.0"
scope: turnlock
module: run-orchestrator
status: approved
consumers: [claude-code]
superseded_by: []
validates: ["src/engine/run-orchestrator.ts", "src/types/config.ts", "tests/engine/run-initial-happy-path.test.ts", "tests/engine/run-preflight-errors.test.ts", "tests/engine/run-signals.test.ts", "tests/contracts/fail-closed.test.ts"]
---

# NIB-M-RUN-ORCHESTRATOR — Entry point `runOrchestrator` + préflight + mode dispatch

**Package** : `turnlock`
**Source NX** : §4.4 (fail-closed + preflight errors), §14.1 steps 1-15 (initial), §14.2 steps 1-10 (resume préflight), §13.1-§13.2 (SIGINT/SIGTERM handler)
**NIB-T associé** : §20 (T-PF-01 à T-PF-21 préflight), §15.1 (T-RO-01 happy path entry), §17.6 (T-RS-19 à T-RS-23 resume préflight state)
**NIB-S référencé** : §6.1 (OrchestratorConfig validation), §6.9 (runOrchestrator signature), I-4 (fail-closed), I-7 (abort propagé), I-11 (lock per run), P-OWNER-ONLY-LOG

---

## 1. Purpose

**Entry point unique** `runOrchestrator(config): Promise<void>`. Son rôle :

1. **Préflight config** — valider `OrchestratorConfig` + émettre ERROR preflight si invalide.
2. **Parse argv** — détecter `--resume` + `--run-id`, dispatcher vers le flux initial ou resume.
3. **Mode initial** (§14.1 steps 1-15 NX) — générer runId, résoudre RUN_DIR, acquire lock, init state, cleanup, appel du dispatch-loop.
4. **Mode resume** (§14.2 steps 1-10 NX) — préflight resume (read state, validate, lock), puis délégué à `handle-resume` pour la classification des résultats et l'entrée dans le dispatch-loop.
5. **Handler SIGINT/SIGTERM** — émettre ABORTED + release lock + exit 130/143.
6. **Top-level `try/catch` fail-closed** (I-4, C13 NX) — toute exception est convertie en bloc ERROR + exit, la Promise résout sans rejeter.

**Principe normatif structurant — fail-closed universel (I-4)** : la Promise retournée par `runOrchestrator()` **ne rejette jamais** à l'appelant. Tout throw interne est capté par le top-level handler, converti en bloc ERROR (avec `run_id: null` si pas encore généré) + `process.exit(1)` (ou 2 pour RunLocked).

**Fichier cible** : `src/engine/run-orchestrator.ts`

**LOC cible** : ~350-500.

---

## 2. Signature

```ts
import type { OrchestratorConfig } from "../types/config";

export async function runOrchestrator<State extends object>(
  config: OrchestratorConfig<State>
): Promise<void>;
```

**Contrat** : retourne une Promise qui **résout toujours** (jamais rejette). Le process exit via `process.exit(code)` à la fin de chaque invocation.

---

## 3. Algorithme — mode dispatching

### 3.1 Structure générale

```ts
export async function runOrchestrator<S extends object>(config: OrchestratorConfig<S>): Promise<void> {
  // Top-level try/catch : toute exception → bloc ERROR + exit.
  try {
    // Step 1 : préflight config validation
    validateConfig(config);  // throw InvalidConfigError si invalide

    // Step 2 : parse argv
    const argv = parseArgv(process.argv.slice(2));
    const isResumeMode = argv.resume === true;

    if (isResumeMode) {
      await runResumeMode(config, argv);  // délègue à handle-resume
    } else {
      await runInitialMode(config, argv);  // §14.1 steps 3-15 + dispatch-loop
    }
    // Jamais atteint : les branches appellent process.exit.
  } catch (err) {
    handleTopLevelError(err, config);  // émet ERROR + exit
  }
}
```

### 3.2 Fonction `validateConfig` (préflight §14.1 step 1)

```ts
function validateConfig<S>(config: OrchestratorConfig<S>): void {
  // §6.1 règles :
  // - name regex /^[a-z][a-z0-9-]*$/ (T-PF-01, T-PF-02)
  // - phases non-vide (T-PF-03)
  // - initial présent dans phases (T-PF-04)
  // - initialState défini (T-PF-05)
  // - resumeCommand est une fonction (T-PF-06, T-PF-07)
  // - clés de phases kebab-case
  const nameRegex = /^[a-z][a-z0-9-]*$/;
  if (typeof config.name !== "string" || !nameRegex.test(config.name)) {
    throw new InvalidConfigError(`config.name invalid (kebab-case required): ${String(config.name)}`);
  }
  if (typeof config.phases !== "object" || config.phases === null) {
    throw new InvalidConfigError("config.phases must be an object");
  }
  const phaseKeys = Object.keys(config.phases);
  if (phaseKeys.length === 0) {
    throw new InvalidConfigError("config.phases cannot be empty");
  }
  for (const key of phaseKeys) {
    if (!nameRegex.test(key)) {
      throw new InvalidConfigError(`phase name invalid (kebab-case required): ${key}`);
    }
  }
  if (typeof config.initial !== "string" || !(config.initial in config.phases)) {
    throw new InvalidConfigError(`config.initial "${config.initial}" not in phases`);
  }
  if (config.initialState === undefined) {
    throw new InvalidConfigError("config.initialState is required");
  }
  if (typeof config.resumeCommand !== "function") {
    throw new InvalidConfigError("config.resumeCommand is required (must be a function)");
  }
  // stateSchema validation de initialState — différé à runInitialMode (besoin du stateSchema résolu).
}
```

### 3.3 Fonction `parseArgv`

```ts
interface ParsedArgv {
  readonly resume: boolean;
  readonly runId?: string;
  readonly rest: readonly string[];  // argv après filtrage --resume et --run-id
}

function parseArgv(args: readonly string[]): ParsedArgv {
  let resume = false;
  let runId: string | undefined;
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--resume") { resume = true; continue; }
    if (args[i] === "--run-id") {
      runId = args[i + 1];
      i++;  // skip value
      continue;
    }
    rest.push(args[i]);
  }
  return { resume, runId, rest };
}
```

**Règles** :

- `--resume` booléen.
- `--run-id <value>` optionnel en mode initial (si absent → généré). Obligatoire en mode resume.
- `rest` contient les autres args (passés à `PhaseIO.args`).
- **Pas de validation de format ULID** ici — le runtime accepte `--run-id` tel quel (§15 T-RO-12 : **DÉCISION** : pas de validation format v1).

### 3.4 Mode initial — `runInitialMode`

Implémente §14.1 steps 3-15 + appel au dispatch-loop.

```ts
async function runInitialMode<S>(config: OrchestratorConfig<S>, argv: ParsedArgv): Promise<void> {
  // Step 3 : générer/adopter runId.
  const runId = argv.runId ?? generateRunId();

  // Step 4 : résoudre RUN_DIR.
  const cwd = process.cwd();
  const runDir = resolveRunDir(cwd, config.name, runId);

  // Step 5 : créer RUN_DIR + sous-dossiers (mkdirSync recursive: true).
  fs.mkdirSync(runDir, { recursive: true });
  fs.mkdirSync(path.join(runDir, "delegations"), { recursive: true });
  fs.mkdirSync(path.join(runDir, "results"), { recursive: true });

  // Step 6 : install stderr logger uniquement (pas encore events.ndjson).
  const logger = createLogger(config.logging);

  // Step 7 : acquire lock.
  const lockPath = path.join(runDir, ".lock");
  let handle: LockHandle;
  try {
    handle = acquireLock(lockPath, clock, logger, runId);
  } catch (err) {
    if (err instanceof RunLockedError) {
      // Préflight RunLockedError : émettre phase_error (stderr only) + bloc ERROR + exit 2.
      emitRunLockedError(err, config, runId, logger);
      process.exit(2);
    }
    throw err;
  }

  // Step 7 bis : activer events.ndjson logger (owner-only).
  logger.enableDiskEmit(path.join(runDir, "events.ndjson"));

  // Step 8 : capture temporal.
  const nowEpoch = clock.nowEpochMs();
  const nowIso = clock.nowWallIso();

  // Step 9 : log orchestrator_start.
  logger.emit({
    eventType: "orchestrator_start",
    runId,
    orchestratorName: config.name,
    initialPhase: config.initial,
    timestamp: nowIso,
  });

  // Step 10-11 : construire StateFile initial.
  const initialState: StateFile<S> = {
    schemaVersion: 1,
    runId,
    orchestratorName: config.name,
    startedAt: nowIso,
    startedAtEpochMs: nowEpoch,
    lastTransitionAt: nowIso,
    lastTransitionAtEpochMs: nowEpoch,
    currentPhase: config.initial,
    phasesExecuted: 0,
    accumulatedDurationMs: 0,
    data: config.initialState,
    usedLabels: [],
  };

  // Step 12 : valider data via stateSchema si présent.
  //    writeStateAtomic le fait aussi, mais valider explicitement ici donne un message d'erreur préflight-friendly.
  if (config.stateSchema) {
    const validation = validateResult(config.initialState, config.stateSchema);
    if (!validation.ok) {
      throw new InvalidConfigError(
        `config.initialState fails stateSchema: ${summarizeZodError(validation.error)}`,
        { cause: validation.error, runId, orchestratorName: config.name }
      );
    }
  }

  // Step 13 : persister state.json initial atomique.
  writeStateAtomic(runDir, initialState, config.stateSchema);

  // Step 14 : installer handlers SIGINT/SIGTERM.
  installSignalHandlers(config, runId, runDir, lockPath, handle, logger);

  // Step 15 : cleanup runs anciennes.
  cleanupOldRuns(cwd, config.name, config.retentionDays ?? 7, runId);

  // Entrée dans le dispatch-loop.
  //    input = undefined au premier démarrage (pas de transition in-process précédente).
  const ctx: DispatchContext<S> = {
    config, runId, runDir, lockPath, handle, logger,
    // abortController construit par installSignalHandlers et exposé via une closure.
  };
  await runDispatchLoop(ctx, initialState, /* input */ undefined);
  // runDispatchLoop ne retourne jamais : ses branches appellent process.exit.
}
```

### 3.5 Mode resume — `runResumeMode`

```ts
async function runResumeMode<S>(config: OrchestratorConfig<S>, argv: ParsedArgv): Promise<void> {
  // §14.2 step 2 : --run-id obligatoire.
  if (!argv.runId) {
    throw new InvalidConfigError("--resume requires --run-id");
  }
  const runId = argv.runId;

  // Step 4-5 : résoudre RUN_DIR, vérifier existence.
  const cwd = process.cwd();
  const runDir = resolveRunDir(cwd, config.name, runId);
  if (!fs.existsSync(runDir)) {
    throw new StateMissingError(`RUN_DIR does not exist: ${runDir}`, {
      runId, orchestratorName: config.name,
    });
  }

  // Step 6 : lire state.json + valider schemaVersion + stateSchema.
  const state = readState<S>(runDir, config.stateSchema);
  if (state === null) {
    throw new StateMissingError("state.json missing at RUN_DIR", {
      runId, orchestratorName: config.name,
    });
  }

  // Step 7 : vérifier state.runId === runId && state.orchestratorName === config.name.
  if (state.runId !== runId) {
    throw new ProtocolError(
      `RUN_DIR mismatch with argv — state.runId=${state.runId}, argv.runId=${runId}. Likely wrong cwd or corrupted state.`,
      { runId, orchestratorName: config.name }
    );
  }
  if (state.orchestratorName !== config.name) {
    throw new ProtocolError(
      `orchestrator name mismatch — state.orchestratorName=${state.orchestratorName}, config.name=${config.name}`,
      { runId, orchestratorName: config.name }
    );
  }

  // Step 8 : install stderr logger.
  const logger = createLogger(config.logging);

  // Step 9 : install handlers SIGINT/SIGTERM (avant acquire, pour couvrir l'erreur d'acquire).
  //    Remarque : handlers ont besoin du lockHandle qui n'existe pas encore.
  //    Solution : handlers construits dans un second temps, ou no-op avant acquire.
  //    Simplification : handlers installés APRÈS acquire (cohérent avec §14.2).
  //    Avant acquire, un SIGINT propage naturellement (pas d'abort propre).

  // Step 10 : acquire lock.
  const lockPath = path.join(runDir, ".lock");
  let handle: LockHandle;
  try {
    handle = acquireLock(lockPath, clock, logger, runId);
  } catch (err) {
    if (err instanceof RunLockedError) {
      emitRunLockedError(err, config, runId, logger);
      process.exit(2);
    }
    throw err;
  }

  logger.enableDiskEmit(path.join(runDir, "events.ndjson"));

  // Step 9 (placé après acquire) : handlers.
  installSignalHandlers(config, runId, runDir, lockPath, handle, logger);

  // Délégation à handle-resume pour la suite (§14.2 steps 11-15 + entrée dispatch).
  await runHandleResume({ config, runId, runDir, lockPath, handle, logger }, state);
  // runHandleResume ne retourne jamais : ses branches appellent process.exit ou entrent dans le dispatch-loop.
}
```

### 3.6 `emitRunLockedError` (preflight exit 2)

```ts
function emitRunLockedError<S>(
  err: RunLockedError,
  config: OrchestratorConfig<S>,
  runId: string,
  logger: OrchestratorLogger,
): void {
  // Note : pas de orchestrator_end émis (C12 : preflight errors ne sont pas un run complet).
  logger.emit({
    eventType: "phase_error",
    runId,
    phase: "preflight",
    errorKind: "run_locked",
    message: err.message.slice(0, 200),
    timestamp: clock.nowWallIso(),
  });
  const block = writeProtocolBlock("ERROR", {
    runId,
    orchestrator: config.name,
    errorKind: "run_locked",
    message: err.message.slice(0, 200),
    phase: null,
    phasesExecuted: 0,
  });
  process.stdout.write(block);
}
```

### 3.7 `handleTopLevelError` — catch universel (C13)

```ts
function handleTopLevelError<S>(err: unknown, config: OrchestratorConfig<S>): never {
  // Cas 1 : InvalidConfigError en préflight (avant runId généré).
  //   → bloc ERROR preflight run_id: null, phase: null, exit 1.
  if (err instanceof InvalidConfigError) {
    const block = writeProtocolBlock("ERROR", {
      runId: null,
      orchestrator: typeof config?.name === "string" ? config.name : "unknown",
      errorKind: "invalid_config",
      message: err.message.slice(0, 200),
      phase: null,
      phasesExecuted: 0,
    });
    process.stdout.write(block);
    process.exit(1);
  }

  // Cas 2 : StateMissingError / StateVersionMismatchError / StateCorruptedError / ProtocolError en resume préflight.
  //   → bloc ERROR avec runId (connu depuis argv).
  if (err instanceof OrchestratorError) {
    const block = writeProtocolBlock("ERROR", {
      runId: err.runId ?? null,
      orchestrator: err.orchestratorName ?? (typeof config?.name === "string" ? config.name : "unknown"),
      errorKind: err.kind,
      message: err.message.slice(0, 200),
      phase: err.phase ?? null,
      phasesExecuted: 0,
    });
    process.stdout.write(block);
    process.exit(1);
  }

  // Cas 3 : erreur non-OrchestratorError bug fatal (ne devrait pas arriver).
  //   → wrap dans un bloc ERROR générique avec error_kind: phase_error (catch-all).
  const msg = err instanceof Error ? err.message : String(err);
  const block = writeProtocolBlock("ERROR", {
    runId: null,
    orchestrator: typeof config?.name === "string" ? config.name : "unknown",
    errorKind: "phase_error",
    message: msg.slice(0, 200),
    phase: null,
    phasesExecuted: 0,
  });
  process.stdout.write(block);
  process.exit(1);
}
```

### 3.8 `installSignalHandlers` (SIGINT/SIGTERM, §13.2)

```ts
function installSignalHandlers<S>(
  config: OrchestratorConfig<S>,
  runId: string,
  runDir: string,
  lockPath: string,
  handle: LockHandle,
  logger: OrchestratorLogger,
): AbortController {
  const abortController = new AbortController();

  const handler = (signal: "SIGINT" | "SIGTERM") => {
    const code = signal === "SIGINT" ? 130 : 143;

    // Abort le signal propre pour interrompre abortableSleep et phase.
    abortController.abort(new AbortedError(`Received ${signal}`));

    // Flush logger : émettre phase_error + orchestrator_end.
    try {
      logger.emit({
        eventType: "phase_error",
        runId,
        phase: getCurrentPhaseOrNull() ?? "unknown",  // closure sur currentPhase via shared state
        errorKind: "aborted",
        message: `Received ${signal}`,
        timestamp: clock.nowWallIso(),
      });
      logger.emit({
        eventType: "orchestrator_end",
        runId,
        orchestratorName: config.name,
        success: false,
        durationMs: getAccumulatedDurationOrZero(),
        phasesExecuted: getPhasesExecutedOrZero(),
        timestamp: clock.nowWallIso(),
      });
    } catch { /* silent */ }

    // Emit bloc ABORTED.
    try {
      const block = writeProtocolBlock("ABORTED", {
        runId,
        orchestrator: config.name,
        signal,
        phase: getCurrentPhaseOrNull(),
      });
      process.stdout.write(block);
    } catch { /* silent */ }

    // Release lock.
    try {
      releaseLock(lockPath, handle, clock, logger, runId);
    } catch { /* silent */ }

    process.exit(code);
  };

  process.on("SIGINT", () => handler("SIGINT"));
  process.on("SIGTERM", () => handler("SIGTERM"));

  return abortController;
}
```

**Note** : `getCurrentPhaseOrNull`, `getAccumulatedDurationOrZero`, `getPhasesExecutedOrZero` sont des closures qui consultent un shared state mutable (géré dans `DispatchContext`, exposé en lecture au handler). Dans l'implémentation concrète, ce shared state est un objet `runtimeState` mutable partagé entre runInitialMode / runHandleResume / runDispatchLoop.

### 3.9 `DispatchContext` — shared state

```ts
// Type interne utilisé pour passer le contexte au dispatch-loop et handle-resume.
interface DispatchContext<S> {
  readonly config: OrchestratorConfig<S>;
  readonly runId: string;
  readonly runDir: string;
  readonly lockPath: string;
  readonly handle: LockHandle;
  readonly logger: InternalLogger;
  readonly abortController: AbortController;
  // Mutable shared state pour le handler SIGINT (lecture seule côté handler).
  currentPhase: string | null;
  phasesExecuted: number;
  accumulatedDurationMs: number;
}
```

---

## 4. Règles transversales

### 4.1 Fail-closed universel (I-4, C13)

- **Tout throw interne** est capté par `handleTopLevelError`. La Promise **ne rejette jamais**.
- **3 catégories de catch** :
  1. `InvalidConfigError` en préflight → `run_id: null` + exit 1.
  2. `OrchestratorError` avec contexte → `run_id` connu, exit 1.
  3. Erreur non-classifiée → wrap en `phase_error` + exit 1.
- **Exit codes** :
  - 0 : DELEGATE ou DONE
  - 1 : ERROR (fail, préflight, exception)
  - 2 : RunLockedError (spécifique, §14.1 step 7)
  - 130 : SIGINT
  - 143 : SIGTERM

### 4.2 Ordre d'initialisation critique

```
1. validateConfig → throw si invalide (préflight bloc ERROR run_id: null)
2. parseArgv
3. (mode initial)     (mode resume)
   generateRunId      adopt argv.runId
   resolveRunDir      resolveRunDir
   mkdirSync          check exists (throw StateMissingError sinon)
   createLogger       readState (throw si corrompu)
   acquireLock*       check state.runId match
   enableDiskEmit     createLogger
   orchestrator_start acquireLock*
   build initial state enableDiskEmit
   validateResult                     (pas d'orchestrator_start ici — il est dans le state déjà et a été émis au run initial)
   writeStateAtomic                   (hum — en fait si, §14.2 n'émet PAS à nouveau orchestrator_start à la re-entry. Il a été émis à l'initial. Le run est continu via runId.)
   installSignalHandlers
   cleanupOldRuns                     installSignalHandlers
   → dispatch-loop                    → handle-resume → dispatch-loop
```

**Note importante** : `orchestrator_start` est émis **uniquement au tout premier démarrage** (mode initial). Au resume, le run est **continu** (même runId), il n'y a pas de nouvel `orchestrator_start`. Les events suivants (`phase_start`, `phase_end`, etc.) continuent sur le même runId. `orchestrator_end` est émis à l'invocation terminale (celle qui fait DONE/ERROR/ABORTED).

### 4.3 Events préflight

| Situation | Events émis | Bloc protocole | Exit code |
|---|---|---|---|
| `InvalidConfigError` préflight config | Aucun event (pas encore de logger avec runId) | ERROR `invalid_config` run_id: null | 1 |
| `--resume` sans `--run-id` | Aucun event | ERROR `invalid_config` run_id: null | 1 |
| Mode resume : `state.json` absent | `phase_error` sur stderr seulement (pas de events.ndjson — lock pas acquis) | ERROR `state_missing` run_id présent | 1 |
| Mode resume : `state.json` corrompu | `phase_error` stderr only | ERROR `state_corrupted` | 1 |
| Mode resume : version mismatch | `phase_error` stderr only | ERROR `state_version_mismatch` | 1 |
| Mode resume : runId mismatch | `phase_error` stderr only | ERROR `protocol` | 1 |
| RunLockedError (initial ou resume) | `phase_error` stderr only | ERROR `run_locked` | 2 |

**Invariants** : aucun `orchestrator_start` ni `orchestrator_end` sur les préflight errors (C12, §19.3).

### 4.4 Installation des handlers SIGINT/SIGTERM

**Mode initial** : installés **après** acquire lock (step 14). Si un SIGINT arrive avant, le process mort naturellement sans émission propre (cas rare, acceptable — le lock n'a même pas été pris).

**Mode resume** : même principe, installés après acquire.

**Handler behavior** :
1. Abort AbortController (propage à `io.signal` et `abortableSleep`).
2. Émettre `phase_error` + `orchestrator_end` (stderr + disk).
3. Émettre bloc ABORTED sur stdout.
4. Release lock (check ownerToken, unlink si match, sinon `lock_conflict`).
5. `process.exit(130/143)`.

---

## 5. Tests NIB-T

### 5.1 Préflight errors (§20)

| Test | Situation | Bloc ERROR attendu |
|---|---|---|
| T-PF-01/T-PF-02 | `name` invalide | `invalid_config` |
| T-PF-03 | `phases: {}` | `invalid_config` |
| T-PF-04 | `initial` pas dans phases | `invalid_config` |
| T-PF-05 | `initialState` absent | `invalid_config` |
| T-PF-06/T-PF-07 | `resumeCommand` manquant/non-fonction | `invalid_config` |
| T-PF-08 | `initialState` non-conforme stateSchema | `invalid_config` |
| T-PF-09 | `--resume` sans `--run-id` | `invalid_config` run_id: null |
| T-PF-10 | RUN_DIR absent au resume | `state_missing` |
| T-PF-11 | state.json corrompu | `state_corrupted` |
| T-PF-12 | version mismatch | `state_version_mismatch` |
| T-PF-13 | runId mismatch | `protocol` |
| T-PF-14 | Pas d'event dans events.ndjson | invariant |
| T-PF-15 | Pas de `orchestrator_start` émis | C12 |
| T-PF-16 | Pas de `orchestrator_end` émis | C12 |
| T-PF-17 à T-PF-20 | Exit code 1 pour les préflight |
| T-PF-21 | Exit code 2 pour RunLockedError |

### 5.2 Entrée du happy path (§15.1)

T-RO-01 — run complet avec une phase qui done immédiatement.

### 5.3 Resume préflight (§17.6)

T-RS-19 à T-RS-23 — cases de mismatch state.

### 5.4 Signals (§21)

T-SG-01 à T-SG-11 — handler SIGINT/SIGTERM.

---

## 6. Constraints

- **Async** mais Promise résout toujours (jamais rejette).
- **`process.exit`** utilisé systématiquement — pas de `return` qui laisserait le process vivre.
- **Ordre d'init critique** (cf §4.2) — notamment le stderr logger avant acquire, events.ndjson après.
- **Pas de retry au niveau runOrchestrator** — les retries sont internes à `dispatch-loop` / `handle-resume`.
- **Handlers SIGINT/SIGTERM installés une seule fois par invocation** — pas de cleanup au retour (le process exit de toute façon).
- **Imports figés** :
  - `node:fs` (`fs.existsSync`, `fs.mkdirSync`)
  - `node:path` (`path.join`)
  - `node:process` (`process.argv`, `process.cwd`, `process.stdout`, `process.exit`, `process.on`)
  - Tous les services L4 : `clock`, `generateRunId`, `resolveRunDir`, `cleanupOldRuns`, `readState`, `writeStateAtomic`, `createLogger`, `acquireLock`, `releaseLock`, `writeProtocolBlock`, `validateResult`, `summarizeZodError`.
  - Errors : `InvalidConfigError`, `StateMissingError`, `StateCorruptedError`, `StateVersionMismatchError`, `ProtocolError`, `RunLockedError`, `AbortedError`, `OrchestratorError`.
  - Engine : `runDispatchLoop` (NIB-M-DISPATCH-LOOP), `runHandleResume` (NIB-M-HANDLE-RESUME).
  - Types : `OrchestratorConfig`, `StateFile`, `LockHandle`, `DispatchContext`.

---

## 7. Definition of Done (DoD)

1. **1 fichier** créé : `src/engine/run-orchestrator.ts` avec export `runOrchestrator`.
2. **`validateConfig`** — 8 règles §6.1 NIB-S enforced (T-PF-01 à T-PF-08).
3. **`parseArgv`** — extract `--resume` + `--run-id`, passe `rest` à io.
4. **Mode initial** §14.1 steps 3-15 : generateRunId, resolveRunDir, mkdir, createLogger, acquireLock (exit 2 si RunLocked), enableDiskEmit, orchestrator_start, build initial state, validateResult, writeStateAtomic, installSignalHandlers, cleanupOldRuns, delegate to dispatch-loop.
5. **Mode resume** §14.2 steps 1-10 : parse argv (--run-id required), resolveRunDir, exists check, readState + validation, runId/orchestratorName match check, createLogger, acquireLock, enableDiskEmit, installSignalHandlers, delegate to handle-resume.
6. **`handleTopLevelError`** — 3 catégories (InvalidConfig preflight, OrchestratorError enrichi, non-classifié fallback) + exit 1.
7. **`emitRunLockedError`** — exit 2 avec event stderr only + bloc ERROR.
8. **`installSignalHandlers`** — SIGINT (exit 130) / SIGTERM (exit 143) avec abort + logs + bloc ABORTED + release lock.
9. **Promise ne rejette jamais** — tout throw capté.
10. **Tests NIB-T** : §20 (T-PF), §15.1 (T-RO-01), §17.6 (T-RS-19-23), §21 (T-SG).
11. **LOC** : 350-500.

---

## 8. Relation avec les autres NIB-M

- **Consomme** : quasi tous les modules L4 (INFRA-UTILS, RUN-DIR, STATE-IO, LOGGER, LOCK, PROTOCOL, VALIDATOR, ERRORS) + types publics.
- **Appelle** :
  - `NIB-M-DISPATCH-LOOP` (`runDispatchLoop`) en mode initial après init complet.
  - `NIB-M-HANDLE-RESUME` (`runHandleResume`) en mode resume.
- **Consommé par** : le caller externe (un skill user qui fait `runOrchestrator(config)` dans `main.ts`).

---

## 9. Metadata

| Champ | Valeur |
|---|---|
| Source NX | §4.4, §13, §14.1 steps 1-15, §14.2 steps 1-10 |
| NIB-T associé | §20 (PF), §21 (SG), §15.1 (T-RO-01), §17.6 (T-RS-19-23) |
| Invariants NIB-S couverts | I-4, I-7, I-11, P-OWNER-ONLY-LOG |
| Fichier produit | `src/engine/run-orchestrator.ts` |
| LOC cible | 350-500 |
| Exporté publiquement | oui — `runOrchestrator` est l'entry point public |

---

*turnlock — Implicit-Free Execution — "Reliability precedes intelligence."*
