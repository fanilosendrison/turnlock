---
id: NIB-M-ERROR-CLASSIFIER
type: nib-module
version: "1.0.0"
scope: cc-orchestrator-runtime
module: error-classifier
status: approved
consumers: [claude-code]
superseded_by: []
---

# NIB-M-ERROR-CLASSIFIER — Classification transient / permanent / abort / unknown

**Package** : `cc-orchestrator-runtime`
**Source NX** : §5.5 (classify signature), §8.1 (classification transient vs permanent)
**NIB-T associé** : §3 (T-EC-01 à T-EC-14, P-EC-a/b)
**NIB-S référencé** : §8.1 (classification canonique)

---

## 1. Purpose

Fonction pure **`classify`** qui mappe une erreur en une catégorie sémantique haut niveau :

- `"transient"` — erreur réseau-like, peut être retriée.
- `"permanent"` — erreur fatale, retry ne changera rien.
- `"abort"` — signal utilisateur (SIGINT/SIGTERM), pas une erreur à retry.
- `"unknown"` — erreur non classifiée, fallback défensif.

**Principe normatif structurant** : classification **sémantique** orthogonale à la **décision de retry**. Le `resolveRetryDecision` (NIB-M-RETRY-RESOLVER) décide `{retry, delayMs, reason}` — `classify` décide la catégorie haut niveau utilisée par d'autres consommateurs (reporting, observabilité, futurs skills qui veulent inspecter sans implémenter la logique retry).

**Pourquoi deux modules** ? Le resolver retourne des `RetryDecisionReason` fins (`"transient_timeout"`, `"fatal_protocol"`, etc.). Le classifier retourne une catégorie grossière. Mêmes sources de vérité (switch sur kind) mais consommateurs distincts → fonctions distinctes, pas de cycle.

**Fichier cible** : `src/services/error-classifier.ts`

**LOC cible** : ~40-60.

---

## 2. Signatures

```ts
import type { OrchestratorError } from "../errors/base";
import { PhaseError, AbortedError } from "../errors/concrete";

export type ErrorCategory = "transient" | "permanent" | "abort" | "unknown";

export function classify(err: unknown): ErrorCategory;
```

---

## 3. Algorithme

```ts
export function classify(err: unknown): ErrorCategory {
  if (!(err instanceof Error)) return "unknown";
  if (!isOrchestratorError(err)) return "unknown";

  switch (err.kind) {
    // Retriables
    case "delegation_timeout":
    case "delegation_schema":
      return "transient";

    // Abort explicite
    case "aborted":
      return "abort";

    // Phase error : classification conditionnelle selon cause
    case "phase_error":
      if (err instanceof PhaseError && "cause" in err && err.cause instanceof AbortedError) {
        return "abort";
      }
      return "permanent";

    // Tous les autres : permanent
    case "invalid_config":
    case "state_corrupted":
    case "state_missing":
    case "state_version_mismatch":
    case "delegation_missing_result":
    case "protocol":
    case "run_locked":
      return "permanent";
  }
}

function isOrchestratorError(err: Error): err is OrchestratorError {
  return "kind" in err && typeof (err as any).kind === "string";
}
```

**Règles normatives** :

- **Codomain fermé** : exactement 4 valeurs `{"transient", "permanent", "abort", "unknown"}` (P-EC-b).
- **Fonction pure** (P-EC-a).
- **Switch exhaustif** sur les 11 kinds via `OrchestratorErrorKind`. TS vérifie la couverture via `never` unreachable.
- **Non-`OrchestratorError`** (ex. `TypeError` bruts, strings lancées, etc.) → `"unknown"` (T-EC-13, T-EC-14).
- **`phase_error` special case** : inspecte `cause` pour détecter un abort masqué. Si la phase utilisateur a `throw` un `AbortedError` (cas hypothétique mais possible si la phase interrompt explicitement), la classification reflète `"abort"`.
- **Pas de traitement récursif de `cause`** au-delà d'un niveau. Un `PhaseError { cause: SomeOtherError { cause: AbortedError } }` est classé `"permanent"` — la spec ne demande qu'un niveau d'inspection.

---

## 4. Examples

```ts
classify(new DelegationTimeoutError("x"));           // "transient"
classify(new DelegationSchemaError("x"));            // "transient"
classify(new InvalidConfigError("x"));               // "permanent"
classify(new StateCorruptedError("x"));              // "permanent"
classify(new AbortedError("x"));                     // "abort"
classify(new PhaseError("x"));                       // "permanent"
classify(new PhaseError("x", { cause: new AbortedError("y") }));  // "abort"
classify(new PhaseError("x", { cause: new Error("y") }));  // "permanent"
classify(new Error("weird"));                        // "unknown"
classify(new TypeError("oops"));                     // "unknown"
classify("string thrown");                           // "unknown"
classify(null);                                      // "unknown"
classify(undefined);                                 // "unknown"
```

---

## 5. Edge cases

| Cas | Comportement |
|---|---|
| `err === null` | `"unknown"` (not instanceof Error) |
| `err === undefined` | `"unknown"` |
| `err = 42` (primitif) | `"unknown"` |
| `err = { kind: "delegation_timeout" }` (duck-typed) | `"unknown"` (pas instanceof Error) |
| `err` étend Error mais kind unknown | `"unknown"` (isOrchestratorError fail car kind pas dans l'enum — en pratique tout `OrchestratorError` a un kind valide par design) |
| `err = new PhaseError("x")` sans cause | `"permanent"` (branche else) |
| `err.cause` est un `OrchestratorError` non-`AbortedError` | `"permanent"` (seul `AbortedError` inspection v1) |

---

## 6. Constraints

- **Fonction pure** — aucun side effect.
- **Pas de try/catch** — tous les types checks sont via `instanceof` / `typeof`.
- **Codomain strict** — TS enforce via type return `ErrorCategory`. Jamais de string hors ensemble.
- **Switch exhaustif** — TS vérifie via `never`. Si un nouveau kind est ajouté au NIB-S, le switch DOIT être mis à jour (breaking change détecté au compile).

---

## 7. Tests NIB-T (rappel §3)

| Test | Input | Output |
|---|---|---|
| T-EC-01 à T-EC-04 | `Invalid/StateCorrupted/StateMissing/StateVersionMismatch` | `"permanent"` |
| T-EC-05, T-EC-06 | `DelegationTimeout/Schema` | `"transient"` |
| T-EC-07 | `DelegationMissingResult` | `"permanent"` |
| T-EC-08 | `PhaseError` cause=Error | `"permanent"` |
| T-EC-09 | `PhaseError` cause=`AbortedError` | `"abort"` |
| T-EC-10 | `ProtocolError` | `"permanent"` |
| T-EC-11 | `AbortedError` | `"abort"` |
| T-EC-12 | `RunLockedError` | `"permanent"` |
| T-EC-13 | `new Error("unknown")` | `"unknown"` |
| T-EC-14 | `new TypeError("generic")` | `"unknown"` |
| P-EC-a | Pureté (50 itérations mêmes input) |
| P-EC-b | Codomain strict `{"transient","permanent","abort","unknown"}` |

---

## 8. Integration snippets

### 8.1 Consommation hypothétique par consommateurs futurs (reporting, UI)

```ts
import { classify } from "cc-orchestrator-runtime/internal/error-classifier";  // si exporté un jour

const category = classify(err);
if (category === "transient") console.log("Will retry");
else if (category === "abort") console.log("User aborted");
```

**Note** : en v1, `classify` n'est **pas** exporté publiquement. Il est utilisé à titre interne éventuellement par le logger pour enrichir des events futurs, ou par un skill d'analyse post-run qui parserait `events.ndjson`. Le consommateur public doit utiliser `resolveRetryDecision` pour la logique de retry (plus fin) et lire `errorKind` dans les events pour reporting.

---

## 9. Definition of Done (DoD)

1. **1 fichier** créé : `src/services/error-classifier.ts` avec exports `classify`, `ErrorCategory`.
2. **`classify`** :
   - Fonction pure.
   - Codomain fermé (4 valeurs).
   - Switch exhaustif sur 11 kinds.
   - Special case `PhaseError { cause: AbortedError }` → `"abort"`.
   - Non-`OrchestratorError` → `"unknown"`.
3. **Tests NIB-T** : T-EC-01 à T-EC-14, P-EC-a, P-EC-b.
4. **Imports** : `OrchestratorError` (type), `PhaseError`, `AbortedError` (classes pour `instanceof`).
5. **LOC** : 40-60.

---

## 10. Relation avec les autres NIB-M

- **Consomme** : `NIB-M-ERRORS` (types + classes `PhaseError`, `AbortedError`).
- **Consommé par** : v1 — usage optionnel par l'engine pour logs. Pas de dépendance forte. Pourrait être consommé par `NIB-M-LOGGER` pour enrichir des events futurs.
- **Parallèle à** `NIB-M-RETRY-RESOLVER` — les deux switch sur kind, codomains différents.

---

## 11. Metadata

| Champ | Valeur |
|---|---|
| Source NX | §5.5, §8.1 |
| NIB-T associé | §3 (T-EC, P-EC) |
| Invariants NIB-S couverts | I-5 (déterminisme), §8.1 (classification) |
| Fichier produit | `src/services/error-classifier.ts` |
| LOC cible | 40-60 |
| Non exporté publiquement | oui (interne v1) |

---

*cc-orchestrator-runtime — Implicit-Free Execution — "Reliability precedes intelligence."*
