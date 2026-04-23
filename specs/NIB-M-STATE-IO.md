---
id: NIB-M-STATE-IO
type: nib-module
version: "1.0.0"
scope: turnlock
module: state-io
status: approved
consumers: [claude-code]
superseded_by: []
validates: ["src/services/state-io.ts", "tests/services/state-io.test.ts", "tests/contracts/state-manifest.test.ts"]
---

# NIB-M-STATE-IO — Lecture/écriture atomique du `state.json`

**Package** : `turnlock`
**Source NX** : §4.3 (atomicité écriture), §4.10 (JSON-only), §5.5 (signature), §7.1 (forme canonique)
**NIB-T associé** : §6 (T-SI-01 à T-SI-12, P-SI-a/b/c), §26.2 (P-03/P-04 idempotence)
**NIB-S référencé** : §7.1 (`StateFile<State>` forme canonique), I-3 (atomicité), I-10 (JSON-only), I-12 (snapshot-authoritative)

---

## 1. Purpose

Deux fonctions pour la persistence atomique du `state.json` :

- **`readState`** — lit `state.json` s'il existe, valide `schemaVersion` et optionnellement `data` contre un schéma zod. Retourne le state typé ou `null` si absent.
- **`writeStateAtomic`** — écrit le state via `tmp + rename`, garantissant qu'aucun lecteur concurrent ne peut observer un fichier tronqué.

**Principe normatif structurant — snapshot-authoritative (I-12 NIB-S)** : `state.json` est la source de vérité autoritative unique. Cette module doit garantir que :
- **Au read** : toute lecture réussie retourne un state cohérent, jamais partiel (I-3).
- **Au write** : toute écriture est atomique au sens POSIX (rename sur un même FS).
- **Corruption détectée bruyamment** : un `state.json` malformé ou version-mismatch throw une erreur typée, jamais de tolérance silencieuse (fail-closed, I-4).

**Fichier cible** : `src/services/state-io.ts`

**LOC cible** : ~100-150.

---

## 2. Signatures

```ts
import type { ZodSchema } from "zod";
import { StateCorruptedError, StateVersionMismatchError } from "../errors/concrete";

/**
 * Forme canonique unique définie en §7.1 du NIB-S.
 * Dupliquée ici pour clarté d'implémentation — la source de vérité reste le NIB-S.
 */
export interface StateFile<State> {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly orchestratorName: string;
  readonly startedAt: string;
  readonly startedAtEpochMs: number;
  readonly lastTransitionAt: string;
  readonly lastTransitionAtEpochMs: number;
  readonly currentPhase: string;
  readonly phasesExecuted: number;
  readonly accumulatedDurationMs: number;
  readonly data: State;
  readonly pendingDelegation?: PendingDelegationRecord;
  readonly usedLabels: readonly string[];
}

export interface PendingDelegationRecord {
  readonly label: string;
  readonly kind: "skill" | "agent" | "agent-batch";
  readonly resumeAt: string;
  readonly manifestPath: string;
  readonly emittedAtEpochMs: number;
  readonly deadlineAtEpochMs: number;
  readonly attempt: number;
  readonly effectiveRetryPolicy: {
    readonly maxAttempts: number;
    readonly backoffBaseMs: number;
    readonly maxBackoffMs: number;
  };
  readonly jobIds?: readonly string[];
}

export function readState<S>(
  runDir: string,
  schema?: ZodSchema<S>
): StateFile<S> | null;

export function writeStateAtomic<S>(
  runDir: string,
  state: StateFile<S>,
  schema?: ZodSchema<S>
): void;
```

**Note typage** : `StateFile<State>` et `PendingDelegationRecord` sont **non-exportés publiquement** — ils vivent à la frontière interne entre services et engine. L'engine utilise les types mais le consommateur du package ne les voit jamais directement (il manipule son propre `State` via `data`).

---

## 3. Algorithme — `readState`

```ts
function readState<S>(runDir: string, schema?: ZodSchema<S>): StateFile<S> | null {
  const statePath = path.join(runDir, "state.json");

  // 1. Fichier absent → null (pas une erreur, premier démarrage).
  if (!fs.existsSync(statePath)) return null;

  // 2. Lecture brute.
  let raw: string;
  try {
    raw = fs.readFileSync(statePath, "utf-8");
  } catch (err) {
    throw new StateCorruptedError(`failed to read state.json: ${describeError(err)}`, { cause: err });
  }

  // 3. Parse JSON — malformé → StateCorruptedError.
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new StateCorruptedError(`state.json is not valid JSON: ${describeError(err)}`, { cause: err });
  }

  // 4. Validation schemaVersion présent + === 1.
  if (typeof parsed !== "object" || parsed === null) {
    throw new StateCorruptedError("state.json must be a JSON object");
  }
  if (!("schemaVersion" in parsed)) {
    throw new StateCorruptedError("state.json missing required field: schemaVersion");
  }
  const sv = (parsed as { schemaVersion: unknown }).schemaVersion;
  if (sv !== 1) {
    throw new StateVersionMismatchError(
      `state.json schemaVersion mismatch: expected 1, got ${String(sv)}`
    );
  }

  // 5. Validation shape canonique minimale (§7.1) — champs obligatoires.
  //    Pas de zod ici, check structurel direct. Faille détectée → StateCorruptedError.
  validateCanonicalShape(parsed as Record<string, unknown>);

  // 6. Validation data contre schema si fourni.
  if (schema !== undefined) {
    const result = schema.safeParse((parsed as { data: unknown }).data);
    if (!result.success) {
      throw new StateCorruptedError(
        `state.data failed schema validation: ${summarizeZodError(result.error)}`,
        { cause: result.error }
      );
    }
    // Réaffecter pour bénéficier du typage inféré.
    (parsed as { data: S }).data = result.data;
  }

  return parsed as StateFile<S>;
}
```

**`validateCanonicalShape`** — helper privé, check strict :

```ts
function validateCanonicalShape(obj: Record<string, unknown>): void {
  const required: Array<[string, (v: unknown) => boolean]> = [
    ["runId", (v) => typeof v === "string" && v.length > 0],
    ["orchestratorName", (v) => typeof v === "string" && v.length > 0],
    ["startedAt", (v) => typeof v === "string"],
    ["startedAtEpochMs", (v) => typeof v === "number"],
    ["lastTransitionAt", (v) => typeof v === "string"],
    ["lastTransitionAtEpochMs", (v) => typeof v === "number"],
    ["currentPhase", (v) => typeof v === "string"],
    ["phasesExecuted", (v) => typeof v === "number" && v >= 0],
    ["accumulatedDurationMs", (v) => typeof v === "number" && v >= 0],
    ["data", (v) => v !== undefined],
    ["usedLabels", (v) => Array.isArray(v) && v.every((x) => typeof x === "string")],
  ];
  for (const [field, check] of required) {
    if (!(field in obj)) {
      throw new StateCorruptedError(`state.json missing required field: ${field}`);
    }
    if (!check(obj[field])) {
      throw new StateCorruptedError(`state.json field ${field} has wrong type or value`);
    }
  }
  // pendingDelegation optionnel — si présent, check minimal de kind.
  if (obj.pendingDelegation !== undefined && obj.pendingDelegation !== null) {
    const pd = obj.pendingDelegation as Record<string, unknown>;
    if (!["skill", "agent", "agent-batch"].includes(pd.kind as string)) {
      throw new StateCorruptedError(`pendingDelegation.kind invalid: ${String(pd.kind)}`);
    }
  }
}
```

**Note** : `summarizeZodError` est importé depuis `NIB-M-VALIDATOR` (§5.3) — il tronque à 200 chars pour la discipline PII.

---

## 4. Algorithme — `writeStateAtomic`

```ts
function writeStateAtomic<S>(runDir: string, state: StateFile<S>, schema?: ZodSchema<S>): void {
  // 1. Pre-write validation — si schema fourni, valider state.data avant tout write.
  //    Garantit qu'on n'écrit JAMAIS un state qui ne passe pas son propre schema.
  if (schema !== undefined) {
    const result = schema.safeParse(state.data);
    if (!result.success) {
      throw new StateCorruptedError(
        `cannot write state: data fails schema: ${summarizeZodError(result.error)}`,
        { cause: result.error }
      );
    }
  }

  // 2. Validation schemaVersion === 1 (défense en profondeur).
  if (state.schemaVersion !== 1) {
    throw new StateCorruptedError(`cannot write state: schemaVersion must be 1, got ${state.schemaVersion}`);
  }

  // 3. Sérialiser.
  //    JSON.stringify omet undefined silencieusement (convention §7.1) — c'est voulu.
  //    Functions, Map, Set sont omises/vidées de la même façon (discipline auteur, §4.2, §16.1 NX).
  const json = JSON.stringify(state);

  // 4. Écrire atomiquement : tmp + rename.
  const statePath = path.join(runDir, "state.json");
  const tmpPath = path.join(runDir, "state.json.tmp");
  fs.writeFileSync(tmpPath, json, { encoding: "utf-8" });
  fs.renameSync(tmpPath, statePath);
}
```

**Règles normatives** :

- **P-ATOMIC-WRITE** : `writeFileSync(tmp)` puis `renameSync(tmp, real)`. `rename` est atomique sur même FS POSIX. Un lecteur concurrent voit toujours soit l'ancien fichier soit le nouveau, jamais partiel (I-3 NIB-S, testé par P-SI-b).
- **Pré-validation schema** : si `schema` fourni, `state.data` est validé **avant** tout write. Un state invalide throw `StateCorruptedError` sans rien écrire (ni tmp, ni rename — testé par T-SI-10).
- **`schemaVersion === 1` obligatoire** : défense en profondeur. Un caller qui passe `{...state, schemaVersion: 2}` throw avant write.
- **Pas de cleanup du tmp en cas d'échec** : si `writeFileSync(tmp)` réussit mais `renameSync` échoue (cas rare — perms, FS différent), le tmp peut rester. Accepté : le prochain write l'écrasera (T-SI-11). Le `state.json` original reste intact — invariant critique.
- **Pas de flush/fsync explicite** : `renameSync` garantit visibilité atomique après retour, suffisant v1. Durabilité kernel post-crash = accepté (cas SIGKILL, cf §3.2 NX, hors scope v1).
- **JSON compact sans indentation** (pas de `JSON.stringify(state, null, 2)`) : économise IO et ne change pas la sémantique. Les outils externes (debug humain) peuvent reformatter au besoin.
- **Pas d'écriture de `state.json.tmp` résiduel en sortie** : `renameSync` supprime le tmp de facto. Aucun `state.json.tmp` post-write réussi (invariant P-SI-c testé).

---

## 5. Examples

### 5.1 Premier run — state absent

```ts
const state = readState<MyState>("/tmp/run/01HX");  // null, pas d'erreur
```

### 5.2 Read + schema

```ts
const schema = z.object({ count: z.number() });
const state = readState("/tmp/run/01HX", schema);
// state.data : { count: number } typé via inférence zod
```

### 5.3 Read d'un state corrompu

```ts
// /tmp/run/01HX/state.json contient "{invalid json"
readState("/tmp/run/01HX");  // throw StateCorruptedError("state.json is not valid JSON: ...")
```

### 5.4 Read d'un state version 2

```ts
// /tmp/run/01HX/state.json contient { schemaVersion: 2, ... }
readState("/tmp/run/01HX");  // throw StateVersionMismatchError("expected 1, got 2")
```

### 5.5 Write simple

```ts
const state: StateFile<MyState> = {
  schemaVersion: 1,
  runId: "01HX",
  orchestratorName: "senior-review",
  startedAt: "2026-04-19T12:00:00.000Z",
  startedAtEpochMs: 1745062800000,
  lastTransitionAt: "2026-04-19T12:00:00.000Z",
  lastTransitionAtEpochMs: 1745062800000,
  currentPhase: "enumerate",
  phasesExecuted: 0,
  accumulatedDurationMs: 0,
  data: { count: 0 },
  usedLabels: [],
};
writeStateAtomic("/tmp/run/01HX", state);
// state.json écrit. state.json.tmp absent après return.
```

### 5.6 Write d'un state invalide au schema

```ts
const schema = z.object({ count: z.number() });
const state = { ..., data: { count: "oops" } };
writeStateAtomic("/tmp/run/01HX", state, schema);
// throw StateCorruptedError avant tout write.
// Ni state.json.tmp ni state.json modifié.
```

---

## 6. Edge cases

| Cas | Comportement |
|---|---|
| `state.json` absent au read | Retour `null` (premier run, pas une erreur) |
| `state.json` valide JSON mais objet `null` | `StateCorruptedError("must be a JSON object")` |
| `state.json` sans `schemaVersion` | `StateCorruptedError("missing required field: schemaVersion")` |
| `state.json` avec `schemaVersion: "1"` (string) | `StateVersionMismatchError` (check strict === 1 number) |
| `state.json` avec `schemaVersion: 2` | `StateVersionMismatchError("expected 1, got 2")` |
| `state.json` valide avec `data: null` sans schema | OK — `data` accepte `null` si pas de schema. |
| `state.json` valide avec `data: null` avec schema strict | `StateCorruptedError` (zod rejette selon le schema) |
| Write avec `pendingDelegation: undefined` | Champ omis de JSON (convention §7.1) — pas `"pendingDelegation": null`. Testé T-SI-12. |
| Write avec `pendingDelegation: null` explicite | `"pendingDelegation": null` dans le JSON. Supporté au read (l'engine l'efface via `undefined` en pratique). |
| Write : crash simulé entre `writeFileSync(tmp)` et `rename` | `state.json` original intact, `state.json.tmp` peut subsister. Prochain write l'écrase. T-SI-11. |
| Read concurrent pendant 10 writes séquentiels (P-SI-b) | Chaque read observe soit l'ancien soit le nouveau, jamais partiel. Invariant POSIX. |
| Write de `{...state, fn: () => 1}` (fonction dans data) | `JSON.stringify` omet `fn`. Read reconstruit `{}` sans `fn`. Perte silencieuse documentée (§16.1 NX). |
| Write avec référence circulaire dans data | `JSON.stringify` throw `TypeError`. Propagé au caller — capté par top-level `runOrchestrator` handler (fail-closed). |

---

## 7. Constraints

- **Sync IO** acceptable pour atomicité et ordre d'écriture déterministe. Cohérent avec le reste du runtime (lock, events.ndjson append sync).
- **Pas de caching en RAM** : chaque `readState` relit le fichier. L'engine relit `state.currentPhase` à chaque itération (cf NIB-M-DISPATCH-LOOP §14.1 step 16.a du NX).
- **Pas de validation du format ULID** sur `runId`. Le caller (engine) l'a validé en amont.
- **Pas de post-write read-back verification** : on fait confiance à `renameSync` + kernel. Ajouter un read après write serait du paranoïa-code inutile.
- **Imports figés** :
  - `node:path` (`path.join`)
  - `node:fs` (`fs.existsSync`, `fs.readFileSync`, `fs.writeFileSync`, `fs.renameSync`)
  - `zod` (types seulement — `ZodSchema`)
  - `../errors/concrete` (`StateCorruptedError`, `StateVersionMismatchError`)
  - `./validator` (`summarizeZodError`) — une seule fonction utilitaire, pas de cycle car validator ne dépend pas de state-io.

---

## 8. Tests NIB-T (rappel §6)

| Test | Couverture |
|---|---|
| T-SI-01 | `state.json` absent → `null` |
| T-SI-02 | `state.json` valide v1 → StateFile typé |
| T-SI-03 | JSON invalide → `StateCorruptedError` |
| T-SI-04 | `schemaVersion: 2` → `StateVersionMismatchError` |
| T-SI-05 | `schemaVersion` absent → `StateCorruptedError` |
| T-SI-06 | Valide + schema + data conforme → OK |
| T-SI-07 | Valide + schema + data non-conforme → `StateCorruptedError` avec cause ZodError |
| T-SI-08 | Premier write → state.json créé, tmp absent |
| T-SI-09 | Write remplace existant, aucune trace du tmp |
| T-SI-10 | Write state invalide au schema → throw avant tout write |
| T-SI-11 | Crash entre write et rename → state.json original intact |
| T-SI-12 | Write avec `pendingDelegation: undefined` → champ absent du JSON |
| P-SI-a | Round-trip : `readState(writeStateAtomic(state))` structurellement identique |
| P-SI-b | Atomicité POSIX : 100 reads concurrents pendant 10 writes → aucun read partiel |
| P-SI-c | Pas de résidu `state.json.tmp` post-write réussi |

---

## 9. Integration snippets

### 9.1 Consommation par `runOrchestrator` (flux initial §14.1 step 13)

```ts
import { writeStateAtomic } from "../services/state-io";

const initialState: StateFile<S> = { schemaVersion: 1, runId, orchestratorName: config.name, ... };
writeStateAtomic(runDir, initialState, config.stateSchema);
```

### 9.2 Consommation par `handle-resume` (flux §14.2 step 6)

```ts
import { readState } from "../services/state-io";

const state = readState<S>(runDir, config.stateSchema);
if (state === null) {
  // Emit ERROR preflight state_missing
}
```

### 9.3 Consommation par `dispatch-loop` (branche "transition" §14.1 step 16.n)

```ts
const newState: StateFile<S> = {
  ...state,
  currentPhase: result.nextPhase,
  phasesExecuted: state.phasesExecuted + 1,
  lastTransitionAt: clock.nowWallIso(),
  lastTransitionAtEpochMs: clock.nowEpochMs(),
  accumulatedDurationMs,
  data: result.nextState,
  pendingDelegation: undefined,
};
writeStateAtomic(runDir, newState, config.stateSchema);
```

---

## 10. Definition of Done (DoD)

1. **1 fichier** créé : `src/services/state-io.ts` avec exports `readState`, `writeStateAtomic`, `StateFile<S>`, `PendingDelegationRecord`.
2. **`readState`** :
   - Retourne `null` si fichier absent.
   - Throw `StateCorruptedError` sur JSON invalide, champ obligatoire absent, type incorrect.
   - Throw `StateVersionMismatchError` sur `schemaVersion !== 1`.
   - Throw `StateCorruptedError` (cause = ZodError) sur échec validation schema.
   - Valide shape canonique minimale (11 champs obligatoires + `pendingDelegation.kind` si présent).
3. **`writeStateAtomic`** :
   - Pré-valide `state.data` contre schema si fourni — aucun write si échec.
   - Pré-valide `schemaVersion === 1`.
   - Écrit via `tmp + rename` atomique.
   - Aucun résidu `state.json.tmp` post-write réussi.
   - Omet `pendingDelegation: undefined` du JSON (convention).
4. **Tests NIB-T** : T-SI-01 à T-SI-12, P-SI-a/b/c, P-03/P-04 (§26.2) tous passent.
5. **Imports figés** selon §7.
6. **LOC** : 100-150 runtime.
7. **Pas de méthode exportée qui ne soit dans la signature §2**.

---

## 11. Relation avec les autres NIB-M

- **Consomme** : `NIB-M-ERRORS` (`StateCorruptedError`, `StateVersionMismatchError`), `NIB-M-VALIDATOR` (`summarizeZodError`).
- **Consommé par** :
  - `NIB-M-RUN-ORCHESTRATOR` (write initial state)
  - `NIB-M-HANDLE-RESUME` (read state au resume)
  - `NIB-M-DISPATCH-LOOP` (write après chaque transition/delegate/done/fail)

---

## 12. Metadata

| Champ | Valeur |
|---|---|
| Source NX | §4.3, §4.10, §5.5, §7.1 |
| NIB-T associé | §6 (T-SI, P-SI), §26.2 (P-03/P-04) |
| Invariants NIB-S couverts | I-3 (atomicité), I-10 (JSON-only), I-12 (snapshot-authoritative) |
| Fichier produit | `src/services/state-io.ts` |
| LOC cible | 100-150 |
| Non exporté publiquement | oui — types et fonctions internes |

---

*turnlock — Implicit-Free Execution — "Reliability precedes intelligence."*
