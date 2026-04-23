---
id: NIB-M-VALIDATOR
type: nib-module
version: "1.0.0"
scope: turnlock
module: validator
status: approved
consumers: [claude-code]
superseded_by: []
validates: ["src/services/validator.ts", "tests/services/validator.test.ts"]
---

# NIB-M-VALIDATOR — Validation zod + summary d'erreur

**Package** : `turnlock`
**Source NX** : §5.5 (validator signature), §14.2 step 12 (validation au consume), §11.5 (PII ≤ 200 chars)
**NIB-T associé** : §5 (T-VA-01 à T-VA-10, P-VA-a/b/c)
**NIB-S référencé** : I-5 (déterminisme), I-13 (PII)

---

## 1. Purpose

Deux fonctions pures pour l'intégration avec `zod` :

- **`validateResult`** — wrapper sur `schema.safeParse`, retourne un `ValidationResult<T>` union discriminée `{ ok: true, data: T } | { ok: false, error: ZodError }`.
- **`summarizeZodError`** — transforme une `ZodError` en string ≤ 200 chars pour logging dans `delegation_validation_failed.zodErrorSummary` (§11.5 NX, discipline PII).

**Principe normatif structurant** : le validator ne fait **rien** de plus que ce que zod fait déjà. Sa raison d'être est de :
1. Présenter une API de résultat typée discriminée (facilite le pattern matching côté `consumePendingResult`).
2. Produire un **résumé d'erreur borné** ≤ 200 chars qui évite les fuites PII massives (un ZodError complet peut contenir les valeurs invalides).

**Fichier cible** : `src/services/validator.ts`

**LOC cible** : ~80-120.

---

## 2. Signatures

```ts
import type { ZodSchema, ZodError } from "zod";

export type ValidationResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly error: ZodError };

export function validateResult<T>(rawJson: unknown, schema: ZodSchema<T>): ValidationResult<T>;

export function summarizeZodError(err: ZodError): string;
```

---

## 3. Algorithme — `validateResult`

```ts
export function validateResult<T>(rawJson: unknown, schema: ZodSchema<T>): ValidationResult<T> {
  const result = schema.safeParse(rawJson);
  if (result.success) {
    return { ok: true, data: result.data };
  }
  return { ok: false, error: result.error };
}
```

**Règles normatives** :

- **Fonction pure** — wrap direct de `safeParse`. Pas de try/catch (safeParse ne throw pas, par contrat zod).
- **Pas de coercion** — le schéma passé détermine si la coercion a lieu (via `z.coerce.*` côté caller).
- **Pas de post-processing** — `data` retournée est exactement le parsed de zod (peut être transformé si le schéma utilise `.transform()`).
- **Pas de cache** — chaque appel refait un `safeParse`. Zod est rapide, pas de nécessité d'optimiser.

---

## 4. Algorithme — `summarizeZodError`

```ts
const MAX_SUMMARY_LENGTH = 200;
const ELLIPSIS = "…";  // U+2026

export function summarizeZodError(err: ZodError): string {
  // Pour chaque issue zod, produire "path: code" (ex: "user.email: invalid_email")
  // Pas de valeurs invalides dans le summary (discipline PII I-13).
  const parts: string[] = [];
  for (const issue of err.issues) {
    const path = issue.path.length === 0 ? "root" : issue.path.join(".");
    parts.push(`${path}: ${issue.code}`);
  }
  const joined = parts.join("; ");
  if (joined.length <= MAX_SUMMARY_LENGTH) return joined;
  // Tronquer proprement avec ellipsis
  return joined.slice(0, MAX_SUMMARY_LENGTH - 1) + ELLIPSIS;
}
```

**Règles normatives** :

- **≤ 200 chars garanti** (P-VA-b). Inclut l'ellipsis terminal si tronqué.
- **Pas de valeurs invalides** dans le résumé — seulement `path: code`. Évite les fuites PII (ex. un input `email: "boss@company.com"` invalide ne doit pas apparaître dans les logs).
- **Path "root"** pour issues sans path (erreur à la racine, ex. `null` input avec schema object).
- **Séparateur `; `** entre issues. Compact sans être cryptique.
- **Pas de message humain** (le `issue.message` de zod peut contenir des valeurs). Seulement `issue.code` (enum zod fermé : `"invalid_type"`, `"invalid_string"`, `"too_small"`, etc.).

---

## 5. Examples

### 5.1 validateResult — succès

```ts
const schema = z.object({ verdict: z.string(), score: z.number() });
const result = validateResult({ verdict: "clean", score: 0.9 }, schema);
// { ok: true, data: { verdict: "clean", score: 0.9 } }
if (result.ok) console.log(result.data.verdict);  // TS narrow OK
```

### 5.2 validateResult — échec

```ts
const result = validateResult({ verdict: 1 }, schema);
// { ok: false, error: ZodError([{ path: ["verdict"], code: "invalid_type", ... }]) }
if (!result.ok) {
  console.log(summarizeZodError(result.error));
  // "verdict: invalid_type; score: invalid_type"
}
```

### 5.3 summarizeZodError — erreur longue tronquée

```ts
// 30 issues sur un objet avec beaucoup de champs
const err = someSchema.safeParse(invalidInput).error!;
const summary = summarizeZodError(err);
// "field1: invalid_type; field2: too_small; field3: invalid_string; ...…"
// Garanti ≤ 200 chars (T-VA-09).
```

### 5.4 summarizeZodError — erreur root

```ts
const schema = z.object({ foo: z.string() });
const err = schema.safeParse(null).error!;
const summary = summarizeZodError(err);
// "root: invalid_type" (T-VA-10)
```

---

## 6. Edge cases

| Cas | Comportement |
|---|---|
| `rawJson: null` + schema strict | `ok: false, error: ZodError` (zod reject) |
| `rawJson: "plain string"` + schema object | `ok: false` (zod reject sur root) |
| `rawJson: []` + schema object | `ok: false` |
| Schema avec `.transform()` | `data` contient la valeur transformée (délégué à zod) |
| Schema avec `.optional()` | Fields absents acceptés, `ok: true` |
| `ZodError` avec 0 issues (cas théorique, n'arrive pas en pratique) | Summary = `""` (chaîne vide) |
| Valeur contenant des caractères unicode | Préservés dans path (ex. path `["日本"]`) |
| Path avec index numérique | `path: [0, "name"].join(".")` → `"0.name"`. Cohérent avec zod. |

---

## 7. Constraints

- **Fonctions pures** : aucun side effect, pas de clock, pas de logger.
- **Pas de logging** dans ce module — le summary est retourné, le caller loggue.
- **Pas d'async** — `safeParse` est sync.
- **Pas de dépendance runtime** autre que `zod` (déjà dans `package.json`).
- **Types importés uniquement via `import type`** quand possible (pas d'import runtime de zod hors fonctions).
- **Extensibilité** : si v2 veut un summary plus riche (incluant les valeurs non-PII), ajouter un paramètre `options`. v1 reste minimal.

---

## 8. Tests NIB-T (rappel §5)

| Test | Scénario |
|---|---|
| T-VA-01 | `{ foo: "a", bar: 1 }` + `z.object({foo: z.string(), bar: z.number()})` → `{ ok: true, data }` |
| T-VA-02 | `{ foo: "", bar: 0 }` → `{ ok: true, data }` |
| T-VA-03 | `{ foo: 1, bar: 1 }` (wrong type) → `{ ok: false, error }` avec issue sur "foo" |
| T-VA-04 | `{ foo: "a" }` (bar missing) → `{ ok: false }` |
| T-VA-05 | `null` → `{ ok: false }` |
| T-VA-06 | `"plain string"` → `{ ok: false }` |
| T-VA-07 | `[]` → `{ ok: false }` |
| T-VA-08 | Erreur 1 champ → summary contient path + code, ≤ 200 chars |
| T-VA-09 | Erreur 10+ champs → summary tronqué à 200 chars avec "…" terminal |
| T-VA-10 | Erreur sans path (root) → summary commence par `"root: "` |
| P-VA-a | `validateResult` pure (50 itérations mêmes args → mêmes résultats) |
| P-VA-b | Summary ≤ 200 chars pour toute entrée (50 erreurs aléatoires) |
| P-VA-c | `validateResult(x, schema).ok === true` ⇒ `data` satisfait le schéma (idempotence via re-validate) |

---

## 9. Integration snippets

### 9.1 Consommation par `consumePendingResult` (NIB-M-DISPATCH-LOOP)

```ts
import { validateResult, summarizeZodError } from "../services/validator";
import { DelegationSchemaError } from "../errors/concrete";

function consumePendingResult<T>(schema: ZodSchema<T>): T {
  // ... load raw result from file ...
  const result = validateResult(raw, schema);
  if (!result.ok) {
    logger.emit({
      eventType: "delegation_validation_failed",
      runId, phase, label: pd.label,
      zodErrorSummary: summarizeZodError(result.error),
      timestamp: clock.nowWallIso(),
    });
    throw new DelegationSchemaError(
      `validation failed for ${pd.label}: ${summarizeZodError(result.error)}`,
      { cause: result.error, runId, orchestratorName, phase }
    );
  }
  logger.emit({ eventType: "delegation_validated", runId, phase, label: pd.label, timestamp: clock.nowWallIso() });
  return result.data;
}
```

### 9.2 Consommation par `readState` (NIB-M-STATE-IO)

```ts
// Dans readState, si schema fourni pour data :
const result = schema.safeParse(parsed.data);
if (!result.success) {
  throw new StateCorruptedError(
    `state.data failed schema validation: ${summarizeZodError(result.error)}`,
    { cause: result.error }
  );
}
```

---

## 10. Definition of Done (DoD)

1. **1 fichier** créé : `src/services/validator.ts` avec exports `validateResult`, `summarizeZodError`, `ValidationResult<T>`.
2. **`validateResult`** :
   - Wrap de `schema.safeParse`.
   - Retourne union discriminée `{ ok: true, data: T } | { ok: false, error: ZodError }`.
   - Fonction pure.
3. **`summarizeZodError`** :
   - Retourne string ≤ 200 chars (garanti pour tout input).
   - Format `"path: code; path: code; ..."`.
   - Tronque avec `"…"` (U+2026) si dépassement.
   - Jamais de valeurs invalides dans le summary (PII).
4. **Tests NIB-T** : T-VA-01 à T-VA-10, P-VA-a/b/c tous passent.
5. **Imports** : `zod` (types + `ZodError`, `ZodSchema`).
6. **LOC** : 80-120.

---

## 11. Relation avec les autres NIB-M

- **Consomme** : `zod` (externe, pas de DC nécessaire).
- **Consommé par** :
  - `NIB-M-STATE-IO` (`summarizeZodError` pour `StateCorruptedError.message`)
  - `NIB-M-DISPATCH-LOOP` (via `consumePendingResult`/`consumePendingBatchResults` — valide les résultats de délégations et produit event `delegation_validation_failed`)
- **Pas de dépendance vers** `NIB-M-ERRORS` (n'instancie pas d'erreurs lui-même — c'est le caller qui wrap dans `DelegationSchemaError` ou `StateCorruptedError`).

---

## 12. Metadata

| Champ | Valeur |
|---|---|
| Source NX | §5.5, §11.5, §14.2 step 12 |
| NIB-T associé | §5 (T-VA, P-VA) |
| Invariants NIB-S couverts | I-5, I-13 |
| Fichier produit | `src/services/validator.ts` |
| LOC cible | 80-120 |
| Non exporté publiquement | oui (interne ; zod reste importé par le consommateur du package pour les schémas de ses résultats) |

---

*turnlock — Implicit-Free Execution — "Reliability precedes intelligence."*
