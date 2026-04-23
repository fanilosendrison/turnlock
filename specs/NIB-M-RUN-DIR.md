---
id: NIB-M-RUN-DIR
type: nib-module
version: "1.0.0"
scope: turnlock
module: run-dir
status: approved
consumers: [claude-code]
superseded_by: []
---

# NIB-M-RUN-DIR — Résolution du RUN_DIR + cleanup rétention

**Package** : `turnlock`
**Source NX** : §5.5 (resolveRunDir + cleanupOldRuns), §6.1 (retentionDays), §14.1 step 4-5
**NIB-T associé** : §7 (T-RD-01 à T-RD-08, P-RD-a/b)
**NIB-S référencé** : §5 P-ATOMIC-WRITE (non applicable ici — mkdir/rmdir sont non-atomiques), I-11 (lock per-runDir)

---

## 1. Purpose

Deux fonctions utilitaires pour la gestion des répertoires de run :

- **`resolveRunDir`** — construit le chemin absolu du RUN_DIR selon la convention par défaut `<cwd>/.turnlock/runs/<name>/<runId>/`, surchargeable via env var ou config. Pas d'I/O, fonction pure.
- **`cleanupOldRuns`** — supprime les RUN_DIRs plus anciens que `retentionDays` jours, en préservant **impérativement** le `currentRunId`. Effet de bord filesystem.

**Principe normatif structurant** : le RUN_DIR est scopé au quadruplet `(cwd, runDirRoot, orchestratorName, runId)`. Deux runs sur des `cwd` ou `runDirRoot` différents ne se marchent jamais dessus. C'est le couple `(cwd, runDirRoot)` qui porte l'isolement filesystem naturel.

**Précédence `runDirRoot`** (du plus prioritaire au plus faible) :
1. Env var `TURNLOCK_RUN_DIR_ROOT` — override externe (tests, wrappers consommateurs).
2. Champ `OrchestratorConfig.runDirRoot` — contrôle programmatique dans le script TS.
3. Défaut : `.turnlock/runs` (relatif à `cwd`).

Si `runDirRoot` est **relatif**, il est joint à `cwd`. Si **absolu**, il est utilisé tel quel (le `cwd` n'entre plus en ligne de compte). Path final : `<root>/<orchestratorName>/<runId>`.

**Fichier cible** : `src/services/run-dir.ts`

**LOC cible** : ~70-100.

---

## 2. Module A — `resolveRunDir`

### 2.1 Signature

```ts
export function resolveRunDir(
  cwd: string,
  orchestratorName: string,
  runId: string,
  runDirRoot?: string,
): string;
```

### 2.2 Spécification

```ts
const DEFAULT_RUN_DIR_ROOT = path.join(".turnlock", "runs");
const RUN_DIR_ROOT_ENV_VAR = "TURNLOCK_RUN_DIR_ROOT";

function resolveRunDirRoot(cwd: string, configRoot?: string): string {
  const envRoot = process.env[RUN_DIR_ROOT_ENV_VAR];
  // Empty string is treated as "unset" on both layers — prevents silent
  // collapse to `<cwd>/<name>/<runId>` if a caller wires `runDirRoot: ""`.
  const root =
    envRoot !== undefined && envRoot !== ""
      ? envRoot
      : configRoot !== undefined && configRoot !== ""
        ? configRoot
        : DEFAULT_RUN_DIR_ROOT;
  return path.isAbsolute(root) ? root : path.join(cwd, root);
}

function resolveRunDir(
  cwd: string,
  orchestratorName: string,
  runId: string,
  runDirRoot?: string,
): string {
  if (cwd === "") throw new InvalidConfigError("cwd cannot be empty");
  // Note : orchestratorName et runId sont validés en amont par runOrchestrator.
  // Cette fonction ne re-valide pas leur format — elle compose mécaniquement.
  return path.join(resolveRunDirRoot(cwd, runDirRoot), orchestratorName, runId);
}
```

### 2.3 Règles normatives

- **Fonction pure** — pas d'I/O, pas d'effet de bord. Pour un même tuple `(cwd, name, runId, runDirRoot, env)`, deux appels produisent la même string.
- **Utilise `path.join`** (Node `node:path`) pour normaliser les séparateurs et gérer les cwd avec/sans slash final.
- **Défaut `.turnlock/runs/`** : préfixe neutre propre au runtime, relatif au `cwd`. Les consommateurs peuvent surcharger via env var ou champ config (voir §1 Précédence).
- **String vide** (env var ou `runDirRoot` config) → traitée comme non définie (fallback sur le niveau suivant). Évite un collapse silencieux vers `<cwd>/<name>/<runId>` si un caller wire `runDirRoot: ""` par inadvertance.
- **`runDirRoot` absolu** → utilisé tel quel. **Relatif** → joint à `cwd` via `path.join`.
- **Cwd vide** → throw `InvalidConfigError("cwd cannot be empty")`. Défensif, même quand `runDirRoot` est absolu (on garde la règle simple : `cwd` est toujours obligatoire). Aucun appel légitime ne passe `""` — c'est un bug caller.
- **Pas de validation de format** sur `orchestratorName` et `runId` — le caller (engine) a déjà validé en amont (§6.1 NIB-S pour `name`, ULID regex implicite pour `runId`).
- **Pas de `path.resolve`** — on veut conserver `cwd` tel quel, pas le résoudre en chemin absolu. C'est au caller de passer un cwd absolu (typiquement `process.cwd()`).

### 2.4 Tests NIB-T (§7.1)

| Test | Input | Output |
|---|---|---|
| T-RD-01 | `cwd="/repo"`, `name="senior-review"`, `runId="01HX"` (défaut) | `"/repo/.turnlock/runs/senior-review/01HX"` |
| T-RD-02 | `cwd` avec espaces (défaut) | chemin correctement composé (`path.join` gère) |
| T-RD-03 | `cwd=""` | throw `InvalidConfigError("cwd cannot be empty")` |
| T-RD-09 | `runDirRoot=".claude/run/cc-orch"` (relatif) | `"<cwd>/.claude/run/cc-orch/<name>/<runId>"` |
| T-RD-10 | `runDirRoot="/abs/path"` (absolu) | `"/abs/path/<name>/<runId>"` (cwd ignoré) |
| T-RD-11 | Env `TURNLOCK_RUN_DIR_ROOT=".x"` prime sur `runDirRoot=".y"` | chemin basé sur `.x` |
| T-RD-12 | Env `TURNLOCK_RUN_DIR_ROOT=""` (vide) | fallback sur config ou défaut |
| T-RD-14 | `runDirRoot=""` (vide côté config) | fallback sur défaut (pas de collapse) |

### 2.5 Edge cases

| Cas | Comportement |
|---|---|
| `cwd` avec trailing slash (`/repo/`) | `path.join` normalise : `"/repo/.claude/run/..."` |
| `cwd` windows-style (`C:\foo`) | `path.join` gère sur Windows ; sur POSIX ce serait traité comme literal. v1 POSIX only. |
| `orchestratorName` avec caractères spéciaux | Pas de validation ici (caller validate) — la fonction compose quand même. Comportement non défini si `name` contient `/` ou `..` — c'est un bug amont. |

---

## 3. Module B — `cleanupOldRuns`

### 3.1 Signature

```ts
export function cleanupOldRuns(
  cwd: string,
  orchestratorName: string,
  retentionDays: number,
  currentRunId: string,
  runDirRoot?: string,
): number;
```

Retourne le **nombre de RUN_DIRs supprimés** (pour logging amont, non utilisé pour décisions).

### 3.2 Spécification

```ts
function cleanupOldRuns(
  cwd: string,
  orchestratorName: string,
  retentionDays: number,
  currentRunId: string,
  runDirRoot?: string,
): number {
  const baseDir = path.join(resolveRunDirRoot(cwd, runDirRoot), orchestratorName);
  if (!fs.existsSync(baseDir)) return 0;

  const retentionMs = retentionDays * 24 * 60 * 60 * 1000;
  const thresholdEpoch = Date.now() - retentionMs;

  let deleted = 0;
  const entries = fs.readdirSync(baseDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name === currentRunId) continue;  // INVARIANT P-RD-a : jamais supprimer currentRunId

    const runDir = path.join(baseDir, entry.name);
    let stat;
    try {
      stat = fs.statSync(runDir);
    } catch {
      continue;  // best-effort : un dir disparu pendant la boucle est ignoré
    }

    // Rétention : strictement `>`, pas `>=`. Un dir pile à retentionDays est conservé.
    if (stat.mtimeMs < thresholdEpoch) {
      try {
        fs.rmSync(runDir, { recursive: true, force: true });
        deleted++;
      } catch {
        // best-effort : fichier verrouillé ou autre, on skip sans crash
      }
    }
  }
  return deleted;
}
```

### 3.3 Règles normatives

- **P-RD-a — Jamais supprimer `currentRunId`** : garde-fou en tête de boucle. Même si `currentRunId` avait (improbablement) une `mtime` trop vieille, il est protégé par nom.
- **Scope strict par `orchestratorName`** : l'opération ne touche **jamais** les RUN_DIRs d'autres orchestrateurs (§7.1 T-RD-08). C'est l'isolement par `path.join(<runDirRoot>, orchestratorName)`.
- **Rétention strict `>`** : un dir pile à `retentionDays` jours (mtime === threshold) est conservé. Évite les effets de bord liés à la granularité ms.
- **Best-effort sur les erreurs fs** : un `stat` qui throw (dir disparu entre `readdir` et `stat`) ou un `rmSync` qui throw (fichier verrouillé) est ignoré. **Jamais** de throw qui remonte. Le cleanup est un housekeeping optionnel — un échec ne doit pas casser le démarrage du run.
- **Pas de log ici** — la fonction retourne le count. Le caller (engine) peut logger ou non.
- **`rmSync` avec `recursive: true, force: true`** — équivalent `rm -rf`. Safe car on ne peut arriver ici que si `entry.isDirectory()` et `entry.name !== currentRunId`.
- **`baseDir` inexistant** → retour 0. Pas d'erreur.
- **Pas de cleanup cross-process concurrent** : si deux orchestrateurs tournent en parallèle (runIds différents, même `name`), chacun appelle `cleanupOldRuns(currentRunId_X)` et `cleanupOldRuns(currentRunId_Y)`. Chacun protège son propre currentRunId. Pas de coordination nécessaire — le pire cas est un double `rmSync` sur un même vieux dir, qui est idempotent avec `force: true`.

### 3.4 Tests NIB-T (§7.2)

Setup : créer 5 RUN_DIRs avec mtimes variées, retention = 7 jours.

| Test | Situation | Comportement |
|---|---|---|
| T-RD-04 | `currentRunId` dans la liste, même si mtime trop vieille | Jamais supprimé |
| T-RD-05 | Run > retentionDays | Supprimé |
| T-RD-06 | Run = retentionDays exactement (mtime === threshold) | Conservé (strict `>`) |
| T-RD-07 | Retour de fonction | Nombre de dirs supprimés |
| T-RD-08 | RUN_DIR d'un autre orchestrateur | Pas touché (scope strict) |
| P-RD-a | Jamais supprime `currentRunId` sur 20 scénarios | Invariant |
| P-RD-b | 2 `orchestratorName` différents → chemins disjoints (aucun ancêtre commun hors racine) | Invariant |

### 3.5 Edge cases

| Cas | Comportement |
|---|---|
| `baseDir` n'existe pas encore (premier run de cet orchestrateur) | Retour 0, pas d'erreur |
| `currentRunId` n'existe pas encore dans `baseDir` (vient d'être généré) | OK, il sera créé après par `runOrchestrator`. Le cleanup tourne avant la création du RUN_DIR courant. |
| `retentionDays: 0` | Tous les runs sauf currentRunId supprimés (threshold = now, strict `>`) |
| `retentionDays: Infinity` | threshold = -Infinity, aucun run supprimé sauf bugs mtime |
| Fichier non-dir dans `baseDir` (ne devrait pas arriver) | Skip (check `entry.isDirectory()`) |
| `rmSync` échoue (fichier verrouillé, perm denied) | Skip silencieux, cleanup continue |

---

## 4. Constraints

- **`resolveRunDir` pure** : pas d'I/O, pas d'appel clock. Mockable sans setup.
- **`cleanupOldRuns` best-effort** : jamais de throw qui remonte. Le caller ignore les erreurs silencieuses — le cleanup est optionnel.
- **Aucune logique de rétention avancée** : pas de "garder les N derniers" ni "garder les runs réussis". Seulement threshold mtime. Simplicité v1.
- **`currentRunId` protection systématique** : check par nom en tête de boucle. Jamais de path-based check (évite les bugs de symlink, etc.).
- **Pas de récursion profonde** : le cleanup gère un niveau (`baseDir/*`) avec `rmSync(..., recursive: true)` qui supprime les sous-arborescences. Pas de traversée manuelle.
- **Utilise `fs` sync** : acceptable car le cleanup est au démarrage (pas dans une hot path). Cohérence avec les autres sync writes du runtime (state atomic, lock).

---

## 5. Integration snippets

### 5.1 Consommation par `runOrchestrator` (flux initial §14.1 step 4-5, step 15)

```ts
import { resolveRunDir, cleanupOldRuns } from "../services/run-dir";

const runDir = resolveRunDir(cwd, config.name, runId, config.runDirRoot);
fs.mkdirSync(runDir, { recursive: true });
fs.mkdirSync(path.join(runDir, "delegations"), { recursive: true });
fs.mkdirSync(path.join(runDir, "results"), { recursive: true });

// ... lock acquire, state init, logger ...

// Step 15 : cleanup runs anciennes (ne jamais toucher le RUN_DIR courant).
const deleted = cleanupOldRuns(
  cwd,
  config.name,
  config.retentionDays ?? 7,
  runId,
  config.runDirRoot,
);
// Pas d'event dédié pour le cleanup en v1 — optionnel.
```

### 5.2 Consommation par `handle-resume` (flux §14.2 step 4-5)

```ts
const runDir = resolveRunDir(cwd, config.name, argv.runId, config.runDirRoot);
if (!fs.existsSync(runDir)) {
  // Emit ERROR state_missing preflight.
}
// Pas de cleanup au resume — on reprend un run existant.
```

---

## 6. Definition of Done (DoD)

1. **1 fichier** créé : `src/services/run-dir.ts` avec deux exports nommés `resolveRunDir`, `cleanupOldRuns`, plus un helper interne `resolveRunDirRoot`.
2. **`resolveRunDir`** :
   - Pure : mêmes inputs + même env → même output.
   - Compose `<root>/<name>/<runId>` via `path.join` où `root` = env `TURNLOCK_RUN_DIR_ROOT` > `runDirRoot` arg > `.turnlock/runs` (défaut, relatif à `cwd`).
   - Throw `InvalidConfigError("cwd cannot be empty")` si `cwd === ""`.
3. **`cleanupOldRuns`** :
   - Jamais supprime `currentRunId` (invariant P-RD-a).
   - Scope strict par `orchestratorName` (invariant P-RD-b).
   - Rétention strict `>` (égalité = conservé).
   - Retourne le count des dirs supprimés.
   - Best-effort : aucune erreur fs ne remonte.
   - Retour 0 si `baseDir` inexistant.
4. **Tests NIB-T passent** : T-RD-01 à T-RD-08, T-RD-09 à T-RD-12 (override), P-RD-a, P-RD-b.
5. **Imports** :
   - `node:path` (`path.join`, `path.isAbsolute`)
   - `node:fs` (`fs.existsSync`, `fs.readdirSync`, `fs.statSync`, `fs.rmSync`)
   - `../errors/concrete` (`InvalidConfigError`)
6. **LOC** : 70-100.

---

## 7. Relation avec les autres NIB-M

- **Consomme** : `NIB-M-ERRORS` (`InvalidConfigError`).
- **Consommé par** :
  - `NIB-M-RUN-ORCHESTRATOR` (résolution + cleanup au démarrage initial)
  - `NIB-M-HANDLE-RESUME` (résolution + check existence au resume)
  - `NIB-M-LOCK` (utilise le path pour construire `$RUN_DIR/.lock`)
  - `NIB-M-STATE-IO` (utilise le path pour `$RUN_DIR/state.json`)
  - `NIB-M-LOGGER` (utilise le path pour `$RUN_DIR/events.ndjson`)
  - `NIB-M-BINDINGS` (utilise le path pour `$RUN_DIR/delegations/`, `$RUN_DIR/results/`)

---

## 8. Metadata

| Champ | Valeur |
|---|---|
| Source NX | §5.5, §6.1 (retentionDays), §14.1 step 4-5/step 15 |
| NIB-T associé | §7 (T-RD-01 à T-RD-08, P-RD-a/b) |
| Invariants NIB-S couverts | (cleanup : garde-fou currentRunId) |
| Fichier produit | `src/services/run-dir.ts` |
| LOC cible | 70-100 |
| Non exporté publiquement | oui (interne) |

---

*turnlock — Implicit-Free Execution — "Reliability precedes intelligence."*
