---
id: NIB-M-ERRORS
type: nib-module
version: "1.0.0"
scope: turnlock
module: errors
status: approved
consumers: [claude-code]
superseded_by: []
validates: ["src/errors/**/*.ts", "tests/contracts/errors.test.ts"]
---

# NIB-M-ERRORS — Taxonomie d'erreurs

**Package** : `turnlock`
**Source NX** : §6.6 (liste canonique), §8 (classification, retry)
**NIB-T associé** : §27.6 (C-ER-01 à C-ER-03), T-EC-01 à T-EC-14 (classify utilise ces classes), tests des flows (§15-§22) qui throw/enrichissent
**NIB-S référencé** : §6.6, §8.1 (classification), I-4 (fail-closed), I-13 (PII : `message` ≤ 200 chars)

---

## 1. Purpose

Définit la taxonomie fermée des 11 classes d'erreur du runtime, la classe abstraite `OrchestratorError` commune, et le type union `OrchestratorErrorKind`.

**Principe normatif structurant** : toute erreur remontée par le runtime est une instance de `OrchestratorError` avec un `kind` déterministe. Le parent agent peut faire du pattern matching exhaustif sur `kind` sans ambiguïté. Aucune erreur JavaScript brute (`Error`, `TypeError`) n'échappe du runtime — tout throw interne est converti en `OrchestratorError` enrichi avant émission du bloc ERROR (§6.6, §14.1 step 16.i du NX).

**Fichiers cibles** :
- `src/errors/base.ts` — `OrchestratorError` abstract + `OrchestratorErrorKind` union
- `src/errors/concrete.ts` — 11 sous-classes concrètes

**LOC cible** : ~150-200 total.

---

## 2. Inputs / Outputs

Ce module n'a pas de signature runtime — il expose des **classes**. Il est consommé par :

- Tous les modules qui throw (engine, services, bindings)
- Le public API (§6.9 du NIB-S) qui exporte les 11 classes + `OrchestratorError` + `OrchestratorErrorKind`
- Le `resolveRetryDecision` (NIB-M-RETRY-RESOLVER) qui switch sur `kind`
- Le `classify` (NIB-M-ERROR-CLASSIFIER) qui mappe chaque classe vers `"transient" | "permanent" | "abort" | "unknown"`

---

## 3. Interface

### 3.1 Classe abstraite `OrchestratorError`

```ts
export type OrchestratorErrorKind =
  | "invalid_config"
  | "state_corrupted"
  | "state_missing"
  | "state_version_mismatch"
  | "delegation_timeout"
  | "delegation_schema"
  | "delegation_missing_result"
  | "phase_error"
  | "protocol"
  | "aborted"
  | "run_locked";

export abstract class OrchestratorError extends Error {
  abstract readonly kind: OrchestratorErrorKind;
  readonly runId?: string;
  readonly orchestratorName?: string;
  readonly phase?: string;

  constructor(
    message: string,
    options?: {
      readonly cause?: unknown;
      readonly runId?: string;
      readonly orchestratorName?: string;
      readonly phase?: string;
    }
  );
}
```

**Règles** :

- `kind` abstrait — chaque sous-classe concrète retourne un littéral fixe.
- `runId`, `orchestratorName`, `phase` sont **optionnels** à la construction. Ils peuvent être enrichis après-coup par l'engine au moment du catch (cf. `enrich` helper interne §3.3).
- `message` est le message humain. La discipline **P-NO-PII** (I-13 NIB-S) impose ≤ 200 chars à l'émission dans le bloc protocole ou dans `phase_error.message` — mais la classe elle-même ne tronque pas (c'est l'émetteur qui tronque).
- `cause` : suit la convention ES2022 `Error({cause})`. Préserve la chaîne d'erreur sans la propager dans les logs (PII risk si `cause` est une exception utilisateur avec contenu).

### 3.2 Liste canonique des 11 sous-classes

Chaque sous-classe :
1. Étend `OrchestratorError`
2. Définit `readonly kind = "<littéral>" as const`
3. Optionnellement ajoute des propriétés publiques spécifiques
4. Exporte un nom `<Kind>Error` en PascalCase

```ts
export class InvalidConfigError extends OrchestratorError {
  readonly kind = "invalid_config" as const;
}

export class StateCorruptedError extends OrchestratorError {
  readonly kind = "state_corrupted" as const;
}

export class StateMissingError extends OrchestratorError {
  readonly kind = "state_missing" as const;
}

export class StateVersionMismatchError extends OrchestratorError {
  readonly kind = "state_version_mismatch" as const;
}

export class DelegationTimeoutError extends OrchestratorError {
  readonly kind = "delegation_timeout" as const;
}

export class DelegationSchemaError extends OrchestratorError {
  readonly kind = "delegation_schema" as const;
}

export class DelegationMissingResultError extends OrchestratorError {
  readonly kind = "delegation_missing_result" as const;
}

export class PhaseError extends OrchestratorError {
  readonly kind = "phase_error" as const;
}

export class ProtocolError extends OrchestratorError {
  readonly kind = "protocol" as const;
}

export class AbortedError extends OrchestratorError {
  readonly kind = "aborted" as const;
}

export class RunLockedError extends OrchestratorError {
  readonly kind = "run_locked" as const;
  readonly ownerPid: number;
  readonly acquiredAtEpochMs: number;
  readonly leaseUntilEpochMs: number;

  constructor(
    message: string,
    options: {
      readonly ownerPid: number;
      readonly acquiredAtEpochMs: number;
      readonly leaseUntilEpochMs: number;
      readonly cause?: unknown;
      readonly runId?: string;
      readonly orchestratorName?: string;
    }
  );
}
```

**Règles** :

- `RunLockedError` a **3 propriétés publiques obligatoires** (`ownerPid`, `acquiredAtEpochMs`, `leaseUntilEpochMs`) — lues depuis le lock existant et exposées au parent agent via le message du bloc ERROR. Leur présence est testée par C-ER-01.
- `PhaseError` est utilisé pour **wrapper** toute exception utilisateur (non-`OrchestratorError`) jetée par une phase. Le `cause` préserve l'exception originale. `message` reprend `cause.message` (tronqué à 200 chars par l'émetteur).
- Aucune autre sous-classe n'a de propriétés publiques spécifiques v1. Un futur ajout (ex. `DelegationTimeoutError.deadlineAtEpochMs`) = breaking change.

### 3.3 Helper d'enrichissement (interne, non exporté)

Le catch top-level de `runOrchestrator` enrichit les erreurs avant émission. Ce n'est pas une méthode de classe mais un helper pur dans `src/errors/base.ts` :

```ts
// Non exporté publiquement — utilisé par l'engine (NIB-M-DISPATCH-LOOP, NIB-M-HANDLE-RESUME).
export function enrich<E extends OrchestratorError>(
  err: E,
  ctx: { readonly runId?: string; readonly orchestratorName?: string; readonly phase?: string }
): E;
```

**Règle** : `enrich` mute les champs `runId`, `orchestratorName`, `phase` en place si et seulement s'ils sont `undefined` sur l'erreur. Ne touche jamais à un champ déjà défini. Retourne la même instance (pas de clone). Seul l'engine l'appelle, dans `enrichAndThrow` (pattern inspiré de `NIB-M-EXECUTE-CALL` de llm-runtime §4).

Cette mutation-en-place est acceptable car l'erreur est sur le point d'être émise puis le process exit — pas de risque d'observation concurrente.

---

## 4. Algorithme

Pas d'algorithme au sens "pseudocode" — ce sont des classes sans logique. L'implémentation est mécanique :

1. Définir `OrchestratorErrorKind` comme union de 11 string literals.
2. Définir `OrchestratorError` abstract qui étend `Error`, déclare `abstract readonly kind`, et expose les 3 propriétés optionnelles `runId`/`orchestratorName`/`phase`. Constructor qui forward `message` + `cause` à `super()` et assigne les champs optionnels.
3. Pour chaque `kind` ∈ les 11 valeurs, créer `class XError extends OrchestratorError { readonly kind = "<kind>" as const; }`.
4. Pour `RunLockedError`, override le constructeur pour exiger `ownerPid`, `acquiredAtEpochMs`, `leaseUntilEpochMs` dans `options`.
5. Implémenter `enrich(err, ctx)` : pour chaque champ de `ctx` défini et correspondant champ de `err` undefined, assigner.

**Détail technique** — `Error.captureStackTrace` : comme `OrchestratorError` étend `Error`, la stack trace est capturée nativement. Pas d'action spéciale requise. Le paramètre `options.cause` est passé à `super(message, { cause })` (ES2022 native).

---

## 5. Examples

### 5.1 Construction simple

```ts
const err = new ProtocolError("duplicate label: foo", {
  runId: "01HXK...",
  orchestratorName: "senior-review",
  phase: "dispatch",
});
console.log(err.kind);              // "protocol"
console.log(err.runId);              // "01HXK..."
console.log(err instanceof OrchestratorError);  // true
console.log(err instanceof Error);              // true
```

### 5.2 `RunLockedError` avec propriétés obligatoires

```ts
const err = new RunLockedError(
  "Run 01HX is locked by PID 12345, lease expires at 2026-04-19T14:23:05Z",
  {
    ownerPid: 12345,
    acquiredAtEpochMs: 1745062000000,
    leaseUntilEpochMs: 1745063800000,
    runId: "01HX",
    orchestratorName: "senior-review",
  }
);
console.log(err.ownerPid);                    // 12345
console.log(err.leaseUntilEpochMs);           // 1745063800000
```

### 5.3 Enrichissement post-catch

```ts
try {
  // phase throw une ProtocolError sans runId (pas connu dans la phase)
  throw new ProtocolError("unknown phase: foo");
} catch (err) {
  if (err instanceof OrchestratorError) {
    enrich(err, { runId: "01HX", orchestratorName: "senior-review", phase: "a" });
    console.log(err.runId);   // "01HX" maintenant
  }
}
```

### 5.4 Wrapping d'exception utilisateur

```ts
try {
  await phaseFn(state, io, input);
} catch (err) {
  if (err instanceof OrchestratorError) throw err;  // déjà typé, re-throw
  // Sinon wrap dans PhaseError
  const wrapped = new PhaseError(
    err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200),
    { cause: err, runId, orchestratorName, phase: currentPhase }
  );
  throw wrapped;
}
```

---

## 6. Edge cases

| Cas | Comportement attendu |
|---|---|
| `new OrchestratorError(...)` direct | Impossible compilation-time (abstract). TS rejette. |
| `enrich(err, { runId: undefined })` | No-op : si `ctx.runId` est undefined, pas de mutation. |
| `enrich(err, { runId: "X" })` sur un err.runId déjà défini à "Y" | No-op : enrich préserve le runId existant. Discipline : l'engine enrichit une seule fois au catch le plus proche. |
| `new PhaseError("X", { cause: new RangeError("oops") })` | OK. `err.cause instanceof RangeError`. `err.kind === "phase_error"`. |
| Classes sérialisées via `JSON.stringify(err)` | `{}` (les propriétés de Error ne sont pas enumerable par défaut). **Non-problème** car le runtime ne sérialise jamais une erreur directement — il sérialise `{ kind, message, phase }` dans les events. |
| `instanceof` cross-package (différentes versions chargées) | Problème théorique. Non applicable v1 — tests vérifient `err.kind === "..."` comme fallback. |

---

## 7. Constraints

- **Pas de logique dans les classes** — ce sont des DTOs typés. Toute logique (classification, décision retry, enrichissement) vit dans d'autres modules.
- **`kind` figé par classe** — déclaré `readonly kind = "..." as const`. TS infère le type littéral. Toute modification = breaking change.
- **Pas de méthodes custom** — pas de `toJSON()`, `toString()`, `serialize()`. Le runtime fait sa propre sérialisation au niveau logger et protocole.
- **Ordre déclaratif des 11 classes** — respecter l'ordre de `OrchestratorErrorKind` pour la lisibilité de `concrete.ts`.
- **Pas d'export de `enrich` publiquement** — helper interne utilisé par l'engine uniquement.

---

## 8. Integration snippets

### 8.1 Export depuis `src/index.ts` (NIB-M-PUBLIC-API)

```ts
export {
  OrchestratorError,
  type OrchestratorErrorKind,
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
} from "./errors/base";
// + concrete.ts re-exports
```

### 8.2 Consommation par le classifier (NIB-M-ERROR-CLASSIFIER)

```ts
export function classify(err: unknown): "transient" | "permanent" | "abort" | "unknown" {
  if (!(err instanceof OrchestratorError)) return "unknown";
  switch (err.kind) {
    case "delegation_timeout":
    case "delegation_schema":
      return "transient";
    case "aborted":
      return "abort";
    case "phase_error":
      if (err instanceof PhaseError && "cause" in err && err.cause instanceof AbortedError) return "abort";
      return "permanent";
    default:
      return "permanent";
  }
}
```

---

## 9. Definition of Done (DoD)

1. **2 fichiers** créés : `src/errors/base.ts` (abstract + union + `enrich`) et `src/errors/concrete.ts` (11 sous-classes).
2. **11 sous-classes concrètes** toutes exportées avec `kind` littéral correct (mapping §3.2 exact).
3. **`OrchestratorErrorKind` union fermée** avec exactement les 11 valeurs de §3.1.
4. **`RunLockedError`** a `ownerPid` (number), `acquiredAtEpochMs` (number), `leaseUntilEpochMs` (number) publics (C-ER-01).
5. **`OrchestratorError`** a `runId?`, `orchestratorName?`, `phase?` publics (C-ER-02).
6. **`instanceof OrchestratorError`** retourne `true` pour chaque sous-classe (C-ER-03).
7. **`instanceof Error`** retourne `true` pour chaque sous-classe.
8. **Tests NIB-T passent** : C-ER-01 à C-ER-03, C-GL-04 (tous `instanceof OrchestratorError`), C-GL-12 (union exacte), C-GL-13 (mapping kind ↔ classe).
9. **LOC** : 150-200 total.
10. **Pas de méthodes instance** hors constructeur (pas de `toJSON`, `toString` custom, etc.).
11. **`enrich(err, ctx)`** exporté pour consommation interne par l'engine. Mute en place les champs undefined uniquement.

---

## 10. Relation avec les autres NIB-M

- **Consommé par** : tous. Notamment :
  - `NIB-M-RETRY-RESOLVER` (switch sur `kind` pour décision)
  - `NIB-M-ERROR-CLASSIFIER` (mapping vers transient/permanent/abort/unknown)
  - `NIB-M-STATE-IO` (throw `StateCorruptedError`, `StateMissingError`, `StateVersionMismatchError`)
  - `NIB-M-LOCK` (throw `RunLockedError` avec les 3 propriétés)
  - `NIB-M-VALIDATOR` (throw `DelegationSchemaError` via `consumePending*`)
  - `NIB-M-PROTOCOL` (extrait `kind` pour le champ `error_kind` du bloc ERROR)
  - `NIB-M-RUN-ORCHESTRATOR` (throw `InvalidConfigError` preflight)
  - `NIB-M-DISPATCH-LOOP` (catch + enrich + emit ERROR)
  - `NIB-M-HANDLE-RESUME` (throw `StateMissingError`, `StateCorruptedError`, `StateVersionMismatchError`, `ProtocolError`, classification results)
  - `NIB-M-PUBLIC-API` (re-exports)
- **Ne consomme** aucun autre NIB-M — module feuille.

---

## 11. Metadata

| Champ | Valeur |
|---|---|
| Source NX | §6.6 (liste canonique), §8.1 (classification) |
| NIB-T associé | §27.6 (C-ER-01 à C-ER-03), §27.5 (C-GL-12, C-GL-13) |
| Invariants NIB-S couverts | I-4 (fail-closed), I-9 (surface stable), I-13 (PII discipline via message caller) |
| Fichiers produits | `src/errors/base.ts`, `src/errors/concrete.ts` |
| LOC cible | 150-200 |
| Exporté publiquement | oui (11 classes + abstract + kind union) |

---

*turnlock — Implicit-Free Execution — "Reliability precedes intelligence."*
