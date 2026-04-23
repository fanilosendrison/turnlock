---
id: NIB-M-PROTOCOL
type: nib-module
version: "1.0.0"
scope: turnlock
module: protocol
status: approved
consumers: [claude-code]
superseded_by: []
---

# NIB-M-PROTOCOL — Writer et parser du bloc `@@TURNLOCK@@`

**Package** : `turnlock`
**Source NX** : §7.4 (format protocole intégral, 4 actions, règles génériques)
**NIB-T associé** : §4 (T-PR-01 à T-PR-26, P-PR-a/b/c/d)
**NIB-S référencé** : §7.4 (forme canonique), I-5 (déterminisme), I-13 (PII), I-9 (surface stable — `PROTOCOL_VERSION`)

---

## 1. Purpose

Deux fonctions pures pour écrire et parser le protocole `@@TURNLOCK@@` :

- **`writeProtocolBlock`** — construit une string formatée selon §7.4 NX pour une des 4 actions (`DELEGATE`, `DONE`, `ERROR`, `ABORTED`), avec les champs spécifiques typés par action.
- **`parseProtocolBlock`** — extrait un `ProtocolBlock` typé depuis une string stdout (potentiellement avec bruit avant/après). Retourne `null` si aucun bloc valide trouvé.

**Principe normatif structurant** : le protocole est **in-band sur stdout**, unidirectionnel (runtime → parent agent). Le writer doit produire un bloc parfaitement parseable par le parser (round-trip testé par P-PR-a). Le parser doit être **tolérant au bruit** (logs stderr mal redirigés) mais **strict sur le format** (pas de champs inventés, pas de versions incompatibles acceptées).

**Fichier cible** : `src/services/protocol.ts`

**LOC cible** : ~200-250.

---

## 2. Signatures

```ts
// src/services/protocol.ts

import { PROTOCOL_VERSION } from "../constants";  // 1 as const

export type ProtocolAction = "DELEGATE" | "DONE" | "ERROR" | "ABORTED";

export interface ParsedProtocolBlock {
  readonly version: number;
  readonly runId: string | null;         // null en preflight ERROR
  readonly orchestrator: string;
  readonly action: ProtocolAction;
  readonly fields: Record<string, string | number | boolean | null>;
}

// Writer fields par action
export interface DelegateFields {
  readonly runId: string;
  readonly orchestrator: string;
  readonly manifest: string;             // chemin absolu manifestPath
  readonly kind: "skill" | "agent" | "agent-batch";
  readonly resumeCmd: string;
}

export interface DoneFields {
  readonly runId: string;
  readonly orchestrator: string;
  readonly output: string;               // chemin absolu output.json
  readonly success: true;
  readonly phasesExecuted: number;
  readonly durationMs: number;
}

export interface ErrorFields {
  readonly runId: string | null;
  readonly orchestrator: string;
  readonly errorKind: string;            // un des OrchestratorErrorKind
  readonly message: string;              // ≤ 200 chars, déjà tronqué par le caller
  readonly phase: string | null;
  readonly phasesExecuted: number;
}

export interface AbortedFields {
  readonly runId: string;
  readonly orchestrator: string;
  readonly signal: "SIGINT" | "SIGTERM";
  readonly phase: string | null;
}

export function writeProtocolBlock(action: "DELEGATE", fields: DelegateFields): string;
export function writeProtocolBlock(action: "DONE", fields: DoneFields): string;
export function writeProtocolBlock(action: "ERROR", fields: ErrorFields): string;
export function writeProtocolBlock(action: "ABORTED", fields: AbortedFields): string;

export function parseProtocolBlock(stdout: string): ParsedProtocolBlock | null;
```

---

## 3. Algorithme — `writeProtocolBlock`

### 3.1 Format générique

```
<ligne vide>
@@TURNLOCK@@
version: 1
run_id: <value | null>
orchestrator: <value>
action: <ACTION>
<field1>: <value>
<field2>: <value>
...
@@END@@
<ligne vide>
```

**Règles de serialization des valeurs** (§7.4 NX) :

- `null` → littéral `null` (pas quoté)
- `true` / `false` → littéraux non quotés
- `number` → représentation décimale standard (`toString`)
- `string` sans caractères spéciaux (ni `:`, ni `\n`, ni `"`, ni `\`) → non quotée
- `string` avec caractères spéciaux → quotée `"..."` avec échappement JSON standard (`\"`, `\n`, `\t`, `\\`, etc.)

**Helper privé** :

```ts
function serializeValue(value: string | number | boolean | null): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  // string — check si besoin de quoter
  if (/[:\n\r\t"\\]/.test(value)) {
    return JSON.stringify(value);  // JSON.stringify gère l'échappement correctement
  }
  return value;
}
```

### 3.2 Action DELEGATE

```ts
function writeDelegate(fields: DelegateFields): string {
  return [
    "",
    "@@TURNLOCK@@",
    `version: ${PROTOCOL_VERSION}`,
    `run_id: ${serializeValue(fields.runId)}`,
    `orchestrator: ${serializeValue(fields.orchestrator)}`,
    `action: DELEGATE`,
    `manifest: ${serializeValue(fields.manifest)}`,
    `kind: ${fields.kind}`,           // kind est un enum, jamais besoin de quoter
    `resume_cmd: ${serializeValue(fields.resumeCmd)}`,
    "@@END@@",
    "",
    "",
  ].join("\n");
}
```

### 3.3 Action DONE

```ts
function writeDone(fields: DoneFields): string {
  return [
    "",
    "@@TURNLOCK@@",
    `version: ${PROTOCOL_VERSION}`,
    `run_id: ${serializeValue(fields.runId)}`,
    `orchestrator: ${serializeValue(fields.orchestrator)}`,
    `action: DONE`,
    `output: ${serializeValue(fields.output)}`,
    `success: ${serializeValue(fields.success)}`,       // toujours true dans DONE
    `phases_executed: ${fields.phasesExecuted}`,
    `duration_ms: ${fields.durationMs}`,
    "@@END@@",
    "",
    "",
  ].join("\n");
}
```

### 3.4 Action ERROR

```ts
function writeError(fields: ErrorFields): string {
  return [
    "",
    "@@TURNLOCK@@",
    `version: ${PROTOCOL_VERSION}`,
    `run_id: ${serializeValue(fields.runId)}`,           // null autorisé (preflight)
    `orchestrator: ${serializeValue(fields.orchestrator)}`,
    `action: ERROR`,
    `error_kind: ${fields.errorKind}`,                   // un des OrchestratorErrorKind, snake_case, safe
    `message: ${serializeValue(fields.message)}`,
    `phase: ${serializeValue(fields.phase)}`,             // null autorisé (preflight ou pas de phase courante)
    `phases_executed: ${fields.phasesExecuted}`,
    "@@END@@",
    "",
    "",
  ].join("\n");
}
```

### 3.5 Action ABORTED

```ts
function writeAborted(fields: AbortedFields): string {
  return [
    "",
    "@@TURNLOCK@@",
    `version: ${PROTOCOL_VERSION}`,
    `run_id: ${serializeValue(fields.runId)}`,
    `orchestrator: ${serializeValue(fields.orchestrator)}`,
    `action: ABORTED`,
    `signal: ${fields.signal}`,                          // SIGINT ou SIGTERM, safe
    `phase: ${serializeValue(fields.phase)}`,
    "@@END@@",
    "",
    "",
  ].join("\n");
}
```

### 3.6 Entry point writeProtocolBlock (overload dispatch)

```ts
export function writeProtocolBlock(action: ProtocolAction, fields: any): string {
  switch (action) {
    case "DELEGATE": return writeDelegate(fields);
    case "DONE": return writeDone(fields);
    case "ERROR": return writeError(fields);
    case "ABORTED": return writeAborted(fields);
  }
}
```

---

## 4. Algorithme — `parseProtocolBlock`

### 4.1 Pipeline

```ts
function parseProtocolBlock(stdout: string): ParsedProtocolBlock | null {
  // 1. Trouver la première ligne @@TURNLOCK@@
  const lines = stdout.split(/\r?\n/);
  const startIdx = lines.findIndex((l) => l.trim() === "@@TURNLOCK@@");
  if (startIdx === -1) return null;

  // 2. Trouver le @@END@@ correspondant après startIdx
  const endIdx = lines.findIndex((l, i) => i > startIdx && l.trim() === "@@END@@");
  if (endIdx === -1) return null;

  // 3. Extraire les lignes entre (exclusif) — ce sont les key: value
  const payloadLines = lines.slice(startIdx + 1, endIdx);

  // 4. Parser chaque ligne key: value
  const parsed: Record<string, string | number | boolean | null> = {};
  for (const line of payloadLines) {
    if (line.trim() === "") continue;  // ligne vide tolérée
    const result = parseKeyValueLine(line);
    if (result === null) return null;  // format invalide
    parsed[result.key] = result.value;
  }

  // 5. Validation des champs obligatoires
  if (parsed.version !== PROTOCOL_VERSION) return null;  // version incompatible → null
  if (typeof parsed.orchestrator !== "string") return null;
  if (typeof parsed.action !== "string" || !isValidAction(parsed.action)) return null;
  // run_id : string ou null
  if (parsed.run_id !== null && typeof parsed.run_id !== "string") return null;

  // 6. Extraire les champs du bloc et reconstruire le ParsedProtocolBlock
  const { version, run_id, orchestrator, action, ...rest } = parsed;
  // Normaliser les noms snake_case → camelCase dans fields
  const fields: Record<string, string | number | boolean | null> = {};
  for (const [k, v] of Object.entries(rest)) {
    fields[snakeToCamel(k)] = v;
  }
  return {
    version: version as number,
    runId: run_id as string | null,
    orchestrator: orchestrator as string,
    action: action as ProtocolAction,
    fields,
  };
}
```

### 4.2 Helpers privés

```ts
function parseKeyValueLine(line: string): { key: string; value: string | number | boolean | null } | null {
  // Regex : key (identifier) : value (reste)
  const match = line.match(/^([a-z_][a-z0-9_]*): (.*)$/);
  if (!match) return null;
  const key = match[1];
  const raw = match[2];
  return { key, value: parseValue(raw) };
}

function parseValue(raw: string): string | number | boolean | null {
  if (raw === "null") return null;
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(raw)) {
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
  }
  // String quotée → parser JSON-style
  if (raw.startsWith('"') && raw.endsWith('"')) {
    try { return JSON.parse(raw); } catch { return raw; }  // fallback sur raw
  }
  return raw;  // string non quotée
}

function isValidAction(s: string): s is ProtocolAction {
  return s === "DELEGATE" || s === "DONE" || s === "ERROR" || s === "ABORTED";
}

function snakeToCamel(s: string): string {
  return s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}
```

### 4.3 Règles normatives

- **Bruit avant/après le bloc toléré** : le parser scan pour la première ligne `@@TURNLOCK@@` (T-PR-26). Tout ce qui précède est ignoré.
- **Pas de `@@END@@`** → `null` (T-PR-21).
- **Pas de `@@TURNLOCK@@`** → `null` (T-PR-22).
- **Version incompatible (`version: 2`)** → `null` (T-PR-23). Le runtime émetteur et le parser côté parent agent sont alignés sur `PROTOCOL_VERSION` ; un mismatch signale une incompatibilité de versions runtime.
- **Action inconnue** → `null` (T-PR-24).
- **Deux blocs dans la même string** : retourne le **premier** (T-PR-25). La règle §7.4 "un seul bloc par invocation" est garantie par le runtime émetteur ; le parser est tolérant.
- **Normalisation snake_case → camelCase** : les champs dans le bloc utilisent snake_case (`run_id`, `phases_executed`, `resume_cmd`). Le `ParsedProtocolBlock.fields` expose en camelCase (`runId`, `phasesExecuted`, `resumeCmd`) pour uniformité avec le reste du code TS. **Exception** : `runId` est extrait comme champ top-level, pas dans `fields`. Idem `orchestrator`, `action`, `version`.
- **Parse booléens/nombres depuis le string** : `success: true` → `fields.success === true` (boolean, pas string). `phases_executed: 5` → `fields.phasesExecuted === 5` (number). Testé T-PR-18, T-PR-19.

### 4.4 Round-trip garanti (P-PR-a)

Pour toute écriture `writeProtocolBlock(action, fields)`, `parseProtocolBlock(...)` sur le résultat reconstruit les mêmes champs sémantiques (modulo normalisation camelCase et types TS).

Testé sur 4 actions × 5 variantes chacune (T-PR-01 à T-PR-12 pour le writer, T-PR-13 à T-PR-19 pour le parser).

---

## 5. Examples

> **Note** : les noms d'orchestrateur (`senior-review`) utilisés dans les exemples ci-dessous proviennent du premier consommateur (Claude Code, voir `docs/consumers/claude-code/`). Ce sont des labels opaques pour le runtime — toute autre convention est valide tant que le format protocole est respecté. Les chemins utilisent le RUN_DIR root par défaut `.turnlock/runs/` (surchargeable via env / config, cf NIB-M-RUN-DIR §1).

### 5.1 Writer DELEGATE

```ts
const block = writeProtocolBlock("DELEGATE", {
  runId: "01HXABC",
  orchestrator: "senior-review",
  manifest: "/tmp/.turnlock/runs/senior-review/01HXABC/delegations/review-0.json",
  kind: "skill",
  resumeCmd: "bun run ./main.ts --run-id 01HXABC --resume",
});
// Produit (avec lignes vides auto) :
//
// @@TURNLOCK@@
// version: 1
// run_id: 01HXABC
// orchestrator: senior-review
// action: DELEGATE
// manifest: /tmp/.turnlock/runs/senior-review/01HXABC/delegations/review-0.json
// kind: skill
// resume_cmd: "bun run ./main.ts --run-id 01HXABC --resume"
// @@END@@
```

Note : `resume_cmd` est quoté car contient des espaces (`/[:\n\r\t"\\]/` ne match pas les espaces, mais on peut choisir de quoter systématiquement les commandes pour lisibilité — **DÉCISION** : on applique strictement §3.1 (quote uniquement si caractères spéciaux). Les espaces seuls ne nécessitent pas de quotes. Le test T-PR-01 spec requiert les quotes pour la ligne resume_cmd → on **quote par précaution** pour les résumes_cmd qui contiennent `/` ou `--` → reste à voir.

**DÉCISION NIB-M finale** : `serializeValue` quote sur `/[:\n\r\t"\\]/` comme définie en §3.1. Un `resume_cmd` qui ne contient aucun de ces chars est **non quoté**. Les tests T-PR-01 doivent refléter ce comportement. Si le NIB-T spec dit « quoté car espaces », c'est une décision du NIB-T à revisiter en GREEN (discipline §29.1 NIB-T).

### 5.2 Writer ERROR preflight

```ts
const block = writeProtocolBlock("ERROR", {
  runId: null,
  orchestrator: "senior-review",
  errorKind: "invalid_config",
  message: "OrchestratorConfig.resumeCommand is required",
  phase: null,
  phasesExecuted: 0,
});
// run_id: null
// phase: null
// message quoté car contient des espaces et "." → FAUX, "." n'est pas dans notre regex
// Décision : on ne quote que si `/[:\n\r\t"\\]/` match. "OrchestratorConfig.resumeCommand is required" → pas quoté.
```

### 5.3 Parser avec bruit avant

```ts
const stdout = `
Some stderr leak
Another line
@@TURNLOCK@@
version: 1
run_id: 01HX
orchestrator: foo
action: DONE
output: /tmp/out.json
success: true
phases_executed: 3
duration_ms: 1234
@@END@@
`;

const block = parseProtocolBlock(stdout);
// {
//   version: 1,
//   runId: "01HX",
//   orchestrator: "foo",
//   action: "DONE",
//   fields: { output: "/tmp/out.json", success: true, phasesExecuted: 3, durationMs: 1234 }
// }
```

---

## 6. Edge cases

| Cas | Comportement |
|---|---|
| String vide en entrée | `null` |
| Bloc avec ligne vide au milieu | Tolérée (skip) |
| Bloc avec trailing whitespace sur une ligne | `line.trim()` pour détecter `@@TURNLOCK@@` / `@@END@@`, mais parsing strict sur `key: value` |
| `version: 1.0` (avec décimale) | Parsé comme `1` (nombre) → match `PROTOCOL_VERSION` si === 1, sinon `null` |
| Message contient des `"` | Quoted et échappé par `JSON.stringify` : `"escape \\\"inside\\\""` |
| Message contient `\n` | Quoted, sérialisé `"with\\nnewline"` |
| Valeur `null` non quoté dans le bloc (writer) | Correct, littéral `null` |
| Valeur `"null"` string quotée dans le bloc | Reparsée comme string `"null"`, pas null |
| Action `"DELEGATE "` avec espace trailing | `line.match` sur strict key/value → la ligne `action: DELEGATE ` → value = `"DELEGATE "` → isValidAction fail → null |
| 2 blocs consécutifs dans stdout | Retourne le premier (findIndex trouve la première occurrence) |

---

## 7. Constraints

- **Fonctions pures** : aucune I/O, aucun clock, aucun logger. Testable sans setup.
- **Pas de dépendance externe** sauf types (`PROTOCOL_VERSION` constant).
- **Parser tolérant au bruit, strict sur format** : toute incohérence structurelle → `null`. Aucune tolérance sur version mismatch.
- **Writer produit toujours du valid round-trip** : garantie par P-PR-a (testée sur 20 variantes).
- **Pas de validation des champs métier** : le writer fait confiance au caller (ex. `manifest` est un chemin absolu, `output` existe, etc.). Le parser ne re-valide pas non plus — c'est le caller du parser (parent agent) qui interprète.
- **`PROTOCOL_VERSION = 1`** constant importé d'un module central (cf NIB-M-PUBLIC-API). Toute modification = breaking change major.

---

## 8. Tests NIB-T (rappel §4)

| Groupe | Tests |
|---|---|
| Writer DELEGATE | T-PR-01 à T-PR-03 (skill/agent/agent-batch) |
| Writer DONE | T-PR-04, T-PR-05 |
| Writer ERROR | T-PR-06 à T-PR-10 (preflight, avec phase, avec quoting) |
| Writer ABORTED | T-PR-11, T-PR-12 |
| Parser happy | T-PR-13 à T-PR-19 (tous kinds + boolean/number parsing) |
| Parser rejets | T-PR-20 à T-PR-24 (pas de bloc, manque delim, version incompatible, action inconnue) |
| Parser multiplicité | T-PR-25 (2 blocs → premier), T-PR-26 (bruit avant) |
| Propriétés | P-PR-a (round-trip 20 variantes), P-PR-b (pureté), P-PR-c (`@@TURNLOCK@@` + `@@END@@` présents), P-PR-d (champs obligatoires version/run_id/orchestrator/action) |

---

## 9. Integration snippets

### 9.1 Émission depuis dispatch-loop (branche delegate §14.1 step 16.n)

```ts
import { writeProtocolBlock } from "../services/protocol";

const block = writeProtocolBlock("DELEGATE", {
  runId,
  orchestrator: config.name,
  manifest: manifestPath,
  kind: request.kind,
  resumeCmd: config.resumeCommand(runId),
});
process.stdout.write(block);
```

### 9.2 Émission depuis run-orchestrator preflight

```ts
const block = writeProtocolBlock("ERROR", {
  runId: null,  // pas encore généré
  orchestrator: config.name ?? "unknown",
  errorKind: "invalid_config",
  message: err.message.slice(0, 200),
  phase: null,
  phasesExecuted: 0,
});
process.stdout.write(block);
process.exit(1);
```

### 9.3 Côté parent agent (hors-runtime, illustratif)

```ts
// Parent agent lit stdout de l'orchestrateur.
const stdout = await captureStdout(cmd);
const block = parseProtocolBlock(stdout);
if (!block) throw new Error("No TURNLOCK block in stdout");
switch (block.action) {
  case "DELEGATE": /* lire manifest, invoquer skill/agent/batch, relancer resume_cmd */ break;
  case "DONE":     /* lire output, présenter */ break;
  case "ERROR":    /* afficher error_kind + message */ break;
  case "ABORTED":  /* informer + relance manuelle possible */ break;
}
```

---

## 10. Definition of Done (DoD)

1. **1 fichier** créé : `src/services/protocol.ts` avec exports `writeProtocolBlock`, `parseProtocolBlock`, `ParsedProtocolBlock`, `ProtocolAction`, et les 4 interfaces `*Fields`.
2. **`writeProtocolBlock`** :
   - 4 overloads (DELEGATE, DONE, ERROR, ABORTED) avec types `*Fields` distincts.
   - Produit des blocs round-trip-parseable (vérifié P-PR-a).
   - Sérialise null/boolean/number nativement, quote string si caractères spéciaux.
   - Inclut `version: 1` (literal PROTOCOL_VERSION).
3. **`parseProtocolBlock`** :
   - Retourne `null` sur format invalide (pas de delimiter, version incompatible, action inconnue).
   - Tolère le bruit avant `@@TURNLOCK@@` (T-PR-26).
   - Retourne le premier bloc si plusieurs (T-PR-25).
   - Normalise snake_case → camelCase dans `fields`.
   - Parse boolean (`true`/`false`) et number littéralement.
4. **Fonctions pures** : aucun import de clock, logger, fs. Seulement types + constantes.
5. **Tests NIB-T** : T-PR-01 à T-PR-26, P-PR-a à P-PR-d, C-FC-11 (un seul bloc par invocation).
6. **LOC** : 200-250.

---

## 11. Relation avec les autres NIB-M

- **Consomme** : constante `PROTOCOL_VERSION` (définie par NIB-M-PUBLIC-API et importée ici).
- **Consommé par** :
  - `NIB-M-RUN-ORCHESTRATOR` (émission ERROR preflight)
  - `NIB-M-DISPATCH-LOOP` (émission DELEGATE/DONE/ERROR à chaque branche)
  - `NIB-M-HANDLE-RESUME` (émission ERROR preflight resume + ERROR/DELEGATE sur retry/fatal)
  - `NIB-M-LOCK` (indirect — émission ERROR `run_locked` via l'engine)
  - Handler SIGINT/SIGTERM (émission ABORTED)

---

## 12. Metadata

| Champ | Valeur |
|---|---|
| Source NX | §7.4 (intégral) |
| NIB-T associé | §4 (T-PR + P-PR) |
| Invariants NIB-S couverts | I-5, §6.4 (mapping PhaseResult.kind ↔ action) |
| Fichier produit | `src/services/protocol.ts` |
| LOC cible | 200-250 |
| Non exporté publiquement | oui (interne) |

---

*turnlock — Implicit-Free Execution — "Reliability precedes intelligence."*
