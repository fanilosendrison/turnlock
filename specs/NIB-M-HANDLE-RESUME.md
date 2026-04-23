---
id: NIB-M-HANDLE-RESUME
type: nib-module
version: "1.0.0"
scope: turnlock
module: handle-resume
status: approved
consumers: [claude-code]
superseded_by: []
validates: ["src/engine/handle-resume.ts", "tests/engine/run-resume-happy-path.test.ts"]
---

# NIB-M-HANDLE-RESUME — Logique spécifique du resume (§14.2 steps 11-15)

**Package** : `turnlock`
**Source NX** : §14.2 steps 11-15 (identification pending, classification missing/malformed/parseable, deadline check, branche retry, entrée dispatch), §14.3 (timing effacement `pendingDelegation`)
**NIB-T associé** : §17 (T-RS-01 à T-RS-31 resume), §18.2/§18.3 (T-RT-02, T-RT-04 retry post-timeout), §22.bis.2 (T-TM-04-06 deadline cross-reentry)
**NIB-S référencé** : §7.1 (PendingDelegationRecord), §7.2 (per-attempt paths), §7.3 (malformed classification), I-15 (per-attempt paths), P-LOCK-RELEASE-SYSTEMATIC

---

## 1. Purpose

**Logique spécifique au mode resume**, invoquée par `runOrchestrator` après l'acquire lock (§14.2 step 10) et avant l'entrée dans le dispatch-loop. Responsabilités :

1. **Identifier** la délégation pending (§14.2 step 11) — throw `ProtocolError` si absente.
2. **Classifier les fichiers résultats** (§14.2 step 12.b) : chaque chemin attendu est `missing` / `malformed` / `parseable`.
3. **Décision classification + deadline** (§14.2 step 12.d) :
   - `allParseable` → charger en RAM, continuer step 13.
   - `anyMalformed` → `DelegationSchemaError` → retry ou fatal.
   - `!allPresent && deadlinePassed` → `DelegationTimeoutError` → retry ou fatal.
   - `!allPresent && !deadlinePassed` → `DelegationMissingResultError` → fatal (bug parent).
4. **Branche retry** (§14.2 step 12.e) — reconstruction manifest + ré-émission DELEGATE + release lock + exit.
5. **Branche continue** (§14.2 step 13-15) — log `delegation_result_read`, positionner `state.currentPhase = pd.resumeAt` en mémoire, préparer `loadedResults` et entrer dans le dispatch-loop.

**Principe normatif structurant** : ce module ne **valide pas** les JSON via zod (validation lazy faite par `consumePending*` dans le dispatch-loop). Il fait uniquement un `JSON.parse` pour distinguer malformed vs parseable. La validation schema arrive après, lors de la phase de reprise.

**Fichier cible** : `src/engine/handle-resume.ts`

**LOC cible** : ~300-400.

---

## 2. Signature

```ts
import type { StateFile } from "../services/state-io";
import type { DispatchContext } from "./run-orchestrator";

/**
 * Entry point pour le mode resume, après acquire lock réussi.
 * Effectue classification + deadline check, puis :
 * - Soit entre dans le dispatch-loop avec loadedResults prêt (branche continue)
 * - Soit reconstruit manifest + émet DELEGATE + exit (branche retry)
 * - Soit émet ERROR fatal + exit (missing sans deadline, protocol mismatch, etc.)
 *
 * Ne retourne jamais : ses branches appellent process.exit.
 */
export async function runHandleResume<S extends object>(
  ctx: DispatchContext<S>,
  state: StateFile<S>,
): Promise<never>;
```

---

## 3. Algorithme — §14.2 steps 11-15

### 3.1 Pipeline

```ts
export async function runHandleResume<S extends object>(
  ctx: DispatchContext<S>,
  state: StateFile<S>,
): Promise<never> {
  // Step 11 : identifier pending.
  const pd = state.pendingDelegation;
  if (!pd) {
    // Bug : resume invoqué sans pending. Emit fatal.
    throw new ProtocolError("resume without pending delegation", {
      runId: ctx.runId, orchestratorName: ctx.config.name,
    });
  }

  // Step 12.a-c : classifier fichiers résultat.
  const classification = classifyResultFiles(ctx.runDir, pd);
  const nowEpoch = clock.nowEpochMs();
  const deadlinePassed = nowEpoch > pd.deadlineAtEpochMs;

  // Step 12.d : décision.
  if (classification.allParseable) {
    // Branche continue → step 13.
    await enterDispatchLoopWithResults(ctx, state, pd, classification.loadedData);
    return undefined as never;
  }

  if (classification.anyMalformed) {
    // Malformed = DelegationSchemaError immédiat.
    await handleDelegationError(ctx, state, pd, "delegation_schema", "malformed JSON in result file");
    return undefined as never;
  }

  // Pas d'allParseable, pas d'anyMalformed → manque au moins un fichier.
  if (!classification.allPresent && deadlinePassed) {
    await handleDelegationError(ctx, state, pd, "delegation_timeout", `deadline passed for ${pd.label}`);
    return undefined as never;
  }

  if (!classification.allPresent && !deadlinePassed) {
    // Bug parent agent : résultat manquant alors que deadline pas dépassée.
    // Non retriable — throw DelegationMissingResultError fatal.
    await emitFatalError(ctx, state, new DelegationMissingResultError(
      `result file missing for ${pd.label} (deadline not passed, parent agent bug)`,
      { runId: ctx.runId, orchestratorName: ctx.config.name, phase: pd.resumeAt }
    ));
    return undefined as never;
  }

  // Cas défensif (impossible par logique des booleans).
  throw new ProtocolError("classification inconsistent", { runId: ctx.runId });
}
```

### 3.2 `classifyResultFiles` (§14.2 step 12.b-c)

```ts
interface Classification {
  readonly allPresent: boolean;
  readonly allParseable: boolean;
  readonly anyMalformed: boolean;
  readonly loadedData: unknown | readonly unknown[] | null;  // null si pas allParseable
}

function classifyResultFiles(runDir: string, pd: PendingDelegationRecord): Classification {
  const paths = buildExpectedResultPaths(runDir, pd);
  let allPresent = true;
  let anyMalformed = false;
  const parsedValues: unknown[] = [];

  for (const p of paths) {
    if (!fs.existsSync(p)) {
      allPresent = false;
      continue;
    }
    // Fichier existe — tenter parse.
    let raw: string;
    try {
      raw = fs.readFileSync(p, "utf-8");
    } catch {
      anyMalformed = true;  // IO error traité comme malformed défensivement
      continue;
    }
    try {
      const parsed = JSON.parse(raw);
      parsedValues.push(parsed);
    } catch {
      anyMalformed = true;
      // Logger side-effect : path + fileSizeBytes (PII discipline C10).
      // Note : on reporte le log ici, pas à la classification caller.
      // Pour simplifier, on ne log PAS dans cette fonction pure-like — le caller logue
      // via delegation_validation_failed si la décision finale est schema.
    }
  }

  const allParseable = allPresent && !anyMalformed && parsedValues.length === paths.length;
  return {
    allPresent,
    allParseable,
    anyMalformed,
    loadedData: allParseable
      ? (pd.kind === "agent-batch" ? parsedValues : parsedValues[0] ?? null)
      : null,
  };
}

function buildExpectedResultPaths(runDir: string, pd: PendingDelegationRecord): string[] {
  if (pd.kind === "skill" || pd.kind === "agent") {
    return [path.join(runDir, "results", `${pd.label}-${pd.attempt}.json`)];
  }
  // agent-batch
  const batchDir = path.join(runDir, "results", `${pd.label}-${pd.attempt}`);
  return (pd.jobIds ?? []).map((id) => path.join(batchDir, `${id}.json`));
}
```

**Règles normatives** :

- **Per-attempt paths** (I-15) : seul l'`attempt` courant est consulté. Les fichiers d'`attempt` précédents sont ignorés (T-RS-31).
- **Batch ordering** : `loadedData` est `unknown[]` aligné sur l'ordre de `pd.jobIds`. C'est le `consumePendingBatchResults` du dispatch-loop qui valide chaque élément.
- **Malformed inclut fichier vide ou HTML** (T-RS-15, T-RS-16) — tout ce qui n'est pas un JSON parseable.
- **IO error traité comme malformed** — cas défensif (fichier supprimé entre `existsSync` et `readFileSync`). La classification caller décidera retry ou fatal.

### 3.3 `enterDispatchLoopWithResults` (§14.2 steps 13-15 branche continue)

```ts
async function enterDispatchLoopWithResults<S extends object>(
  ctx: DispatchContext<S>,
  state: StateFile<S>,
  pd: PendingDelegationRecord,
  loadedData: unknown | readonly unknown[] | null,
): Promise<never> {
  // Step 13 : log delegation_result_read.
  const jobCount = pd.jobIds?.length ?? 1;
  const filesLoaded = Array.isArray(loadedData) ? loadedData.length : 1;
  ctx.logger.emit({
    eventType: "delegation_result_read",
    runId: ctx.runId,
    phase: pd.resumeAt,       // on utilise resumeAt comme phase courante logique ici
    label: pd.label,
    jobCount,
    filesLoaded,
    timestamp: clock.nowWallIso(),
  });

  // Step 14 : transition en mémoire state.currentPhase = pd.resumeAt.
  //    PAS encore persister — pendingDelegation reste en place jusqu'à effacement §14.2 step 16.c.
  //    Le dispatch-loop fera le writeStateAtomic sur le prochain transition/done/fail qui cleane pendingDelegation.
  const stateForDispatch: StateFile<S> = {
    ...state,
    currentPhase: pd.resumeAt,  // mémoire seulement pour l'instant
    // pendingDelegation garde la valeur — permet au dispatch-loop d'identifier la phase de reprise
  };

  // Step 15 : entrer dans le dispatch-loop avec loadedResults.
  const loadedResults = {
    label: pd.label,
    kind: pd.kind,
    data: loadedData!,  // non-null garanti par allParseable === true
  };

  // input = undefined au resume (input non persisté, §6.2 C11).
  await runDispatchLoop(ctx, stateForDispatch, undefined, loadedResults);
  return undefined as never;  // runDispatchLoop ne retourne pas
}
```

**Règles** :

- **`state.currentPhase = pd.resumeAt` en mémoire uniquement** — persister serait prématuré (on veut préserver le pending pour retry cross-crash si la phase de reprise échoue mid-exécution). Le dispatch-loop persistera via `writeStateAtomic` dans la branche transition/done/fail.
- **`loadedResults` passé en RAM** au dispatch-loop — c'est le payload pour `consumePending*`.
- **`input === undefined` au resume** (C11) — aucune transition `input` ne survit à une délégation.

### 3.4 `handleDelegationError` — décision retry ou fatal (§14.2 step 12.d-e)

```ts
async function handleDelegationError<S extends object>(
  ctx: DispatchContext<S>,
  state: StateFile<S>,
  pd: PendingDelegationRecord,
  kind: "delegation_timeout" | "delegation_schema",
  message: string,
): Promise<never> {
  const errClass = kind === "delegation_timeout" ? DelegationTimeoutError : DelegationSchemaError;
  const err = new errClass(message, {
    runId: ctx.runId, orchestratorName: ctx.config.name, phase: pd.resumeAt,
  });

  // Malformed-only : émettre delegation_validation_failed avec path + fileSizeBytes (C10 PII).
  if (kind === "delegation_schema") {
    const firstMalformedPath = findFirstMalformedPath(ctx.runDir, pd);
    if (firstMalformedPath) {
      const sizeBytes = safeFileSize(firstMalformedPath);
      ctx.logger.emit({
        eventType: "delegation_validation_failed",
        runId: ctx.runId, phase: pd.resumeAt, label: pd.label,
        zodErrorSummary: `malformed JSON (path=${firstMalformedPath}, fileSizeBytes=${sizeBytes})`.slice(0, 200),
        timestamp: clock.nowWallIso(),
      });
    }
  }

  const decision = resolveRetryDecision(err, pd.attempt, pd.effectiveRetryPolicy);
  if (decision.retry === true) {
    // Branche retry §14.2 step 12.e.
    await executeResumeRetry(ctx, state, pd, decision);
    return undefined as never;
  }

  // Fatal.
  await emitFatalError(ctx, state, err);
  return undefined as never;
}

function findFirstMalformedPath(runDir: string, pd: PendingDelegationRecord): string | null {
  const paths = buildExpectedResultPaths(runDir, pd);
  for (const p of paths) {
    if (!fs.existsSync(p)) continue;
    try {
      const raw = fs.readFileSync(p, "utf-8");
      JSON.parse(raw);
    } catch {
      return p;
    }
  }
  return null;
}

function safeFileSize(p: string): number {
  try { return fs.statSync(p).size; } catch { return -1; }
}
```

### 3.5 `executeResumeRetry` — §14.2 step 12.e

Même logique que `executeRetryBranch` de `NIB-M-DISPATCH-LOOP` §4.5 — reconstruction manifest, per-attempt paths, update pendingDelegation (preserving effectiveRetryPolicy), émission DELEGATE, release lock, exit 0.

```ts
async function executeResumeRetry<S extends object>(
  ctx: DispatchContext<S>,
  state: StateFile<S>,
  pd: PendingDelegationRecord,
  decision: { retry: true; delayMs: number; reason: string },
): Promise<never> {
  // Log retry_scheduled.
  ctx.logger.emit({
    eventType: "retry_scheduled",
    runId: ctx.runId, phase: pd.resumeAt,   // resumeAt comme phase logique
    label: pd.label, attempt: pd.attempt + 1,
    delayMs: decision.delayMs, reason: decision.reason,
    timestamp: clock.nowWallIso(),
  });

  try {
    await abortableSleep(decision.delayMs, ctx.abortController.signal);
  } catch (e) {
    throw new AbortedError("aborted during resume retry sleep", {
      cause: e, runId: ctx.runId, phase: pd.resumeAt,
    });
  }

  // Reconstruction du nouveau manifest (M13, identique dispatch-loop §4.5).
  const oldManifestRaw = fs.readFileSync(pd.manifestPath, "utf-8");
  const oldManifest = JSON.parse(oldManifestRaw) as DelegationManifest;

  const newAttempt = pd.attempt + 1;
  const newEmittedAtEpochMs = clock.nowEpochMs();
  const newEmittedAt = clock.nowWallIso();
  const newDeadlineAtEpochMs = newEmittedAtEpochMs + oldManifest.timeoutMs;
  const newManifestPath = path.join(ctx.runDir, "delegations", `${pd.label}-${newAttempt}.json`);

  const newManifest = reconstructManifest(oldManifest, {
    attempt: newAttempt, emittedAt: newEmittedAt, emittedAtEpochMs: newEmittedAtEpochMs,
    deadlineAtEpochMs: newDeadlineAtEpochMs, label: pd.label, runDir: ctx.runDir,
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
    eventType: "delegation_emit",
    runId: ctx.runId, phase: pd.resumeAt,
    label: pd.label, kind: pd.kind,
    jobCount: pd.jobIds?.length ?? 1,
    timestamp: newEmittedAt,
  });

  // Émettre bloc DELEGATE.
  const resumeCmd = ctx.config.resumeCommand(ctx.runId);
  const binding = selectBinding(pd.kind);
  const block = (binding as any).buildProtocolBlock(newManifest, newManifestPath, resumeCmd);
  process.stdout.write(block);

  releaseLock(ctx.lockPath, ctx.handle, clock, ctx.logger, ctx.runId);
  process.exit(0);
}
```

**Note** : `reconstructManifest` est le même helper que dans `NIB-M-DISPATCH-LOOP` §4.5. Peut être extracted dans `src/engine/_shared.ts` si factorisation souhaitée, ou dupliqué (300 LOC vs 10 LOC de dedup — trade-off acceptable v1).

### 3.6 `emitFatalError` au resume

Même pattern que dans `NIB-M-DISPATCH-LOOP` §4.6 — émettre `phase_error` + `orchestrator_end` + bloc ERROR + release lock + exit 1.

```ts
async function emitFatalError<S extends object>(
  ctx: DispatchContext<S>,
  state: StateFile<S>,
  err: OrchestratorError,
): Promise<never> {
  enrich(err, { runId: ctx.runId, orchestratorName: ctx.config.name, phase: state.currentPhase });

  const nowIso = clock.nowWallIso();
  ctx.logger.emit({
    eventType: "phase_error",
    runId: ctx.runId, phase: state.currentPhase,
    errorKind: err.kind, message: err.message.slice(0, 200),
    timestamp: nowIso,
  });
  ctx.logger.emit({
    eventType: "orchestrator_end",
    runId: ctx.runId, orchestratorName: ctx.config.name,
    success: false, durationMs: state.accumulatedDurationMs,
    phasesExecuted: state.phasesExecuted,
    timestamp: nowIso,
  });

  const block = writeProtocolBlock("ERROR", {
    runId: ctx.runId, orchestrator: ctx.config.name,
    errorKind: err.kind, message: err.message.slice(0, 200),
    phase: state.currentPhase,
    phasesExecuted: state.phasesExecuted,
  });
  process.stdout.write(block);

  releaseLock(ctx.lockPath, ctx.handle, clock, ctx.logger, ctx.runId);
  process.exit(1);
}
```

---

## 4. Règles transversales

### 4.1 Table de décision §14.2 step 12.d

| Situation | Décision |
|---|---|
| `allParseable === true` | `enterDispatchLoopWithResults` → phase de reprise exécutée |
| `anyMalformed === true` | `DelegationSchemaError` → retry si budget, sinon fatal |
| `!allPresent && deadlinePassed` | `DelegationTimeoutError` → retry si budget, sinon fatal |
| `!allPresent && !deadlinePassed` | `DelegationMissingResultError` → fatal (bug parent agent, non retriable) |

**Priorité** (cohérent avec implémentation §3.1) :
1. Parseable gagne (déclenche continue sans condition deadline).
2. Malformed prioritaire sur missing — si un fichier est malformed, on retry/fail sans attendre deadline.
3. Missing + deadline dépassée → timeout.
4. Missing + deadline pas dépassée → missing fatal.

### 4.2 Per-attempt isolation (I-15)

Les fichiers d'`attempt` antérieurs sont **ignorés** :
- Attempt N ne lit **que** `<label>-N.json` ou `<label>-N/<id>.json`.
- Les orphelins de `<label>-(N-1).json` (sub-agent lent d'une tentative précédente) n'interfèrent pas.
- Testé T-RS-31.

### 4.3 Effacement de `pendingDelegation`

**Pas ici** — `handle-resume` ne touche pas à `state.pendingDelegation`. L'effacement arrive :
- Dans le dispatch-loop branche `transition`/`done`/`fail` (§14.1 step 16.n) quand la phase de reprise retourne son PhaseResult.
- Si la phase de reprise crash mid-execution, `pendingDelegation` reste en place → la re-reprise retente correctement.

### 4.4 Deadline strict `>`

`deadlinePassed = nowEpoch > pd.deadlineAtEpochMs` (strict). Égalité exacte = pas dépassé (T-TM-06). Cohérent avec §9.3 "durée max entre émission et disponibilité".

---

## 5. Tests NIB-T

### 5.1 Resume happy path (§17.1-§17.3)

- T-RS-01 à T-RS-06 : skill/batch resume, wrong-kind, validation.
- T-CS-01 à T-CS-05 : consumption check (délégués au dispatch-loop mais testés via handle-resume flow).

### 5.2 Deadline + classification (§17.4-§17.5, §22.bis.2)

- T-RS-10 à T-RS-13 : deadline × présence × parseabilité combinatoire.
- T-RS-14 à T-RS-18 : malformed JSON detection.
- T-TM-04, T-TM-05, T-TM-06 : deadline cross-reentry (strict `>`).

### 5.3 Resume preflight (§17.6)

- T-RS-19 à T-RS-23 : state mismatch (traité dans NIB-M-RUN-ORCHESTRATOR avant `handle-resume`, pas ici).
- T-RS-29 : `--resume` sans pending → throw ProtocolError ici.

### 5.4 Retry post-timeout (§18.2-§18.4)

- T-RT-02 : retry après timeout.
- T-RT-04 : exhausted après timeout.
- T-RT-06 à T-RT-08 : reconstruction manifest cohérente.

### 5.5 Per-attempt isolation (§17.9)

- T-RS-30 : attempt N lit `<label>-N.json`.
- T-RS-31 : attempt N ne lit pas `<label>-(N-1).json`.

---

## 6. Constraints

- **Pas de zod validation** — uniquement `JSON.parse` pour classification malformed/parseable.
- **Pas de logging du contenu malformed** (C10 PII) — seulement `path` + `fileSizeBytes`.
- **Per-attempt paths exclusive** — construction via `pd.attempt` courant.
- **`state.currentPhase = pd.resumeAt`** en mémoire uniquement — pas persisté par handle-resume.
- **Tous les exits** passent par release lock systématique (P-LOCK-RELEASE-SYSTEMATIC).
- **Imports figés** :
  - `node:fs`, `node:path`
  - Tous les services L4 nécessaires (clock, logger, lock, retry-resolver, abortable-sleep, protocol, state-io)
  - `NIB-M-BINDINGS` (pour `buildProtocolBlock` en retry)
  - `NIB-M-ERRORS`
  - `NIB-M-DISPATCH-LOOP` (`runDispatchLoop` pour la branche continue)

---

## 7. Definition of Done (DoD)

1. **1 fichier** : `src/engine/handle-resume.ts` avec export `runHandleResume`.
2. **Classification missing/malformed/parseable** via `classifyResultFiles`.
3. **Décision table §4.1** implémentée en entier avec priorité correcte.
4. **Branche continue** : log `delegation_result_read`, appel `runDispatchLoop` avec `loadedResults`.
5. **Branche retry** : reconstruction manifest + per-attempt paths + update pendingDelegation + émission DELEGATE + release lock + exit 0.
6. **Branche fatal** : `phase_error` + `orchestrator_end` + ERROR + release lock + exit 1.
7. **`state.currentPhase` non persisté** avant entrée dispatch.
8. **Per-attempt isolation** : seul `pd.attempt` courant consulté.
9. **PII discipline** : log malformed avec path + fileSizeBytes uniquement.
10. **Tests NIB-T** : §17, §18.2-§18.4, §22.bis.2.
11. **LOC** : 300-400.

---

## 8. Relation avec les autres NIB-M

- **Consomme** :
  - `NIB-M-DISPATCH-LOOP` (`runDispatchLoop` en branche continue)
  - `NIB-M-STATE-IO` (`writeStateAtomic`)
  - `NIB-M-LOCK` (`releaseLock`)
  - `NIB-M-LOGGER` (events)
  - `NIB-M-PROTOCOL` (`writeProtocolBlock`)
  - `NIB-M-RETRY-RESOLVER` (`resolveRetryDecision`)
  - `NIB-M-INFRA-UTILS` (`clock`, `abortableSleep`)
  - `NIB-M-BINDINGS` (`buildProtocolBlock` via `selectBinding` en retry)
  - `NIB-M-ERRORS` (all delegation errors)
- **Consommé par** : `NIB-M-RUN-ORCHESTRATOR` (mode resume).

---

## 9. Metadata

| Champ | Valeur |
|---|---|
| Source NX | §14.2 steps 11-15, §14.3 |
| NIB-T associé | §17 (RS), §18.2-§18.4 (RT), §22.bis.2 (TM) |
| Invariants NIB-S couverts | I-15 (per-attempt), P-LOCK-RELEASE-SYSTEMATIC, §7.3 (malformed → DelegationSchemaError) |
| Fichier produit | `src/engine/handle-resume.ts` |
| LOC cible | 300-400 |
| Non exporté publiquement | oui (interne engine) |

---

*turnlock — Implicit-Free Execution — "Reliability precedes intelligence."*
