---
id: NIB-M-LOGGER
type: nib-module
version: "1.0.0"
scope: turnlock
module: logger
status: approved
consumers: [claude-code]
superseded_by: []
validates: ["src/services/logger.ts", "src/types/events.ts", "tests/observability/events-ndjson.test.ts", "tests/observability/events-taxonomy.test.ts", "tests/observability/pii.test.ts"]
---

# NIB-M-LOGGER — Double-emitter stderr + `events.ndjson` owner-only

**Package** : `turnlock`
**Source NX** : §5.5 (logger), §6.7 (OrchestratorEvent), §7.5 (events.ndjson), §11 (observabilité), C14 owner-only
**NIB-T associé** : §23 (T-OB-01 à T-OB-13 taxonomie, P-OB-a/b/c), §24 (T-EV-01 à T-EV-14 events.ndjson, P-EV-a/b/c), §25 (T-OB-20 à T-OB-23 PII, P-OB-d)
**NIB-S référencé** : §5 P-NO-PII + P-OWNER-ONLY-LOG, §6.7 (11 events), §6.8 (LoggingPolicy), I-6 (observabilité obligatoire), I-13 (PII)

---

## 1. Purpose

Module qui produit le **logger** interne consommé par tous les modules, et gère le **double-emit conditionnel** vers :
- **stderr** — un JSON par ligne, toujours actif (sauf `LoggingPolicy.enabled === false`).
- **`$RUN_DIR/events.ndjson`** — append-only owner-only, activé **après acquire du lock** (C14).

Le logger custom fourni par `LoggingPolicy.logger` **remplace** l'émission stderr uniquement ; `events.ndjson` reste écrit owner-only (sauf `persistEventLog: false`).

**Principe normatif structurant — owner-only (C14)** : un contender bloqué sur `RunLockedError` avant acquire ne doit **jamais** écrire dans `events.ndjson` de l'owner actif. Cette garantie passe par une **activation différée** du file emitter : seul le process qui a acquis le lock active l'écriture disque.

**Fichier cible** : `src/services/logger.ts`

**LOC cible** : ~150-200.

---

## 2. Signatures

```ts
import type { OrchestratorEvent } from "../types/events";  // 11-union défini dans PUBLIC-API

export interface OrchestratorLogger {
  emit(event: OrchestratorEvent): void;
}

export interface LoggingPolicy {
  readonly logger?: OrchestratorLogger;       // override stderr default
  readonly enabled: boolean;                   // défaut true
  readonly persistEventLog?: boolean;          // défaut true
}

/**
 * Construit le logger interne au démarrage d'un process.
 * Stderr emitter actif immédiatement (ou logger custom si fourni).
 * Disk emitter inactif — à activer via enableDiskEmit() après acquire lock.
 * Si `policy.enabled === false` : logger no-op total.
 */
export function createLogger(policy: LoggingPolicy | undefined): InternalLogger;

export interface InternalLogger extends OrchestratorLogger {
  /** Active l'écriture disque à $RUN_DIR/events.ndjson. Appelé UNIQUEMENT après acquire lock. */
  enableDiskEmit(eventsNdjsonPath: string): void;
  /** Désactive explicitement (utilisé si policy.persistEventLog === false au démarrage). No-op si jamais activé. */
  disableDiskEmit(): void;
}
```

**Note** : `OrchestratorEvent` est un type union discriminé à 11 variantes, défini dans `src/types/events.ts` (co-owné par NIB-M-PUBLIC-API pour l'export public + NIB-M-LOGGER pour la consommation). Le source de vérité shape est §6.7 NIB-S.

---

## 3. Algorithme — `createLogger`

### 3.1 Cas 1 — Disabled total

```ts
if (policy?.enabled === false) {
  return {
    emit: () => {},                 // no-op
    enableDiskEmit: () => {},
    disableDiskEmit: () => {},
  };
}
```

**Règle** : `enabled: false` coupe stderr ET events.ndjson (double-porte unique). `persistEventLog` est ignoré (T-EV-03).

### 3.2 Cas 2 — Enabled (défaut)

```ts
// Emitter stderr (ou custom logger si fourni)
const stderrEmit: (ev: OrchestratorEvent) => void =
  policy?.logger
    ? (ev) => policy.logger!.emit(ev)
    : (ev) => process.stderr.write(JSON.stringify(ev) + "\n");

// État disk emitter (mutable fermeture)
let diskPath: string | null = null;
const persistEnabled = policy?.persistEventLog !== false;  // défaut true

function emit(ev: OrchestratorEvent): void {
  // 1. Validation minimale de l'event (défensive — les callers sont censés produire des events bien formés)
  //    Pas de validation lourde ici — TS garantit la shape via union discriminée.
  //    Seulement check que eventType et runId sont string non-vides (défaut défensif).

  // 2. Emit stderr (ou custom)
  try {
    stderrEmit(ev);
  } catch {
    // Silent fail : un logger custom buggé ne doit pas crasher le runtime.
    // C'est une violation du contrat logger (§14.1 step N NX) mais on reste tolérant défensivement.
  }

  // 3. Emit disk si activé
  if (diskPath !== null) {
    try {
      fs.appendFileSync(diskPath, JSON.stringify(ev) + "\n", { encoding: "utf-8" });
    } catch {
      // Silent fail : un FS qui throw pendant append ne doit pas crasher.
      // Accepté : perte au pire des derniers events en vol (§7.5 NX "Pas de flush explicite").
    }
  }
}

function enableDiskEmit(eventsNdjsonPath: string): void {
  if (!persistEnabled) return;  // policy.persistEventLog === false → pas d'activation
  diskPath = eventsNdjsonPath;
  // Note : le fichier est créé au premier appendFileSync (mode "a" implicite).
}

function disableDiskEmit(): void {
  diskPath = null;
}

return { emit, enableDiskEmit, disableDiskEmit };
```

### 3.3 Règles normatives

- **Stderr actif immédiatement** dès `createLogger` — permet d'émettre les events préflight `phase_error`/`orchestrator_end` sur stderr avant l'acquire du lock (C14 : stderr before preflight).
- **Disk emit gated** : activation uniquement après `enableDiskEmit(path)`. L'engine l'appelle **après acquire lock réussi** dans `runOrchestrator` (§14.1 step 7 + §14.2 step 10). C14 garantit owner-only.
- **`policy.persistEventLog === false`** : `enableDiskEmit` est no-op. Le fichier n'est jamais créé.
- **Logger custom fourni** : remplace uniquement stderr, pas disque. Le caller peut supprimer stderr en fournissant un logger et activer `persistEventLog: true` (pattern testable avec sink en mémoire).
- **Silent fail** sur stderr custom + disk append — un logger buggé ou un FS saturé ne doit pas crasher le runtime. Discipline : les logs sont une obligation **observable** (I-6), mais pas une obligation **bloquante**.
- **Synchrone** : `process.stderr.write` est sync, `fs.appendFileSync` est sync. Acceptable car events rares (~5-30/run, ~100 max, §7.5 NX).
- **UTF-8 + LF** : `JSON.stringify` produit de l'ASCII-safe UTF-8, suffixé par `\n` literal (LF pur, pas de CRLF auto sur Windows — le runtime vise POSIX v1).
- **Pas de rotation, pas de buffer, pas de batch** : une ligne par event, append immédiat.

---

## 4. Contract sur l'émission (owner-only)

### 4.1 Séquence au démarrage initial (§14.1 step 6-7)

```
runOrchestrator() {
  // Step 6 : install stderr logger uniquement
  const logger = createLogger(config.logging);

  // Step 7 : acquire lock
  const lockResult = acquireLock(...);
  if (lockResult instanceof RunLockedError) {
    // Préflight ERROR — stderr peut émettre phase_error et orchestrator_end, PAS disk
    logger.emit({ eventType: "phase_error", ... });
    // Pas d'events.ndjson créé par ce contender (C14)
    process.stdout.write(errorProtocolBlock);
    process.exit(2);
  }

  // Step 7 bis : acquire réussi — activer disk emit
  logger.enableDiskEmit(path.join(runDir, "events.ndjson"));

  // Tous les events suivants → stderr + events.ndjson
  logger.emit({ eventType: "orchestrator_start", ... });
  // ...
}
```

### 4.2 Séquence au resume (§14.2 step 8-10)

Identique — stderr logger au step 8, acquire lock au step 10, `enableDiskEmit` immédiatement après acquire réussi.

### 4.3 Garantie C14 testée par T-EV-13

Un contender (second process avec même runId) bloqué sur `RunLockedError` au step 7 :
- émet `phase_error` + `orchestrator_end` sur stderr
- n'émet **rien** dans `events.ndjson` (car `enableDiskEmit` jamais appelé sur son logger)
- → file size de `events.ndjson` de l'owner reste inchangée

---

## 5. Validation d'event à l'émission (discipline PII)

Le logger **ne valide pas** les events au runtime (pas de zod sur la shape — TS garantit). Mais il applique une discipline :

- **Events émis par des callers internes uniquement** — pas de surface publique qui laisse un caller injecter un event.
- **`phase_error.message`** : le caller doit tronquer à 200 chars **avant** d'appeler `emit` (responsabilité partagée).
- **`delegation_validation_failed.zodErrorSummary`** : fourni par `summarizeZodError` qui garantit ≤ 200 chars (NIB-M-VALIDATOR §3).

Le logger ne **retronque pas** — il fait confiance aux callers.

**P-OB-d (absence PII)** testée : sur un run jouet avec prompts marqués (canaries strings), aucune ligne de `events.ndjson` ni stderr ne doit contenir les canaries.

---

## 6. Tests NIB-T (rappels)

### 6.1 Taxonomie d'events (§23)

| Test | Événement | Champs obligatoires |
|---|---|---|
| T-OB-01 | `orchestrator_start` | runId, orchestratorName, initialPhase, timestamp |
| T-OB-02 | `phase_start` | runId, phase, attemptCount, timestamp |
| T-OB-03 | `phase_end` | runId, phase, durationMs, resultKind, timestamp |
| T-OB-04 | `delegation_emit` | runId, phase, label, kind, jobCount, timestamp |
| T-OB-05 | `delegation_result_read` | runId, phase, label, jobCount, filesLoaded, timestamp |
| T-OB-06 | `delegation_validated` | runId, phase, label, timestamp |
| T-OB-07 | `delegation_validation_failed` | runId, phase, label, zodErrorSummary (≤200), timestamp |
| T-OB-08 | `retry_scheduled` | runId, phase, label, attempt, delayMs, reason, timestamp |
| T-OB-09 | `phase_error` | runId, phase, errorKind, message (≤200), timestamp |
| T-OB-10 | `lock_conflict` | runId, reason, currentOwnerToken?, timestamp |
| T-OB-11 | `orchestrator_end` | runId, orchestratorName, success, durationMs, phasesExecuted, timestamp |
| T-OB-12/13 | Fermeture | Pas d'autre eventType hors liste |

**Note** : la validation de shape (champs obligatoires + types) est **testée sur les événements émis par l'engine**, pas dans le logger lui-même (qui fait confiance aux callers). Tests NIB-T §23 vérifient que les events produits par les flux engine matchent le schéma.

### 6.2 events.ndjson (§24)

| Test | Couverture |
|---|---|
| T-EV-01 | Fichier créé au premier event owner (post-enableDiskEmit) |
| T-EV-02 | `persistEventLog: false` → pas de fichier |
| T-EV-03 | `enabled: false` → ni stderr ni disque |
| T-EV-04 | Contender RunLockedError → pas d'écriture au fichier de l'owner |
| T-EV-05 à T-EV-08 | Format NDJSON strict (LF, UTF-8, JSON parseable, pas de ligne vide) |
| T-EV-09/10 | Append-only (ancien contenu inchangé, crash recovery via append) |
| T-EV-11 | Reconstruction flux via events.ndjson (5 phases + 2 délégations) |
| T-EV-12 | Jamais de `state.data` dans un event (§4.12 invariant) |
| T-EV-13 | Owner-only (C14) — file size inchangée par contender |
| T-EV-14 | Stderr actif avant acquire (preflight errors visibles) |
| P-EV-a | Append-only strict (taille monotone croissante) |
| P-EV-b | Ordre des lignes = ordre d'émission |
| P-EV-c | N events → N lignes exactement |

### 6.3 PII (§25)

| Test | Vérification |
|---|---|
| T-OB-20 | Prompt "super secret" jamais dans events |
| T-OB-21 | Résultat contenu jamais dans events |
| T-OB-22 | Malformed JSON : log path + fileSizeBytes, pas le contenu |
| T-OB-23 | `phase_error.message` tronqué à 200 chars |
| P-OB-d | Canaries dans prompts/résultats → absents des logs |

---

## 7. Constraints

- **Synchrone** — `process.stderr.write` et `fs.appendFileSync`. Bloquant mais events sont rares et courts.
- **Pas de buffer** — chaque event est émis immédiatement. Pas de risque de perdre un event en mémoire si le process crash.
- **Pas de rotation** — un run = un fichier (append cross-invocations du même owner).
- **Pas de flush fsync explicite** — repose sur le flush implicite du kernel. Accepté pour cas v1 (SIGKILL peut perdre les derniers events en vol).
- **No-cleanup à disable** — `disableDiskEmit` set `diskPath = null`. Le fichier existant n'est pas supprimé.
- **Idempotence `enableDiskEmit`** — appels successifs remplacent `diskPath` (comportement non testé, en pratique appelé une seule fois par l'engine après acquire lock).
- **Imports figés** :
  - `node:fs` (`fs.appendFileSync`)
  - `node:process` (implicite — `process.stderr`)
  - `../types/events` (types `OrchestratorEvent`)

---

## 8. Integration snippets

### 8.1 Émission depuis l'engine

```ts
import { createLogger } from "../services/logger";

// Au démarrage
const logger = createLogger(config.logging);

// Avant acquire lock : stderr only
logger.emit({
  eventType: "phase_error",
  runId: "unknown",  // cas préflight
  phase: "preflight",
  errorKind: "invalid_config",
  message: err.message.slice(0, 200),
  timestamp: clock.nowWallIso(),
});

// Après acquire lock
logger.enableDiskEmit(path.join(runDir, "events.ndjson"));
logger.emit({
  eventType: "orchestrator_start",
  runId,
  orchestratorName: config.name,
  initialPhase: config.initial,
  timestamp: clock.nowWallIso(),
});
```

### 8.2 Logger custom via LoggingPolicy

```ts
const sink: OrchestratorEvent[] = [];
runOrchestrator({
  ...config,
  logging: {
    enabled: true,
    logger: { emit: (ev) => sink.push(ev) },
    persistEventLog: false,  // tests unitaires : pas d'I/O disque
  },
});
// sink contient tous les events.
```

---

## 9. Definition of Done (DoD)

1. **1 fichier** créé : `src/services/logger.ts` avec `createLogger`, `InternalLogger`, re-exports `OrchestratorLogger` / `OrchestratorEvent` / `LoggingPolicy` depuis `../types/events` et `../types/policies`.
2. **`createLogger`** :
   - `enabled: false` → logger no-op total.
   - `enabled: true` (défaut) + pas de `logger` custom → stderr emit activé immédiatement.
   - `enabled: true` + `logger` custom fourni → custom remplace stderr.
   - Disk emit gated par `enableDiskEmit(path)` et `persistEventLog` policy.
3. **`enableDiskEmit`** :
   - No-op si `persistEventLog === false`.
   - Sinon active `fs.appendFileSync` au path fourni.
4. **`disableDiskEmit`** :
   - Set `diskPath = null`.
   - No-op si jamais activé.
5. **Silent fail** sur stderr custom et disk append (tolérance aux buggy loggers / FS saturé).
6. **Synchrone** strict.
7. **Tests NIB-T** :
   - Taxonomie §23 (shape events, testée end-to-end via engine, pas directement sur logger)
   - events.ndjson §24 (créé au premier event, format NDJSON, append-only, owner-only, `persistEventLog: false` opt-out, `enabled: false` double-porte)
   - PII §25 (canaries absents)
8. **LOC** : 150-200.

---

## 10. Relation avec les autres NIB-M

- **Consomme** : `node:fs`, `node:process`, types `OrchestratorEvent` / `LoggingPolicy` (co-définis avec NIB-M-PUBLIC-API).
- **Consommé par** : tous les modules qui émettent des events.
  - `NIB-M-RUN-ORCHESTRATOR` (orchestrator_start, phase_error preflight)
  - `NIB-M-DISPATCH-LOOP` (phase_start, phase_end, delegation_emit, delegation_validated/failed, retry_scheduled, phase_error, orchestrator_end)
  - `NIB-M-HANDLE-RESUME` (delegation_result_read, delegation_validated/failed)
  - `NIB-M-LOCK` (lock_conflict)
- **Pas de dépendance vers** `NIB-M-ERRORS` (le logger manipule des events, pas des erreurs directement).

---

## 11. Metadata

| Champ | Valeur |
|---|---|
| Source NX | §5.5, §6.7, §7.5, §11, C14 |
| NIB-T associé | §23 (OB taxonomie), §24 (EV events.ndjson), §25 (PII) |
| Invariants NIB-S couverts | I-6 (observabilité), I-13 (PII), P-OWNER-ONLY-LOG (§5) |
| Fichier produit | `src/services/logger.ts` |
| LOC cible | 150-200 |
| Non exporté publiquement | `createLogger` et `InternalLogger` internes ; `OrchestratorLogger` / `OrchestratorEvent` / `LoggingPolicy` exportés via NIB-M-PUBLIC-API |

---

*turnlock — Implicit-Free Execution — "Reliability precedes intelligence."*
