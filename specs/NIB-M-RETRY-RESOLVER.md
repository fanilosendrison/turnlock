---
id: NIB-M-RETRY-RESOLVER
type: nib-module
version: "1.0.0"
scope: turnlock
module: retry-resolver
status: approved
consumers: [claude-code]
superseded_by: []
validates: ["src/services/retry-resolver.ts", "src/types/policies.ts", "tests/services/retry-resolver.test.ts", "tests/engine/run-retry.test.ts"]
---

# NIB-M-RETRY-RESOLVER — Décision de retry matérialisée

**Package** : `turnlock`
**Source NX** : §8.2 (table de décision), §9.2 (policy), §10.1 (RetryDecision)
**NIB-T associé** : §2 (T-RR-01 à T-RR-23, P-RR-a/b/c/d/e)
**NIB-S référencé** : §6.8 (RetryPolicy + defaults + effectiveRetryPolicy), §8 (taxonomie), §7.7 (RetryDecision shape), I-5 (déterminisme)

---

## 1. Purpose

Fonction pure **`resolveRetryDecision`** qui décide, pour une erreur donnée + un compteur de tentatives + une policy, s'il faut retry et après combien de ms. Résultat matérialisé comme objet `RetryDecision` explicite, observable, testable en isolation.

**Principe normatif structurant — décision matérialisée (§4.1 NX)** : le retry est **pas** une boucle ad-hoc dans le catch — c'est une fonction pure qui transforme `(error, attempt, policy) → RetryDecision`. Le caller (engine) consomme le résultat sans logique additionnelle : si `retry === true`, il sleep et ré-émet ; sinon il fail-closed.

**Fichier cible** : `src/services/retry-resolver.ts`

**LOC cible** : ~80-120.

---

## 2. Signatures

```ts
import type { OrchestratorError } from "../errors/base";

export interface RetryPolicy {
  readonly maxAttempts: number;           // défaut 3
  readonly backoffBaseMs: number;         // défaut 1000
  readonly maxBackoffMs: number;          // défaut 30000
}

export type RetryDecisionReason =
  | "transient_timeout"
  | "transient_schema"
  | "retry_exhausted"
  | "fatal_invalid_config"
  | "fatal_state_corrupted"
  | "fatal_state_missing"
  | "fatal_state_version_mismatch"
  | "fatal_delegation_missing_result"
  | "fatal_phase_error"
  | "fatal_protocol"
  | "fatal_aborted"
  | "fatal_run_locked"
  | "fatal_unknown";

export type RetryDecision =
  | { readonly retry: false; readonly reason: RetryDecisionReason }
  | { readonly retry: true; readonly delayMs: number; readonly reason: RetryDecisionReason };

export function resolveRetryDecision(
  error: OrchestratorError | Error,
  attempt: number,              // 0-indexé
  policy: RetryPolicy
): RetryDecision;

// Constantes de defaults (exportées pour cohérence — consommées par NIB-M-DISPATCH-LOOP
// lors de la résolution effectiveRetryPolicy).
export const DEFAULT_MAX_ATTEMPTS = 3;
export const DEFAULT_BACKOFF_BASE_MS = 1000;
export const DEFAULT_MAX_BACKOFF_MS = 30000;
```

---

## 3. Algorithme

### 3.1 Pipeline

```ts
export function resolveRetryDecision(
  error: OrchestratorError | Error,
  attempt: number,
  policy: RetryPolicy
): RetryDecision {
  // 1. Classification par kind (ou fallback "unknown" pour non-OrchestratorError).
  const kind = isOrchestratorError(error) ? error.kind : "unknown";

  // 2. Non-retriables (fatals par classification) → retry: false avec reason "fatal_<kind>".
  //    Note : "unknown" est traité comme fatal (v1 ne retry pas les erreurs non classifiées).
  switch (kind) {
    case "invalid_config": return { retry: false, reason: "fatal_invalid_config" };
    case "state_corrupted": return { retry: false, reason: "fatal_state_corrupted" };
    case "state_missing": return { retry: false, reason: "fatal_state_missing" };
    case "state_version_mismatch": return { retry: false, reason: "fatal_state_version_mismatch" };
    case "delegation_missing_result": return { retry: false, reason: "fatal_delegation_missing_result" };
    case "phase_error": return { retry: false, reason: "fatal_phase_error" };
    case "protocol": return { retry: false, reason: "fatal_protocol" };
    case "aborted": return { retry: false, reason: "fatal_aborted" };
    case "run_locked": return { retry: false, reason: "fatal_run_locked" };
    case "unknown": return { retry: false, reason: "fatal_unknown" };
  }

  // 3. Retriables : check budget.
  //    Condition retry : attempt + 1 < policy.maxAttempts (attempt 0-indexé).
  //    Avec maxAttempts = 3 : attempt 0 → retry OK (0+1 < 3), attempt 1 → retry OK, attempt 2 → exhausted.
  if (attempt + 1 >= policy.maxAttempts) {
    return { retry: false, reason: "retry_exhausted" };
  }

  // 4. Budget OK → calculer delayMs via backoff exponentiel capé.
  const delayMs = computeBackoff(attempt, policy);
  const reason: RetryDecisionReason =
    kind === "delegation_timeout" ? "transient_timeout" : "transient_schema";
  return { retry: true, delayMs, reason };
}

function computeBackoff(attempt: number, policy: RetryPolicy): number {
  // backoff(attempt) = min(base * 2^attempt, max)
  // attempt 0-indexé → attempt 0 : base × 1, attempt 1 : base × 2, attempt 2 : base × 4, ...
  const raw = policy.backoffBaseMs * Math.pow(2, attempt);
  return Math.min(raw, policy.maxBackoffMs);
}

function isOrchestratorError(err: unknown): err is OrchestratorError {
  return err instanceof Error && "kind" in err && typeof (err as any).kind === "string";
}
```

### 3.2 Règles normatives

- **Fonction pure** (I-5 NIB-S) — mêmes args → même résultat (P-RR-a). Aucune dépendance clock, fs, logger.
- **Pas de jitter** en v1 (§3.2 NX, backoff déterministe pur).
- **Condition de retry** : strict `attempt + 1 < maxAttempts` (attempt 0-indexé). Au-delà → `retry_exhausted`. Jamais `>=` (strict `>`).
  - Cas défensif : `attempt >= maxAttempts` (ex. `attempt = 5, maxAttempts = 3`) → `retry_exhausted` (pas un retry négatif). Testé T-RR-17.
- **Fatals indépendants de policy** (P-RR-b) — la décision pour une erreur fatale est la même quel que soit `policy.maxAttempts`. Discipline : le switch §3.1 step 2 retourne avant de consulter `policy`.
- **`retry === true` ⇒ `delayMs > 0`** (P-RR-c) — garanti par `computeBackoff` (`base > 0`, `attempt >= 0`, `max > 0`).
- **`retry === false` ⇒ `delayMs === undefined`** (P-RR-d) — la forme TS l'impose (discriminated union).
- **`delayMs <= maxBackoffMs`** toujours (P-RR-e) — garanti par `Math.min`.
- **Pas de validation de `policy`** — l'engine a déjà résolu `effectiveRetryPolicy` avec les defaults (§6.8 NIB-S). Le resolver fait confiance aux valeurs.

### 3.3 Mapping `kind` → `reason` (canonique §8.2 NX)

| Error kind | Retry budget OK | Retry budget exhausted |
|---|---|---|
| `delegation_timeout` | `{ retry: true, reason: "transient_timeout" }` | `{ retry: false, reason: "retry_exhausted" }` |
| `delegation_schema` | `{ retry: true, reason: "transient_schema" }` | `{ retry: false, reason: "retry_exhausted" }` |
| `invalid_config` | `{ retry: false, reason: "fatal_invalid_config" }` | idem |
| `state_corrupted` | `{ retry: false, reason: "fatal_state_corrupted" }` | idem |
| `state_missing` | `{ retry: false, reason: "fatal_state_missing" }` | idem |
| `state_version_mismatch` | `{ retry: false, reason: "fatal_state_version_mismatch" }` | idem |
| `delegation_missing_result` | `{ retry: false, reason: "fatal_delegation_missing_result" }` | idem |
| `phase_error` | `{ retry: false, reason: "fatal_phase_error" }` | idem |
| `protocol` | `{ retry: false, reason: "fatal_protocol" }` | idem |
| `aborted` | `{ retry: false, reason: "fatal_aborted" }` | idem |
| `run_locked` | `{ retry: false, reason: "fatal_run_locked" }` | idem |
| Non-`OrchestratorError` (Error, TypeError, etc.) | `{ retry: false, reason: "fatal_unknown" }` | idem |

---

## 4. Examples

### 4.1 Timeout avec budget

```ts
const err = new DelegationTimeoutError("timed out");
const policy = { maxAttempts: 3, backoffBaseMs: 1000, maxBackoffMs: 30000 };

resolveRetryDecision(err, 0, policy);  // { retry: true, delayMs: 1000, reason: "transient_timeout" }
resolveRetryDecision(err, 1, policy);  // { retry: true, delayMs: 2000, reason: "transient_timeout" }
resolveRetryDecision(err, 2, policy);  // { retry: false, reason: "retry_exhausted" }
```

### 4.2 Schema avec backoff capé

```ts
const err = new DelegationSchemaError("invalid");
const policy = { maxAttempts: 10, backoffBaseMs: 1000, maxBackoffMs: 30000 };

resolveRetryDecision(err, 5, policy);
// base × 2^5 = 32000 > 30000 → capé
// { retry: true, delayMs: 30000, reason: "transient_schema" }
```

### 4.3 Erreur fatale — policy ignorée

```ts
const err = new InvalidConfigError("bad name");
resolveRetryDecision(err, 0, policy);  // { retry: false, reason: "fatal_invalid_config" }
resolveRetryDecision(err, 99, {...policy, maxAttempts: 1000});  // Idem, policy ignorée
```

### 4.4 Erreur non classifiée

```ts
resolveRetryDecision(new Error("weird"), 0, policy);
// { retry: false, reason: "fatal_unknown" }
```

---

## 5. Edge cases

| Cas | Comportement |
|---|---|
| `maxAttempts = 0` (invalide en pratique) | `attempt + 1 >= 0` toujours vrai → `retry_exhausted` immédiat pour toute erreur retriable. Non-problème : l'engine valide `maxAttempts >= 1` en préflight (défensif). |
| `maxAttempts = 1` (pas de retry) | `attempt 0 + 1 >= 1` → `retry_exhausted` immédiatement. Testé T-RR-16. |
| `attempt < 0` (cas hypothétique) | `attempt + 1 < maxAttempts` peut être vrai → retry avec `delayMs = base × 2^negative = base / 2^|negative|`. Cas irréaliste ; pas de garde-fou. |
| `backoffBaseMs = 0` | `delayMs = 0`. Pas de sleep utile. P-RR-c (retry ⇒ delayMs > 0) **fails** — discipline : l'engine/caller garantit `backoffBaseMs > 0` via defaults. Test NIB-T utilise policies avec base ≥ 500. |
| `cause instanceof AbortedError` dans PhaseError | **Non géré ici** — le resolver ne déballe pas les causes. `PhaseError.kind === "phase_error"` → fatal_phase_error. La distinction `PhaseError + cause=Abort` pour classification "abort" est faite par `NIB-M-ERROR-CLASSIFIER`, pas ici (scope différent). |

---

## 6. Constraints

- **Fonction pure** — I-5. Pas de side effect.
- **Pas de clock** — n'a pas besoin (delay calculé de `attempt`, pas de `now()`).
- **Pas de logger** — retourne la décision, laisse le caller logger `retry_scheduled`.
- **Switch exhaustif** sur `OrchestratorErrorKind` — TS vérifie via `never` unreachable. Si un nouveau kind est ajouté au NIB-S, le switch DOIT être mis à jour (breaking change).
- **Pas d'import vers `NIB-M-ERROR-CLASSIFIER`** — les deux fonctions sont indépendantes. Duplication minimale de logique (switch sur kind) acceptée pour clarté.
- **Constantes exportées pour `DEFAULT_*`** — réutilisées par l'engine (NIB-M-DISPATCH-LOOP) pour résoudre `effectiveRetryPolicy` champ-par-champ.

---

## 7. Tests NIB-T (rappel §2)

| Groupe | Tests | Propriété |
|---|---|---|
| Fatals (attempt 0/1/2) | T-RR-01 à T-RR-09 | Décision constante indépendante de attempt |
| Retriables budget OK | T-RR-10 à T-RR-13 | delayMs backoff exponentiel |
| Budget épuisé | T-RR-14 à T-RR-17 | `retry_exhausted` |
| Backoff cap | T-RR-18 à T-RR-21 | `Math.min(base × 2^attempt, max)` |
| Non classifiées | T-RR-22, T-RR-23 | `fatal_unknown` |
| Propriétés | P-RR-a (pure), P-RR-b (fatal indép. policy), P-RR-c (retry ⇒ delayMs > 0), P-RR-d (no-retry ⇒ delayMs undef), P-RR-e (delayMs ≤ maxBackoffMs) |

---

## 8. Integration snippets

### 8.1 Consommation par dispatch-loop (catch §14.1 step 16.i)

```ts
import { resolveRetryDecision } from "../services/retry-resolver";
import { abortableSleep } from "../services/abortable-sleep";

try { result = await phaseFn(frozenState, io, input); }
catch (err) {
  if (err instanceof DelegationSchemaError && state.pendingDelegation) {
    const pd = state.pendingDelegation;
    const decision = resolveRetryDecision(err, pd.attempt, pd.effectiveRetryPolicy);
    if (decision.retry) {
      logger.emit({ eventType: "retry_scheduled", runId, phase, label: pd.label,
                    attempt: pd.attempt + 1, delayMs: decision.delayMs!, reason: decision.reason, ... });
      await abortableSleep(decision.delayMs!, abortController.signal);
      // ... reconstruct manifest + persist + emit DELEGATE ...
    } else {
      // fatal → emit ERROR + exit 1
    }
  }
  // ... autres catches ...
}
```

### 8.2 Consommation par handle-resume (§14.2 step 12.d)

```ts
// Classification : missing/malformed/parseable
if (anyMalformed) {
  const decision = resolveRetryDecision(new DelegationSchemaError("malformed JSON"), pd.attempt, pd.effectiveRetryPolicy);
  if (decision.retry) { /* retry branch */ }
  else { /* fatal ERROR exit */ }
}
```

---

## 9. Definition of Done (DoD)

1. **1 fichier** créé : `src/services/retry-resolver.ts` avec exports `resolveRetryDecision`, `RetryPolicy`, `RetryDecision`, `RetryDecisionReason`, `DEFAULT_MAX_ATTEMPTS`, `DEFAULT_BACKOFF_BASE_MS`, `DEFAULT_MAX_BACKOFF_MS`.
2. **`resolveRetryDecision`** :
   - Fonction pure (P-RR-a).
   - Switch exhaustif sur 11 kinds + fallback `unknown`.
   - Backoff exponentiel `base × 2^attempt` capé à `maxBackoffMs`.
   - Condition de retry : `attempt + 1 < maxAttempts` strict.
   - `reason` dans l'enum fermé `RetryDecisionReason`.
3. **Union discriminée `RetryDecision`** avec `delayMs` présent ssi `retry === true`.
4. **Constantes `DEFAULT_*`** exportées et utilisées par l'engine.
5. **Tests NIB-T** : T-RR-01 à T-RR-23, P-RR-a à P-RR-e, C-FC-01 (indirect via dispatch-loop).
6. **Imports** : uniquement type depuis `../errors/base` (`OrchestratorError`). Aucun autre import runtime.
7. **LOC** : 80-120.

---

## 10. Relation avec les autres NIB-M

- **Consomme** : `NIB-M-ERRORS` (type `OrchestratorError` pour type guard).
- **Consommé par** :
  - `NIB-M-DISPATCH-LOOP` (catch retry post-validation)
  - `NIB-M-HANDLE-RESUME` (decision retry après malformed/timeout au classification step 12)
- **Parallèle avec** `NIB-M-ERROR-CLASSIFIER` — les deux switch sur `kind` mais retournent des types différents. Pas de dépendance croisée.

---

## 11. Metadata

| Champ | Valeur |
|---|---|
| Source NX | §8.2, §9.2, §10.1 |
| NIB-T associé | §2 (T-RR, P-RR) |
| Invariants NIB-S couverts | I-5 (déterminisme), §8 (taxonomie retry) |
| Fichier produit | `src/services/retry-resolver.ts` |
| LOC cible | 80-120 |
| Non exporté publiquement | oui (resolver interne) — mais `RetryPolicy` est exporté publiquement via NIB-M-PUBLIC-API |

---

*turnlock — Implicit-Free Execution — "Reliability precedes intelligence."*
