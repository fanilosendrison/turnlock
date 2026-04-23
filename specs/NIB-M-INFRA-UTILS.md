---
id: NIB-M-INFRA-UTILS
type: nib-module
version: "1.0.0"
scope: turnlock
module: infra-utils
status: approved
consumers: [claude-code]
superseded_by: []
validates: ["src/services/abortable-sleep.ts", "src/services/clock.ts", "src/services/run-id.ts", "tests/services/abortable-sleep.test.ts", "tests/services/clock.test.ts", "tests/services/run-id.test.ts", "tests/temporal/temporal.test.ts"]
---

# NIB-M-INFRA-UTILS — Utilitaires techniques triviaux groupés

**Package** : `turnlock`
**Modules couverts** : `clock`, `run-id`, `abortable-sleep`
**Source NX** : §5.5 (transverse services), §12 (modèle temporel), §13.4 (abort propagé)
**NIB-T associé** : §9 (T-CK-01 à T-CK-08 + P-CK-a/b), §8 (T-ID-01 à T-ID-04 + P-ID-a), §10 (T-AS-01 à T-AS-05 + P-AS-a/b)
**NIB-S référencé** : §9 (modèle temporel 3 horloges), I-5 (déterminisme mécanique)

---

## 1. Purpose

Regroupe 3 utilitaires techniques triviaux dont l'implémentation tient en ~10-20 lignes chacun, mais dont la mockabilité est **critique** pour les tests déterministes du reste du runtime :

- **`clock`** — abstraction des 3 horloges (wall ISO, wall epoch ms, monotonic). Toutes les autres modules qui ont besoin du temps passent par ce module.
- **`run-id`** — génération d'ULID pour `runId` et `ownerToken` (lock).
- **`abortable-sleep`** — sleep interruptible par un `AbortSignal`, utilisé pour les backoffs de retry.

**Pourquoi les grouper** : chaque utilitaire fait <30 LOC runtime. Les séparer en 3 NIB-M créerait de la fragmentation. Leur cohésion : tous sont des **primitives d'infra non-sémantiques** que l'engine injecte aux services. Pattern identique à `NIB-M-INFRA-UTILS` de `llm-runtime` (clock + callId-generator + logger).

**Fichiers cibles** :
- `src/services/clock.ts` — ~20 LOC
- `src/services/run-id.ts` — ~10 LOC
- `src/services/abortable-sleep.ts` — ~25 LOC

**LOC cible** : ~60 total + tests séparés par fichier.

---

## 2. Module A — `clock`

### 2.1 Signature

```ts
// src/services/clock.ts

export interface Clock {
  nowWall(): Date;
  nowWallIso(): string;
  nowEpochMs(): number;
  nowMono(): number;
}

export const clock: Clock;
```

### 2.2 Implémentation

```ts
export const clock: Clock = {
  nowWall: () => new Date(),
  nowWallIso: () => new Date().toISOString(),
  nowEpochMs: () => Date.now(),
  nowMono: () => performance.now(),
};
```

### 2.3 Règles normatives

- **Discipline d'usage cross-modules** (§9 NIB-S) :
  - `nowWallIso` : `StateFile.startedAt`, `StateFile.lastTransitionAt`, `DelegationManifest.emittedAt`, tous les `timestamp` d'events.
  - `nowEpochMs` : `StateFile.startedAtEpochMs`, `lastTransitionAtEpochMs`, `DelegationManifest.emittedAtEpochMs`, `deadlineAtEpochMs`, `LockFile.acquiredAtEpochMs`, `leaseUntilEpochMs`. **Toute arithmétique cross-process**.
  - `nowMono` : `phase_end.durationMs`, `accumulatedDurationMs`, sleeps internes.
- **Jamais utilisée cross-process** pour `nowMono` — `performance.now()` est relatif au démarrage du process courant.
- **Mockabilité** : tous les modules consommateurs reçoivent `clock` via injection de dépendance ou import du module. Les tests peuvent remplacer par un `MockClock` (§28.2 NIB-T) qui implémente `Clock` avec setters `setWall`/`advanceEpoch`/`advanceMono`.

### 2.4 Tests NIB-T (rappel §9)

| Test | Propriété |
|---|---|
| T-CK-01 | `nowWall()` retourne un `Date` |
| T-CK-02 | `nowWallIso()` retourne ISO 8601 UTC (regex `\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z`) |
| T-CK-03 | `nowEpochMs()` retourne number ≥ 0 |
| T-CK-04 | `nowMono()` retourne number ≥ 0 |
| T-CK-05 à T-CK-07 | Mockabilité via `setWall`/`advanceEpoch`/`advanceMono` |
| T-CK-08 | `setWall` en arrière n'affecte pas `nowMono` (immunité clock jump) |
| P-CK-a | N × `advanceMono(dx)` → `nowMono === initial + sum(dx)` |
| P-CK-b | `nowMono` ≥ valeurs précédentes (monotonicité) |

### 2.5 Edge cases

| Cas | Comportement |
|---|---|
| Deux appels à `nowEpochMs()` simultanés | Peuvent retourner la même valeur (granularité ms). Accepté. |
| `new Date()` avec système en 1970 | `nowEpochMs() === 0`. Défensif : les tests utilisent des mocks, pas la vraie horloge. |
| `performance.now()` en Node < 16 | Non supporté — Node ≥ 22 obligatoire (§5.7 NX). |

---

## 3. Module B — `run-id`

### 3.1 Signature

```ts
// src/services/run-id.ts

export function generateRunId(): string;
```

### 3.2 Implémentation

```ts
import { ulid } from "ulid";
export function generateRunId(): string {
  return ulid();
}
```

### 3.3 Règles normatives

- Format **ULID** : 26 caractères Crockford base32, regex `/^[0-9A-HJKMNP-TV-Z]{26}$/`.
- Tri lexicographique ≡ tri chronologique (propriété ULID native).
- **Pas de fallback** : si `ulid` throw (ne devrait jamais arriver), propager l'exception. Le runtime exit en bloc ERROR preflight.
- **Usage unique** : `generateRunId` est utilisé pour le `runId` et pour le `ownerToken` du lock (cf `NIB-M-LOCK`). Même fonction, deux call sites.
- Mockabilité : les tests peuvent stub `ulid()` via module mock (bun:test `mock.module` / `spyOn`) pour des IDs déterministes.

### 3.4 Tests NIB-T (rappel §8)

| Test | Propriété |
|---|---|
| T-ID-01 | Format regex ULID |
| T-ID-02 | Longueur 26 |
| T-ID-03 | 100 IDs successifs tous distincts |
| T-ID-04 | 2 IDs à la même ms lexicographiquement croissants (ou égaux si collision random ultra-rare) |
| P-ID-a | 1000 IDs avec mock clock avançant d'1 ms/call : tri lexicographique ≡ tri chronologique |

### 3.5 Edge cases

| Cas | Comportement |
|---|---|
| Deux appels à la même ms | ULID gère via randomness 80 bits. Pas de collision pratique. |
| Appel depuis un sub-process | Chaque process a son propre ULID namespace (OK). |

---

## 4. Module C — `abortable-sleep`

### 4.1 Signature

```ts
// src/services/abortable-sleep.ts

export function abortableSleep(delayMs: number, signal: AbortSignal): Promise<void>;
```

### 4.2 Implémentation

```ts
export function abortableSleep(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(new AbortedError("aborted before sleep", { cause: signal.reason }));
  }
  if (delayMs <= 0) return Promise.resolve();

  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);

    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(new AbortedError("aborted during sleep", { cause: signal.reason }));
    };

    signal.addEventListener("abort", onAbort, { once: true });
  });
}
```

**Note** : `AbortedError` importé depuis `../errors/concrete` (NIB-M-ERRORS).

### 4.3 Règles normatives

- **Pré-check** : si `signal.aborted === true` au moment de l'appel → reject immédiat `AbortedError`. Pas d'attente, pas de timer créé.
- **`delayMs <= 0`** → resolve immédiat (cohérent `setTimeout(0)`). Pas de timer non plus.
- **Cleanup systématique** : quand la Promise resolve ou reject, `setTimeout` est clear et le listener `abort` est removed. Pas de leak de timer ni de handler.
- **Abort prioritaire** : si `abort` et `delay` sont simultanés, `abort` gagne (le listener execute `reject` avant que le timer ne tire si tous deux sont dans la même tick).
- **Reject = `AbortedError` typé** : pas une `DOMException` brute. Cohérent avec I-4 (fail-closed) + P-SEM-THROW.
- **Pas de try/catch global** : les bugs de `setTimeout` (jamais en pratique) propagent naturellement.

### 4.4 Tests NIB-T (rappel §10)

| Test | Scénario | Comportement |
|---|---|---|
| T-AS-01 | `delayMs: 100`, signal non abortée, mock clock +100ms | Resolve |
| T-AS-02 | Signal aborted au début | Reject `AbortedError` immédiat |
| T-AS-03 | Abort à 50ms sur `delayMs: 100` | Reject à 50ms |
| T-AS-04 | `delayMs: 0` | Resolve immédiat |
| T-AS-05 | `delayMs: -100` | Resolve immédiat (≤ 0) |
| P-AS-a | Pas de timer résiduel après resolve/reject (vérifié via mock `setTimeout`/`clearTimeout`) |
| P-AS-b | Abort toujours gagne sur delay si simultanés |

### 4.5 Edge cases

| Cas | Comportement |
|---|---|
| `signal.aborted === true` avant appel | Reject immédiat sans créer timer |
| Signal abort pendant un sleep long | Reject + clearTimeout propre |
| Appels concurrents avec le même signal | Chacun indépendant — chacun add son propre listener once ; tous reject quand abort fire |
| `setTimeout` ID collision (théorique) | Node gère nativement, pas de problème v1 |

---

## 5. Constraints (transversales)

- **Aucune dépendance croisée entre les 3 modules**. `clock` est totalement indépendant, `run-id` import `ulid` (externe), `abortable-sleep` import `AbortedError` (NIB-M-ERRORS).
- **Pas de logique métier** — ce sont des primitives techniques pures. Pas de retry, pas de validation, pas de formatage custom.
- **Testable en isolation** — chaque module a son propre fichier de test (§9, §8, §10 NIB-T), pas de dépendances mutuelles.
- **Mockabilité via module mock** — les tests d'autres modules (engine, bindings) mockent `clock` et `abortableSleep` via `mock.module("../services/clock", () => ({ ... }))` (bun:test) et injectent leur propre `Clock`.

---

## 6. Integration snippets

### 6.1 Consommation par l'engine

```ts
// src/engine/dispatch-loop.ts
import { clock } from "../services/clock";
import { abortableSleep } from "../services/abortable-sleep";

const phaseStartMono = clock.nowMono();
// ... phase execution ...
const phaseDurationMs = Math.round(clock.nowMono() - phaseStartMono);

// Retry branch :
await abortableSleep(retryDecision.delayMs!, abortController.signal);
```

### 6.2 Consommation par run-orchestrator

```ts
// src/engine/run-orchestrator.ts
import { generateRunId } from "../services/run-id";
import { clock } from "../services/clock";

const runId = argv.runId ?? generateRunId();
const startedAt = clock.nowWallIso();
const startedAtEpochMs = clock.nowEpochMs();
```

### 6.3 Consommation par lock

```ts
// src/services/lock.ts
import { clock } from "./clock";
import { generateRunId as generateOwnerToken } from "./run-id";  // réutilise ulid()

const ownerToken = generateOwnerToken();
const acquiredAtEpochMs = clock.nowEpochMs();
const leaseUntilEpochMs = acquiredAtEpochMs + DEFAULT_IDLE_LEASE_MS;
```

---

## 7. Definition of Done (DoD)

1. **3 fichiers** créés : `src/services/clock.ts`, `src/services/run-id.ts`, `src/services/abortable-sleep.ts`.
2. **`clock` expose** `nowWall`, `nowWallIso`, `nowEpochMs`, `nowMono` avec sémantique §2.3.
3. **`generateRunId`** retourne un ULID 26 chars.
4. **`abortableSleep`** :
   - Reject immédiat si `signal.aborted === true` au call
   - Resolve immédiat si `delayMs <= 0`
   - Reject `AbortedError` (pas DOMException) si abort pendant l'attente
   - Cleanup : `clearTimeout` + `removeEventListener` systématique (pas de leak)
5. **Tests NIB-T passent** : T-CK-01 à T-CK-08, P-CK-a/b, T-ID-01 à T-ID-04, P-ID-a, T-AS-01 à T-AS-05, P-AS-a/b.
6. **Aucun module n'importe de dépendance non-listée** : `clock` zéro import, `run-id` ↔ `ulid`, `abortable-sleep` ↔ `../errors/concrete`.
7. **LOC cumulée** : 50-80 runtime (hors tests).
8. **Exports nominatifs** depuis chaque fichier. `clock` est un const singleton exporté, `generateRunId` et `abortableSleep` sont des functions nommées.

---

## 8. Relation avec les autres NIB-M

- **Consommé par** :
  - `NIB-M-STATE-IO` (clock pour timestamps)
  - `NIB-M-LOCK` (clock + generateRunId pour ownerToken)
  - `NIB-M-LOGGER` (clock pour event timestamps)
  - `NIB-M-PROTOCOL` (rien — protocole n'a pas besoin de clock, les timestamps viennent d'en haut)
  - `NIB-M-RUN-ORCHESTRATOR` (clock + generateRunId pour runId)
  - `NIB-M-DISPATCH-LOOP` (clock + abortableSleep pour retry)
  - `NIB-M-HANDLE-RESUME` (clock pour deadline comparison + abortableSleep pour retry pré-dispatch)
  - `NIB-M-BINDINGS` (rien — les bindings reçoivent le context déjà rempli avec emittedAt/emittedAtEpochMs)
- **Consomme** : `NIB-M-ERRORS` (`AbortedError` pour `abortableSleep`), `ulid` (externe).

---

## 9. Metadata

| Champ | Valeur |
|---|---|
| Source NX | §5.5, §9 (clock API), §12 (modèle temporel), §13.4 |
| NIB-T associé | §8 (run-id), §9 (clock), §10 (abortable-sleep) |
| Invariants NIB-S couverts | I-5 (déterminisme), §9 (horloges) |
| Fichiers produits | `src/services/clock.ts`, `src/services/run-id.ts`, `src/services/abortable-sleep.ts` |
| LOC cible | ~60 runtime cumulé |
| Non exporté publiquement | le `Clock` type peut être exporté publiquement (référencé depuis `PhaseIO.clock`), mais `clock` singleton, `generateRunId`, `abortableSleep` sont internes |

---

*turnlock — Implicit-Free Execution — "Reliability precedes intelligence."*
