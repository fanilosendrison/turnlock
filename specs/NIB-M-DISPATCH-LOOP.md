---
id: NIB-M-DISPATCH-LOOP
type: nib-module
version: "1.0.0"
scope: turnlock
module: dispatch-loop
status: approved
consumers: [claude-code]
superseded_by: []
validates: ["src/engine/dispatch-loop.ts", "src/engine/dispatch-handlers.ts", "src/engine/phase-io.ts", "src/engine/context.ts", "src/engine/shared.ts", "src/types/phase.ts", "tests/engine/run-composition.test.ts", "tests/engine/run-deep-freeze.test.ts", "tests/engine/run-per-attempt-isolation.test.ts", "tests/integration/ping-pong.test.ts"]
---

# NIB-M-DISPATCH-LOOP — Boucle de dispatch + PhaseIO + PhaseResult handling

**Package** : `turnlock`
**Source NX** : §6.2 (Phase + deep-freeze + single PhaseResult), §6.3 (PhaseIO), §6.4 (PhaseResult mapping), §14.1 step 16 (boucle détaillée a-n), §14.1 step 16.i catch (retry post-schema-error), §14.3 (effacement pendingDelegation)
**NIB-T associé** : §15 (T-RO-01 à T-RO-19 + T-RO-01b/c), §16 (T-RO-20 à T-RO-44 sous-cas), §18 (T-RT retry post-délégation), §19 (T-RO-40-42 per-attempt isolation), §17.3 (T-CS consumption check), §16.3 (T-DF-01-03 single PhaseResult), §16.4 (T-DF-04-08 deep-freeze)
**NIB-S référencé** : §6.2 (Phase rules), §6.3 (PhaseIO methods), §6.4 (PhaseResult), §7.1 (StateFile mutation règles), §8.2 (retry table), P-DEEP-FREEZE, P-SINGLE-PHASE-RESULT, P-PER-ATTEMPT-PATHS, P-LOCK-RELEASE-SYSTEMATIC

---

## 1. Purpose

**Cœur du moteur** : implémente la boucle `while (true)` §14.1 step 16 qui :

1. Lit `state.currentPhase` (source unique) et appelle `phases[currentPhase]`.
2. Refresh lock au phase-start.
3. Construit `PhaseIO` avec les méthodes `transition/delegate*/done/fail/consumePending*/refreshLock` et les gardes-fou (`committed` flag single-result, `consumedCount` check).
4. Exécute la phase avec `state.data` **deep-frozen**.
5. Intercepte les exceptions (catch ciblé) — applique le retry post-`DelegationSchemaError` si budget disponible, sinon fail-closed ERROR.
6. Consumption check post-phase (§14.1 step 16.l).
7. Switch sur `PhaseResult.kind` et exécute la branche correspondante (`transition`, `delegate`, `done`, `fail`) — chacune persiste le state, émet les events/protocole, release lock, et exit (sauf transition qui continue la boucle).

**Principe normatif structurant** : l'ordre des **14 sous-étapes a-n** de §14.1 step 16 est **normatif**. Une implémentation qui réordonne, fusionne, ou omet une étape est non conforme. Les 4 branches `switch result.kind` sont atomiques : chaque branche fait tous ses writes + logs + émet protocole + release lock + exit en séquence, sans interruption.

**Fichier cible** : `src/engine/dispatch-loop.ts`

**LOC cible** : ~600-800.

---

## 2. Signature

```ts
import type { OrchestratorConfig, PhaseIO, PhaseResult } from "../types";
import type { StateFile } from "../services/state-io";
import type { LockHandle, DispatchContext } from "./run-orchestrator";

/**
 * Entry point de la boucle. Consomme un state initial (mode initial) ou un state chargé (mode resume).
 * Ne retourne JAMAIS : chaque branche exit via process.exit.
 * Peut être appelé depuis runInitialMode avec pendingDelegationLoaded=undefined,
 * ou depuis handle-resume avec le `loadedResults` prêt pour la phase de reprise.
 */
export async function runDispatchLoop<S extends object>(
  ctx: DispatchContext<S>,
  initialState: StateFile<S>,
  initialInput: unknown,                    // undefined en mode initial, undefined au resume (input non persisté)
  loadedResults?: LoadedResults,            // fourni par handle-resume au resume (§14.2 step 13)
): Promise<never>;

interface LoadedResults {
  readonly label: string;                   // label de la pending delegation
  readonly kind: "skill" | "agent" | "agent-batch";
  readonly data: unknown | readonly unknown[];  // raw JSON loaded from result file(s)
}
```

---

## 3. Algorithme — la boucle §14.1 step 16

### 3.1 Squelette

```ts
export async function runDispatchLoop<S>(
  ctx: DispatchContext<S>,
  initialState: StateFile<S>,
  initialInput: unknown,
  loadedResults?: LoadedResults,
): Promise<never> {
  let state = initialState;           // mutable local ref — refreshed on each transition
  let input: unknown = initialInput;  // in-process input, reset after each transition

  while (true) {
    // (a) source unique currentPhase
    const currentPhase = state.currentPhase;
    ctx.currentPhase = currentPhase;  // pour le handler SIGINT

    const phaseFn = ctx.config.phases[currentPhase];
    if (!phaseFn) {
      // Throw interne capté par top-level ERROR
      throw new ProtocolError(`unknown phase: ${currentPhase}`, {
        runId: ctx.runId, orchestratorName: ctx.config.name, phase: currentPhase,
      });
    }

    // (b) refresh lock phase-start
    refreshLock(ctx.lockPath, ctx.handle, clock, ctx.logger, ctx.runId);

    // (c) init consumedCount per-phase
    let consumedCount = 0;

    // (d) init committed flag per-phase (single PhaseResult guard)
    let committed = false;
    let committedResult: PhaseResult<S> | null = null;

    // Detect si cette phase est une phase de reprise (pendingDelegation présent à l'entrée).
    const pendingAtEntry = state.pendingDelegation;
    const isResumePhase = pendingAtEntry !== undefined && loadedResults !== undefined && loadedResults.label === pendingAtEntry.label;

    // (e) deep-freeze state.data pour passer à la phase
    const frozenData = deepFreeze(structuredClone(state.data));

    // (f) construire PhaseIO
    const io = buildPhaseIO<S>({
      ctx, state, input, frozenData, loadedResults, pendingAtEntry,
      getCommitted: () => committed,
      setCommitted: (result) => { committed = true; committedResult = result; },
      incrementConsumed: () => { consumedCount++; },
    });

    // (g) log phase_start
    const attemptCount = pendingAtEntry?.attempt !== undefined ? pendingAtEntry.attempt + 1 : 1;
    ctx.logger.emit({
      eventType: "phase_start", runId: ctx.runId, phase: currentPhase,
      attemptCount, timestamp: clock.nowWallIso(),
    });

    // (h) capture phaseStartMono
    const phaseStartMono = clock.nowMono();

    // (i) try phaseFn / catch
    let result: PhaseResult<S>;
    try {
      const returnedResult = await phaseFn(frozenData, io, input);
      // Defensive : si la phase retourne mais n'a jamais commit via io.*, c'est un bug auteur
      if (!committed || committedResult === null) {
        throw new PhaseError("phase returned without emitting a PhaseResult (must call io.transition/delegate*/done/fail)", {
          runId: ctx.runId, orchestratorName: ctx.config.name, phase: currentPhase,
        });
      }
      result = committedResult;
      // Note : returnedResult devrait === committedResult si l'auteur retourne bien, mais on ne vérifie pas strict.
    } catch (err) {
      // Branche catch §14.1 step 16.i.
      // Sous-cas : DelegationSchemaError + pending + budget retry.
      if (err instanceof DelegationSchemaError && pendingAtEntry !== undefined) {
        const decision = resolveRetryDecision(err, pendingAtEntry.attempt, pendingAtEntry.effectiveRetryPolicy);
        if (decision.retry === true) {
          await executeRetryBranch(ctx, state, pendingAtEntry, decision, err);
          // executeRetryBranch exit le process.
        }
        // Sinon fall-through à l'erreur fatale.
      }
      // Erreur fatale : wrap si nécessaire, enrich, emit phase_error + orchestrator_end + ERROR + release + exit.
      await emitFatalError(ctx, state, currentPhase, err);
      // Jamais atteint.
      return undefined as never;
    }

    // (j) phaseDurationMs
    const phaseDurationMs = Math.round(clock.nowMono() - phaseStartMono);

    // (k) accumulatedDurationMs update — enregistré localement, appliqué au state dans les branches "n".
    const newAccumulatedDurationMs = state.accumulatedDurationMs + phaseDurationMs;
    ctx.accumulatedDurationMs = newAccumulatedDurationMs;  // pour handler SIGINT

    // (l) consumption check (uniquement en phase de reprise)
    if (isResumePhase && pendingAtEntry !== undefined) {
      if (consumedCount !== 1) {
        const msg = consumedCount === 0
          ? `unconsumed delegation: ${pendingAtEntry.label}`
          : `multiple consume calls on same delegation: ${pendingAtEntry.label}`;
        await emitFatalError(ctx, state, currentPhase, new ProtocolError(msg, {
          runId: ctx.runId, orchestratorName: ctx.config.name, phase: currentPhase,
        }));
      }
    }

    // (m) log phase_end
    ctx.logger.emit({
      eventType: "phase_end", runId: ctx.runId, phase: currentPhase,
      durationMs: phaseDurationMs, resultKind: result.kind,
      timestamp: clock.nowWallIso(),
    });

    // (n) switch result.kind → 4 branches
    switch (result.kind) {
      case "transition":
        state = await handleTransition(ctx, state, result, newAccumulatedDurationMs);
        input = result.input;  // in-process, non persisté
        loadedResults = undefined;  // consumed après phase de reprise OK
        ctx.phasesExecuted = state.phasesExecuted;
        continue;  // retour boucle

      case "delegate":
        await handleDelegate(ctx, state, result, newAccumulatedDurationMs);
        // handleDelegate exit.
        return undefined as never;

      case "done":
        await handleDone(ctx, state, result, newAccumulatedDurationMs);
        return undefined as never;

      case "fail":
        await handleFail(ctx, state, result, newAccumulatedDurationMs);
        return undefined as never;
    }
  }
}
```

### 3.2 `buildPhaseIO` — construction de `PhaseIO` avec gardes

```ts
function buildPhaseIO<S extends object>(args: {
  readonly ctx: DispatchContext<S>;
  readonly state: StateFile<S>;
  readonly input: unknown;
  readonly frozenData: S;
  readonly loadedResults?: LoadedResults;
  readonly pendingAtEntry?: PendingDelegationRecord;
  readonly getCommitted: () => boolean;
  readonly setCommitted: (r: PhaseResult<S>) => void;
  readonly incrementConsumed: () => void;
}): PhaseIO<S> {
  const { ctx, pendingAtEntry, loadedResults } = args;

  function guardCommitted() {
    if (args.getCommitted()) {
      throw new ProtocolError("PhaseResult already committed", {
        runId: ctx.runId, orchestratorName: ctx.config.name, phase: ctx.currentPhase!,
      });
    }
  }

  function assertConsumeAvailable(): PendingDelegationRecord {
    if (!pendingAtEntry) {
      throw new ProtocolError("no pending delegation to consume", {
        runId: ctx.runId, orchestratorName: ctx.config.name, phase: ctx.currentPhase!,
      });
    }
    return pendingAtEntry;
  }

  return {
    transition(nextPhase, nextState, input) {
      guardCommitted();
      // Validate nextPhase exists — défendu par engine aussi dans handleTransition.
      // Ici on construit juste l'objet — validation finale en handleTransition.
      const r: PhaseResult<S> = { kind: "transition", nextPhase, nextState, input };
      args.setCommitted(r);
      return r;
    },
    delegateSkill(request, resumeAt, nextState) {
      guardCommitted();
      const r: PhaseResult<S> = { kind: "delegate", request, resumeAt, nextState };
      args.setCommitted(r);
      return r;
    },
    delegateAgent(request, resumeAt, nextState) {
      guardCommitted();
      const r: PhaseResult<S> = { kind: "delegate", request, resumeAt, nextState };
      args.setCommitted(r);
      return r;
    },
    delegateAgentBatch(request, resumeAt, nextState) {
      guardCommitted();
      const r: PhaseResult<S> = { kind: "delegate", request, resumeAt, nextState };
      args.setCommitted(r);
      return r;
    },
    done(output) {
      guardCommitted();
      const r: PhaseResult<S> = { kind: "done", output };
      args.setCommitted(r);
      return r;
    },
    fail(error) {
      guardCommitted();
      const r: PhaseResult<S> = { kind: "fail", error };
      args.setCommitted(r);
      return r;
    },

    logger: ctx.logger,
    clock,
    runId: ctx.runId,
    args: parseArgvRest(process.argv),
    runDir: ctx.runDir,
    signal: ctx.abortController.signal,

    consumePendingResult<T>(schema: ZodSchema<T>): T {
      const pd = assertConsumeAvailable();
      if (pd.kind === "agent-batch") {
        throw new ProtocolError("use consumePendingBatchResults for batch delegations", {
          runId: ctx.runId, orchestratorName: ctx.config.name, phase: ctx.currentPhase!,
        });
      }
      if (!loadedResults) {
        throw new DelegationMissingResultError(`result file missing for ${pd.label}`, {
          runId: ctx.runId, orchestratorName: ctx.config.name, phase: ctx.currentPhase!,
        });
      }
      args.incrementConsumed();
      if (args.getCommitted() === false && args.getCommitted() /* noop — just read consumedCount */) { /* logic OK */ }
      // Enforce exact-once at call time via consumedCount check post-phase (§14.1 step 16.l).
      // BUT: immediate second-call throw — here we detect before incrementing.
      // (Reorganisation : l'incrementConsumed doit être appelé APRÈS validation, donc le "second call"
      //  check se fait à l'entrée.)
      // Simplification : on incrémente et si la valeur post-incrément > 1, throw.
      // L'ordre correct est : (1) check wrong-kind, (2) check double-call via consumedCount snapshot, (3) validate, (4) increment.

      // Réécriture : voir §3.3 ci-dessous pour la logique exacte.

      const validation = validateResult(loadedResults.data, schema);
      if (!validation.ok) {
        ctx.logger.emit({
          eventType: "delegation_validation_failed", runId: ctx.runId, phase: ctx.currentPhase!,
          label: pd.label, zodErrorSummary: summarizeZodError(validation.error),
          timestamp: clock.nowWallIso(),
        });
        throw new DelegationSchemaError(
          `validation failed for ${pd.label}: ${summarizeZodError(validation.error)}`,
          { cause: validation.error, runId: ctx.runId, orchestratorName: ctx.config.name, phase: ctx.currentPhase! }
        );
      }
      ctx.logger.emit({
        eventType: "delegation_validated", runId: ctx.runId, phase: ctx.currentPhase!,
        label: pd.label, timestamp: clock.nowWallIso(),
      });
      return validation.data;
    },

    consumePendingBatchResults<T>(schema: ZodSchema<T>): readonly T[] {
      const pd = assertConsumeAvailable();
      if (pd.kind !== "agent-batch") {
        throw new ProtocolError("use consumePendingResult for single delegations", {
          runId: ctx.runId, orchestratorName: ctx.config.name, phase: ctx.currentPhase!,
        });
      }
      if (!loadedResults) {
        throw new DelegationMissingResultError(`result files missing for ${pd.label}`, {
          runId: ctx.runId, orchestratorName: ctx.config.name, phase: ctx.currentPhase!,
        });
      }
      args.incrementConsumed();
      const rawArray = loadedResults.data as readonly unknown[];
      const validated: T[] = [];
      for (const raw of rawArray) {
        const validation = validateResult(raw, schema);
        if (!validation.ok) {
          ctx.logger.emit({
            eventType: "delegation_validation_failed", runId: ctx.runId, phase: ctx.currentPhase!,
            label: pd.label, zodErrorSummary: summarizeZodError(validation.error),
            timestamp: clock.nowWallIso(),
          });
          throw new DelegationSchemaError(
            `validation failed for ${pd.label}: ${summarizeZodError(validation.error)}`,
            { cause: validation.error, runId: ctx.runId, orchestratorName: ctx.config.name, phase: ctx.currentPhase! }
          );
        }
        validated.push(validation.data);
      }
      ctx.logger.emit({
        eventType: "delegation_validated", runId: ctx.runId, phase: ctx.currentPhase!,
        label: pd.label, timestamp: clock.nowWallIso(),
      });
      return validated;
    },

    refreshLock() {
      refreshLock(ctx.lockPath, ctx.handle, clock, ctx.logger, ctx.runId);
    },
  };
}
```

### 3.3 Enforcement exact-once (clarification)

La règle §6.3 "exactement un appel à consumePending*" s'enforce en deux endroits :

- **Wrong-kind** : check immédiat dans `consumePendingResult` (throw si `pd.kind === "agent-batch"`) et `consumePendingBatchResults` (throw si `pd.kind !== "agent-batch"`).
- **Double-appel** : check immédiat avant `incrementConsumed()`. Si `consumedCount > 0` déjà, throw `ProtocolError("multiple consume calls on same delegation: <label>")`.
- **Zero-appel** : check **post-phase** au step 16.l (§14.1). Si `consumedCount === 0` et phase de reprise, throw `ProtocolError("unconsumed delegation: <label>")`.

Le code §3.2 ci-dessus montre le flow général — l'implémentation concrète réarrange pour checker avant d'incrémenter. Pattern :

```ts
// Dans consumePendingResult :
if (args.getConsumedCount() >= 1) {
  throw new ProtocolError(`multiple consume calls on same delegation: ${pd.label}`, {...});
}
args.incrementConsumed();
// ... reste du parsing/validation
```

---

## 4. Branches du switch `result.kind`

### 4.1 Branche `transition` — §14.1 step 16.n "transition"

```ts
async function handleTransition<S>(
  ctx: DispatchContext<S>,
  state: StateFile<S>,
  result: { kind: "transition"; nextPhase: string; nextState: S; input?: unknown },
  accumulatedDurationMs: number,
): Promise<StateFile<S>> {
  // Valider nextPhase existe.
  if (!(result.nextPhase in ctx.config.phases)) {
    throw new ProtocolError(`unknown phase: ${result.nextPhase}`, {
      runId: ctx.runId, orchestratorName: ctx.config.name, phase: state.currentPhase,
    });
  }

  const nowIso = clock.nowWallIso();
  const nowEpoch = clock.nowEpochMs();

  const newState: StateFile<S> = {
    ...state,
    currentPhase: result.nextPhase,
    data: result.nextState,
    phasesExecuted: state.phasesExecuted + 1,
    lastTransitionAt: nowIso,
    lastTransitionAtEpochMs: nowEpoch,
    accumulatedDurationMs,
    pendingDelegation: undefined,  // effacé au traitement du PhaseResult (§7.1 M14)
  };

  writeStateAtomic(ctx.runDir, newState, ctx.config.stateSchema);
  return newState;
}
```

**Règles** :

- **Pas d'exit** — continue la boucle.
- **`pendingDelegation` effacé** ici et pas au début de la phase de reprise (§7.1 M14, T-RS-24).
- **`input` non persisté** (§6.2 C11) — passé en mémoire via le retour de `handleTransition` à la boucle.
- **Pas d'event spécifique** (transition est interne) — seulement `phase_end` déjà émis au step 16.m.

### 4.2 Branche `delegate` — §14.1 step 16.n "delegate"

```ts
async function handleDelegate<S>(
  ctx: DispatchContext<S>,
  state: StateFile<S>,
  result: { kind: "delegate"; request: DelegationRequest; resumeAt: string; nextState: S },
  accumulatedDurationMs: number,
): Promise<never> {
  const request = result.request;
  const label = request.label;
  const kind = request.kind;
  const resumeAt = result.resumeAt;

  // Validation resumeAt.
  if (!(resumeAt in ctx.config.phases)) {
    throw new ProtocolError(`unknown phase: ${resumeAt}`, {
      runId: ctx.runId, orchestratorName: ctx.config.name, phase: state.currentPhase,
    });
  }

  // Validation label unique au run.
  if (!/^[a-z][a-z0-9-]*$/.test(label)) {
    throw new ProtocolError(`invalid label format: ${label}`, { runId: ctx.runId, phase: state.currentPhase });
  }
  if (state.usedLabels.includes(label)) {
    throw new ProtocolError(`duplicate label: ${label}`, {
      runId: ctx.runId, orchestratorName: ctx.config.name, phase: state.currentPhase,
    });
  }

  // Validation jobs pour agent-batch.
  if (kind === "agent-batch") {
    const req = request as AgentBatchDelegationRequest;
    if (req.jobs.length === 0) {
      throw new InvalidConfigError(`batch delegation '${label}' has no jobs`);
    }
    const ids = new Set<string>();
    for (const job of req.jobs) {
      if (ids.has(job.id)) {
        throw new ProtocolError(`duplicate job id in batch: ${job.id}`, {
          runId: ctx.runId, orchestratorName: ctx.config.name, phase: state.currentPhase,
        });
      }
      ids.add(job.id);
    }
  }

  // Résoudre effectiveRetryPolicy champ-par-champ (§6.8, M26).
  const effectiveRetryPolicy = {
    maxAttempts: request.retry?.maxAttempts ?? ctx.config.retry?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    backoffBaseMs: request.retry?.backoffBaseMs ?? ctx.config.retry?.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS,
    maxBackoffMs: request.retry?.maxBackoffMs ?? ctx.config.retry?.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS,
  };
  const timeoutMs = request.timeout?.perDelegationMs ?? ctx.config.timeout?.perDelegationMs ?? DEFAULT_TIMEOUT_MS;

  const emittedAtEpochMs = clock.nowEpochMs();
  const emittedAt = clock.nowWallIso();
  const deadlineAtEpochMs = emittedAtEpochMs + timeoutMs;
  const attempt = 0;  // première émission — retries via branche retry §14.1 step 16.i.

  // Construire le manifest via binding.
  const binding = selectBinding(kind);
  const manifestContext = {
    runId: ctx.runId, orchestratorName: ctx.config.name,
    phase: state.currentPhase, resumeAt, attempt,
    maxAttempts: effectiveRetryPolicy.maxAttempts,
    emittedAt, emittedAtEpochMs, timeoutMs, deadlineAtEpochMs,
    runDir: ctx.runDir,
  };
  const manifest = (binding as any).buildManifest(request, manifestContext);

  // Persister manifest atomique.
  const manifestPath = path.join(ctx.runDir, "delegations", `${label}-${attempt}.json`);
  writeFileSyncAtomic(manifestPath, JSON.stringify(manifest));

  // Construire pendingDelegation.
  const pendingDelegation: PendingDelegationRecord = {
    label, kind, resumeAt, manifestPath,
    emittedAtEpochMs, deadlineAtEpochMs,
    attempt, effectiveRetryPolicy,
    jobIds: kind === "agent-batch" ? (request as AgentBatchDelegationRequest).jobs.map(j => j.id) : undefined,
  };

  // Update state.
  const newState: StateFile<S> = {
    ...state,
    data: result.nextState,
    phasesExecuted: state.phasesExecuted + 1,
    lastTransitionAt: emittedAt,
    lastTransitionAtEpochMs: emittedAtEpochMs,
    accumulatedDurationMs,
    pendingDelegation,
    usedLabels: [...state.usedLabels, label],  // append-only
  };
  writeStateAtomic(ctx.runDir, newState, ctx.config.stateSchema);

  // Log delegation_emit.
  ctx.logger.emit({
    eventType: "delegation_emit", runId: ctx.runId, phase: state.currentPhase,
    label, kind, jobCount: kind === "agent-batch" ? (request as AgentBatchDelegationRequest).jobs.length : 1,
    timestamp: emittedAt,
  });

  // Construire resume_cmd.
  const resumeCmd = ctx.config.resumeCommand(ctx.runId);

  // Émettre bloc DELEGATE.
  const block = (binding as any).buildProtocolBlock(manifest, manifestPath, resumeCmd);
  process.stdout.write(block);

  // Release lock avant exit.
  releaseLock(ctx.lockPath, ctx.handle, clock, ctx.logger, ctx.runId);

  // Exit 0.
  process.exit(0);
}
```

### 4.3 Branche `done` — §14.1 step 16.n "done"

```ts
async function handleDone<S>(
  ctx: DispatchContext<S>,
  state: StateFile<S>,
  result: { kind: "done"; output: unknown },
  accumulatedDurationMs: number,
): Promise<never> {
  // Écrire output.json atomique.
  const outputPath = path.join(ctx.runDir, "output.json");
  try {
    writeFileSyncAtomic(outputPath, JSON.stringify(result.output));
  } catch (err) {
    // JSON.stringify peut throw (référence circulaire, BigInt, etc.)
    // → fallback : traiter comme phase_error fatal.
    throw new PhaseError(
      `failed to serialize done.output: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err, runId: ctx.runId, orchestratorName: ctx.config.name, phase: state.currentPhase }
    );
  }

  // Update state final.
  const newState: StateFile<S> = {
    ...state,
    phasesExecuted: state.phasesExecuted + 1,
    accumulatedDurationMs,
    pendingDelegation: undefined,
  };
  writeStateAtomic(ctx.runDir, newState, ctx.config.stateSchema);

  const endedAt = clock.nowWallIso();

  // Log orchestrator_end.
  ctx.logger.emit({
    eventType: "orchestrator_end", runId: ctx.runId, orchestratorName: ctx.config.name,
    success: true, durationMs: accumulatedDurationMs, phasesExecuted: newState.phasesExecuted,
    timestamp: endedAt,
  });

  // Émettre bloc DONE.
  const block = writeProtocolBlock("DONE", {
    runId: ctx.runId, orchestrator: ctx.config.name,
    output: outputPath, success: true,
    phasesExecuted: newState.phasesExecuted, durationMs: accumulatedDurationMs,
  });
  process.stdout.write(block);

  releaseLock(ctx.lockPath, ctx.handle, clock, ctx.logger, ctx.runId);
  process.exit(0);
}
```

### 4.4 Branche `fail` — §14.1 step 16.n "fail"

```ts
async function handleFail<S>(
  ctx: DispatchContext<S>,
  state: StateFile<S>,
  result: { kind: "fail"; error: Error },
  accumulatedDurationMs: number,
): Promise<never> {
  // Resolve errorKind.
  const errorKind: OrchestratorErrorKind = result.error instanceof OrchestratorError
    ? result.error.kind
    : "phase_error";

  // Update state.
  const newState: StateFile<S> = {
    ...state,
    phasesExecuted: state.phasesExecuted + 1,
    accumulatedDurationMs,
  };
  writeStateAtomic(ctx.runDir, newState, ctx.config.stateSchema);

  // Log phase_error + orchestrator_end.
  const nowIso = clock.nowWallIso();
  ctx.logger.emit({
    eventType: "phase_error", runId: ctx.runId, phase: state.currentPhase,
    errorKind, message: result.error.message.slice(0, 200), timestamp: nowIso,
  });
  ctx.logger.emit({
    eventType: "orchestrator_end", runId: ctx.runId, orchestratorName: ctx.config.name,
    success: false, durationMs: accumulatedDurationMs, phasesExecuted: newState.phasesExecuted,
    timestamp: nowIso,
  });

  // Émettre bloc ERROR.
  const block = writeProtocolBlock("ERROR", {
    runId: ctx.runId, orchestrator: ctx.config.name,
    errorKind, message: result.error.message.slice(0, 200),
    phase: state.currentPhase, phasesExecuted: newState.phasesExecuted,
  });
  process.stdout.write(block);

  releaseLock(ctx.lockPath, ctx.handle, clock, ctx.logger, ctx.runId);
  process.exit(1);
}
```

### 4.5 `executeRetryBranch` — retry post-`DelegationSchemaError` (§14.1 step 16.i catch)

```ts
async function executeRetryBranch<S>(
  ctx: DispatchContext<S>,
  state: StateFile<S>,
  pd: PendingDelegationRecord,
  decision: { retry: true; delayMs: number; reason: string },
  _originalErr: DelegationSchemaError,
): Promise<never> {
  // Log retry_scheduled.
  ctx.logger.emit({
    eventType: "retry_scheduled", runId: ctx.runId, phase: state.currentPhase,
    label: pd.label, attempt: pd.attempt + 1, delayMs: decision.delayMs, reason: decision.reason,
    timestamp: clock.nowWallIso(),
  });

  // Sleep interruptible.
  try {
    await abortableSleep(decision.delayMs, ctx.abortController.signal);
  } catch (e) {
    // Abort pendant sleep → traiter comme AbortedError (le handler SIGINT a déjà émis ABORTED + exit).
    // Si on arrive ici sans handler (cas théorique), emit fatal.
    throw new AbortedError("aborted during retry sleep", { cause: e, runId: ctx.runId, phase: state.currentPhase });
  }

  // Reconstruction du nouveau manifest à partir de l'ancien (M13).
  const oldManifestRaw = fs.readFileSync(pd.manifestPath, "utf-8");
  const oldManifest = JSON.parse(oldManifestRaw) as DelegationManifest;

  const newAttempt = pd.attempt + 1;
  const newEmittedAtEpochMs = clock.nowEpochMs();
  const newEmittedAt = clock.nowWallIso();
  const newDeadlineAtEpochMs = newEmittedAtEpochMs + oldManifest.timeoutMs;
  const newManifestPath = path.join(ctx.runDir, "delegations", `${pd.label}-${newAttempt}.json`);

  const newManifest: DelegationManifest = reconstructManifest(oldManifest, {
    attempt: newAttempt, emittedAt: newEmittedAt, emittedAtEpochMs: newEmittedAtEpochMs,
    deadlineAtEpochMs: newDeadlineAtEpochMs,
    label: pd.label, runDir: ctx.runDir,
  });

  writeFileSyncAtomic(newManifestPath, JSON.stringify(newManifest));

  // Update state.pendingDelegation (effectiveRetryPolicy inchangé, M26).
  const newState: StateFile<S> = {
    ...state,
    pendingDelegation: {
      ...pd,
      attempt: newAttempt,
      emittedAtEpochMs: newEmittedAtEpochMs,
      deadlineAtEpochMs: newDeadlineAtEpochMs,
      manifestPath: newManifestPath,
    },
    lastTransitionAt: newEmittedAt,
    lastTransitionAtEpochMs: newEmittedAtEpochMs,
  };
  writeStateAtomic(ctx.runDir, newState, ctx.config.stateSchema);

  // Log delegation_emit.
  ctx.logger.emit({
    eventType: "delegation_emit", runId: ctx.runId, phase: state.currentPhase,
    label: pd.label, kind: pd.kind,
    jobCount: pd.jobIds?.length ?? 1,
    timestamp: newEmittedAt,
  });

  // Émettre bloc DELEGATE (resumeCmd inchangé, pointé par resumeCommand(runId)).
  const resumeCmd = ctx.config.resumeCommand(ctx.runId);
  const binding = selectBinding(pd.kind);
  const block = (binding as any).buildProtocolBlock(newManifest, newManifestPath, resumeCmd);
  process.stdout.write(block);

  releaseLock(ctx.lockPath, ctx.handle, clock, ctx.logger, ctx.runId);
  process.exit(0);
}

function reconstructManifest(old: DelegationManifest, updates: {
  attempt: number; emittedAt: string; emittedAtEpochMs: number;
  deadlineAtEpochMs: number; label: string; runDir: string;
}): DelegationManifest {
  // Copier tous les champs métier, remplacer les temporels + chemins per-attempt.
  const base: DelegationManifest = {
    ...old,
    attempt: updates.attempt,
    emittedAt: updates.emittedAt,
    emittedAtEpochMs: updates.emittedAtEpochMs,
    deadlineAtEpochMs: updates.deadlineAtEpochMs,
  };
  if (old.kind === "skill" || old.kind === "agent") {
    return {
      ...base,
      resultPath: path.join(updates.runDir, "results", `${updates.label}-${updates.attempt}.json`),
    };
  }
  // agent-batch
  return {
    ...base,
    jobs: old.jobs!.map(j => ({
      ...j,
      resultPath: path.join(updates.runDir, "results", `${updates.label}-${updates.attempt}`, `${j.id}.json`),
    })),
  };
}
```

### 4.6 `emitFatalError` — pattern canonique fail-closed

```ts
async function emitFatalError<S>(
  ctx: DispatchContext<S>,
  state: StateFile<S>,
  currentPhase: string,
  err: unknown,
): Promise<never> {
  // Wrap si nécessaire.
  let wrapped: OrchestratorError;
  if (err instanceof OrchestratorError) {
    wrapped = err;
  } else if (err instanceof Error) {
    wrapped = new PhaseError(err.message.slice(0, 200), { cause: err });
  } else {
    wrapped = new PhaseError(String(err).slice(0, 200));
  }
  enrich(wrapped, { runId: ctx.runId, orchestratorName: ctx.config.name, phase: currentPhase });

  // Persister state (pas de transition, phasesExecuted inchangé — on est dans catch).
  try { writeStateAtomic(ctx.runDir, state, ctx.config.stateSchema); } catch { /* silent */ }

  const nowIso = clock.nowWallIso();
  ctx.logger.emit({
    eventType: "phase_error", runId: ctx.runId, phase: currentPhase,
    errorKind: wrapped.kind, message: wrapped.message.slice(0, 200), timestamp: nowIso,
  });
  ctx.logger.emit({
    eventType: "orchestrator_end", runId: ctx.runId, orchestratorName: ctx.config.name,
    success: false, durationMs: state.accumulatedDurationMs,
    phasesExecuted: state.phasesExecuted, timestamp: nowIso,
  });

  const block = writeProtocolBlock("ERROR", {
    runId: ctx.runId, orchestrator: ctx.config.name,
    errorKind: wrapped.kind, message: wrapped.message.slice(0, 200),
    phase: currentPhase, phasesExecuted: state.phasesExecuted,
  });
  process.stdout.write(block);

  releaseLock(ctx.lockPath, ctx.handle, clock, ctx.logger, ctx.runId);
  process.exit(1);
}
```

---

## 5. Helpers

### 5.1 `deepFreeze` — récursif

```ts
function deepFreeze<T>(obj: T): T {
  if (obj === null || typeof obj !== "object") return obj;
  // Freeze propriétés avant l'objet lui-même.
  for (const key of Object.getOwnPropertyNames(obj)) {
    const value = (obj as any)[key];
    if (value !== null && (typeof value === "object" || typeof value === "function")) {
      deepFreeze(value);
    }
  }
  return Object.freeze(obj);
}
```

**Règles** :

- **Récursif** sur tous les objets et arrays.
- **Pas pour les primitives** (early return).
- **Appliqué avant chaque phase** pour éviter mutations cumulatives entre phases.

### 5.2 `writeFileSyncAtomic` — helper partagé

```ts
function writeFileSyncAtomic(targetPath: string, content: string): void {
  const tmpPath = targetPath + ".tmp";
  fs.writeFileSync(tmpPath, content, { encoding: "utf-8" });
  fs.renameSync(tmpPath, targetPath);
}
```

Utilisé pour `manifest.json`, `output.json`. Pattern identique à `writeStateAtomic` (NIB-M-STATE-IO) mais générique. Pourrait être extracted en `src/services/atomic-write.ts` si besoin — v1 inline.

### 5.3 `selectBinding`

```ts
function selectBinding(kind: "skill" | "agent" | "agent-batch"): DelegationBinding<any> {
  switch (kind) {
    case "skill": return skillBinding;
    case "agent": return agentBinding;
    case "agent-batch": return agentBatchBinding;
  }
}
```

---

## 6. Règles transversales

- **Ordre 14 étapes a-n** strictement respecté.
- **4 branches du switch** atomiques : chacune persiste, loggue, émet, release, exit.
- **`pendingDelegation` effacé** uniquement au traitement du PhaseResult en phase de reprise (transition/done/fail branches). **Pas** au début de la phase (cross-crash preservation, §7.1 M14).
- **Catch catch-all ciblé** (`try { await phaseFn } catch`) : pas de try/catch global autour de la boucle. Les erreurs de `refreshLock`, `writeStateAtomic`, etc. propagent au top-level de `runOrchestrator` qui les attrape.
- **`input` non persisté** : si une transition `io.transition(next, state, input)` précède une délégation, le `input` est perdu au re-entry. Discipline : pour données durables cross-délégation → `state.data`.
- **Deep-freeze appliqué à `state.data`** (pas à tout `StateFile<S>`) — la phase reçoit `state.data` via `frozenData`, pas le state complet.

---

## 7. Tests NIB-T

| Section | Tests |
|---|---|
| §15 happy path initial | T-RO-01 (flow minimal), T-RO-01b/c (lock refresh), T-RO-02-19 (transitions, delegations) |
| §16 sous-cas | T-RO-20-44 (fail, throw, single PhaseResult, deep-freeze, usedLabels, input in-process, batch id unique, config figée) |
| §17.3 consumption check | T-CS-01-05 |
| §16.3 single PhaseResult | T-DF-01-03 |
| §16.4 deep-freeze | T-DF-04-08 |
| §18 retry | T-RT-01-10 (post-schema, post-timeout, exhausted, reconstruction, effectiveRetryPolicy, usedLabels preserved) |
| §19 per-attempt isolation | T-RO-40-42, P-RO-d |
| §26 property globaux | P-01, P-02, P-03, P-04, P-05, P-08, P-09, P-14-20 |

---

## 8. Constraints

- **Async mais séquentiel** — `await` uniquement sur `phaseFn` et `abortableSleep`. Pas de `Promise.all`.
- **Pas de try/catch global** autour de la boucle. Catch ciblés autour de `phaseFn` et autour de `JSON.stringify(done.output)`.
- **Pas de side effect hors des 4 helpers `handle*`, `executeRetryBranch`, `emitFatalError`** — toutes les écritures disque + stdout + logs + exit passent par ces fonctions.
- **`ctx.currentPhase` et autres mutables synchros** entre dispatch et handler SIGINT — read-only côté handler, write côté dispatch.
- **Imports figés** : tous les services L4, tous les bindings, errors, types.

---

## 9. Definition of Done (DoD)

1. **1 fichier** : `src/engine/dispatch-loop.ts` avec export `runDispatchLoop`.
2. **Boucle §14.1 step 16** avec 14 étapes a-n dans l'ordre.
3. **4 branches `switch result.kind`** : transition continue la boucle, delegate/done/fail exit.
4. **`buildPhaseIO`** :
   - `committed` flag enforce single PhaseResult.
   - `consumedCount` track consume calls.
   - Wrong-kind throw immédiat dans `consumePending*`.
   - Double-appel throw immédiat.
   - Deep-freeze appliqué à `state.data` avant passage à la phase.
5. **`executeRetryBranch`** — reconstruction manifest depuis l'ancien, per-attempt paths, `effectiveRetryPolicy` préservée, release lock + exit 0.
6. **`emitFatalError`** — pattern canonique fail-closed.
7. **Consumption check post-phase** (step 16.l) — 0 ou 2+ consume → `ProtocolError`.
8. **`pendingDelegation` effacement** uniquement dans les branches transition/done/fail (preserving cross-crash).
9. **Tests NIB-T** : §15, §16, §17.3, §18, §19, §26.
10. **LOC** : 600-800.

---

## 10. Relation avec les autres NIB-M

- **Consomme** : tous les services L4 + NIB-M-BINDINGS + types publics + NIB-M-ERRORS.
- **Consommé par** : `NIB-M-RUN-ORCHESTRATOR` (initial) et `NIB-M-HANDLE-RESUME` (resume).

---

## 11. Metadata

| Champ | Valeur |
|---|---|
| Source NX | §6.2, §6.3, §6.4, §14.1 step 16, §14.3 |
| NIB-T associé | §15, §16, §17.3, §18, §19, §26 |
| Invariants NIB-S couverts | I-14, I-15, P-DEEP-FREEZE, P-SINGLE-PHASE-RESULT, P-PER-ATTEMPT-PATHS, P-LOCK-RELEASE-SYSTEMATIC |
| Fichier produit | `src/engine/dispatch-loop.ts` |
| LOC cible | 600-800 |
| Non exporté publiquement | oui (interne engine) |

---

*turnlock — Implicit-Free Execution — "Reliability precedes intelligence."*
