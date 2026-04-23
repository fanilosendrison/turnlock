---
id: NIB-M-LOCK
type: nib-module
version: "1.0.0"
scope: turnlock
module: lock
status: approved
consumers: [claude-code]
superseded_by: []
validates: ["src/services/lock.ts", "tests/lock/lock.test.ts"]
---

# NIB-M-LOCK — Lock file par run (acquire O_EXCL + refresh + release)

**Package** : `turnlock`
**Source NX** : §4.11 (single process per run), §4.13 (lock d'exécution intégral v0.8), §7.5 (LockFile shape), §13.2 step 4
**NIB-T associé** : §11 (T-LK-01 à T-LK-20, P-LK-a/b/c/d)
**NIB-S référencé** : §7.5 (LockFile), I-11 (single process per run enforced), I-3 (atomicité)

---

## 1. Purpose

Enforcement mécanique de "un seul process actif à la fois par `runId`" via un lock file `$RUN_DIR/.lock` créé en `O_EXCL`. Trois opérations :

- **`acquireLock`** — crée le lock en atomique, ou override si expiré, ou throw `RunLockedError` si actif.
- **`refreshLock`** — recalcule `leaseUntilEpochMs` et met à jour le lock via tmp + rename.
- **`releaseLock`** — supprime le lock si l'`ownerToken` match, sinon émet `lock_conflict` sans unlink.

**Principe normatif structurant (v0.8 M25)** : le lock représente **"un process actuellement vivant dans ce run"**, pas une réservation longue-durée. Release systématique avant tout exit (DELEGATE, DONE, ERROR, ABORTED via handler SIGINT/SIGTERM). La re-entry suivante ré-acquiert. Le lease idle 30 min couvre uniquement la crash recovery SIGKILL.

**Fichier cible** : `src/services/lock.ts`

**LOC cible** : ~200-250.

---

## 2. Signatures + Constantes

```ts
import type { OrchestratorLogger } from "../types/events";
import type { Clock } from "./clock";
import { RunLockedError } from "../errors/concrete";

export const DEFAULT_IDLE_LEASE_MS = 30 * 60 * 1000;  // 30 min

export interface LockFile {
  readonly ownerPid: number;
  readonly ownerToken: string;         // ULID
  readonly acquiredAtEpochMs: number;
  readonly leaseUntilEpochMs: number;
}

export interface LockHandle {
  readonly ownerToken: string;
  readonly lockPath: string;
}

/**
 * Tentative d'acquire atomique via O_EXCL.
 * - Fichier inexistant : crée LockFile + retourne handle.
 * - Fichier existant + actif (nowEpoch < leaseUntilEpochMs) : throw RunLockedError.
 * - Fichier existant + expiré : override (écrit nouveau lock) + émet lock_conflict "expired_override".
 *
 * Throw RunLockedError porte ownerPid, acquiredAtEpochMs, leaseUntilEpochMs depuis le lock existant.
 */
export function acquireLock(
  lockPath: string,
  clock: Clock,
  logger: OrchestratorLogger,
  runId: string,  // pour enrichir RunLockedError.runId
): LockHandle;

/**
 * Met à jour leaseUntilEpochMs (nowEpoch + DEFAULT_IDLE_LEASE_MS).
 * Vérifie ownerToken match avant d'écrire.
 * Si mismatch : émet lock_conflict "stolen_at_release" et skip write (no-op).
 * Update via tmp + rename (atomique).
 */
export function refreshLock(
  lockPath: string,
  handle: LockHandle,
  clock: Clock,
  logger: OrchestratorLogger,
  runId: string,
): void;

/**
 * Release : unlink le lock si ownerToken match.
 * Si mismatch : émet lock_conflict "stolen_at_release", skip unlink.
 * Si fichier déjà absent (ENOENT) : no-op silencieux.
 */
export function releaseLock(
  lockPath: string,
  handle: LockHandle,
  clock: Clock,
  logger: OrchestratorLogger,
  runId: string,
): void;
```

---

## 3. Algorithme — `acquireLock`

```ts
export function acquireLock(
  lockPath: string,
  clock: Clock,
  logger: OrchestratorLogger,
  runId: string,
): LockHandle {
  const nowEpoch = clock.nowEpochMs();
  const ownerToken = generateRunId();  // ulid(), distinct du runId
  const ownerPid = process.pid;
  const leaseUntilEpochMs = nowEpoch + DEFAULT_IDLE_LEASE_MS;
  const lockFile: LockFile = {
    ownerPid,
    ownerToken,
    acquiredAtEpochMs: nowEpoch,
    leaseUntilEpochMs,
  };

  // 1. Tentative O_EXCL.
  let fd: number | undefined;
  try {
    fd = fs.openSync(lockPath, "wx");  // "wx" = O_EXCL | O_CREAT | O_WRONLY
    fs.writeSync(fd, JSON.stringify(lockFile));
    fs.closeSync(fd);
    return { ownerToken, lockPath };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
      if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
      throw err;  // Erreur non-EEXIST : propage (FS saturé, perm, etc.)
    }
    // EEXIST — fichier existe déjà, check expiration.
  }

  // 2. Lock existant — lire et check expiration.
  let existing: LockFile;
  try {
    existing = JSON.parse(fs.readFileSync(lockPath, "utf-8")) as LockFile;
  } catch {
    // Lock corrompu — traiter comme orphelin et override défensivement.
    // Log lock_conflict "expired_override" avec currentOwnerToken: undefined.
    logger.emit({
      eventType: "lock_conflict",
      runId,
      reason: "expired_override",
      currentOwnerToken: undefined,
      timestamp: clock.nowWallIso(),
    });
    overrideLock(lockPath, lockFile);
    return { ownerToken, lockPath };
  }

  // 3. Actif (lease encore valide) → RunLockedError.
  if (nowEpoch < existing.leaseUntilEpochMs) {
    throw new RunLockedError(
      `Run is locked by PID ${existing.ownerPid}, lease expires at ${new Date(existing.leaseUntilEpochMs).toISOString()}`,
      {
        ownerPid: existing.ownerPid,
        acquiredAtEpochMs: existing.acquiredAtEpochMs,
        leaseUntilEpochMs: existing.leaseUntilEpochMs,
        runId,
      }
    );
  }

  // 4. Expiré → override via tmp + rename (atomique).
  logger.emit({
    eventType: "lock_conflict",
    runId,
    reason: "expired_override",
    currentOwnerToken: existing.ownerToken,
    timestamp: clock.nowWallIso(),
  });
  overrideLock(lockPath, lockFile);
  return { ownerToken, lockPath };
}

function overrideLock(lockPath: string, lockFile: LockFile): void {
  const tmpPath = lockPath + ".tmp";
  fs.writeFileSync(tmpPath, JSON.stringify(lockFile), { encoding: "utf-8" });
  fs.renameSync(tmpPath, lockPath);
}
```

**Règles normatives** :

- **Atomique via `O_EXCL`** : flag `"wx"` échoue si le fichier existe. C'est la primitive POSIX qui garantit qu'un seul des deux processes concurrents réussit (T-LK-05).
- **Edge lease (nowEpoch === leaseUntilEpochMs)** : considéré **actif** (strict `<`). Lease inclusif côté droite. Testé T-LK-04.
- **`ownerToken` distinct de `runId`** : le runId identifie le **run**, l'ownerToken identifie le **process owner du lock**. Un override expired génère un **nouveau** ownerToken distinct de l'ancien.
- **Lock corrompu traité comme orphelin** : cas défensif (corruption fichier, crash pendant écriture atomique initiale). Override avec event `lock_conflict "expired_override"` et `currentOwnerToken: undefined`.
- **Override via tmp+rename** : atomique (I-3). Le lock existant est remplacé en une opération.

---

## 4. Algorithme — `refreshLock`

```ts
export function refreshLock(
  lockPath: string,
  handle: LockHandle,
  clock: Clock,
  logger: OrchestratorLogger,
  runId: string,
): void {
  let existing: LockFile;
  try {
    existing = JSON.parse(fs.readFileSync(lockPath, "utf-8")) as LockFile;
  } catch (err) {
    // Fichier absent ou corrompu : impossible de refresh. Pas d'event spécifique (situation anormale, mais non bloquante).
    // Silent fail — le caller ne peut pas faire mieux.
    return;
  }

  // Vérifier ownerToken match.
  if (existing.ownerToken !== handle.ownerToken) {
    logger.emit({
      eventType: "lock_conflict",
      runId,
      reason: "stolen_at_release",  // même reason que release (§4.13 M25 : uniformité)
      currentOwnerToken: existing.ownerToken,
      timestamp: clock.nowWallIso(),
    });
    return;  // no-op skip write
  }

  // Update atomique : nouveau leaseUntilEpochMs, autres champs inchangés.
  const updated: LockFile = {
    ...existing,
    leaseUntilEpochMs: clock.nowEpochMs() + DEFAULT_IDLE_LEASE_MS,
  };
  const tmpPath = lockPath + ".tmp";
  fs.writeFileSync(tmpPath, JSON.stringify(updated), { encoding: "utf-8" });
  fs.renameSync(tmpPath, lockPath);
}
```

**Règles normatives** :

- **Check ownerToken avant write** : protège contre un refresh qui écraserait un lock volé par un autre process.
- **`reason: "stolen_at_release"` pour mismatch** (uniformité §4.13, T-LK-07 NIB-T tranche sur cette convention).
- **Update atomique via tmp+rename** : mêmes garanties que l'override d'acquire.
- **Silent fail si lecture échoue** : le fichier peut avoir été supprimé entre-temps (SIGKILL d'un process, release d'un autre). Pas de crash — le caller est déjà dans un flow valide, le refresh est best-effort.
- **No-op sans effet cumulatif** : 10 refresh rapides donnent `leaseUntilEpochMs = dernier_now + lease`, pas un cumul. Testé T-LK-20.

---

## 5. Algorithme — `releaseLock`

```ts
export function releaseLock(
  lockPath: string,
  handle: LockHandle,
  clock: Clock,
  logger: OrchestratorLogger,
  runId: string,
): void {
  let existing: LockFile;
  try {
    existing = JSON.parse(fs.readFileSync(lockPath, "utf-8")) as LockFile;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return;  // Fichier déjà supprimé (T-LK-11) — no-op silencieux.
    }
    return;  // Autre erreur de lecture : silent fail (best-effort release).
  }

  if (existing.ownerToken !== handle.ownerToken) {
    logger.emit({
      eventType: "lock_conflict",
      runId,
      reason: "stolen_at_release",
      currentOwnerToken: existing.ownerToken,
      timestamp: clock.nowWallIso(),
    });
    return;  // Skip unlink (T-LK-10).
  }

  try {
    fs.unlinkSync(lockPath);
  } catch {
    // Silent fail — le fichier peut avoir été supprimé entre read et unlink.
  }
}
```

**Règles normatives** :

- **Release conditionné au ownerToken match** — un process qui a été "volé" (lease expiré + autre process a acquired) ne supprime pas le lock du nouveau owner. Safety critical : éviter les doubles acquires concurrents (P-LK-c).
- **ENOENT silencieux** (T-LK-11) — cas normal si un autre process a déjà release ou si le fichier n'a jamais existé (défensif).
- **Aucun event pour release successful** (§4.13 : opérations normales n'émettent pas d'event).

---

## 6. Règles transversales

### 6.1 Events émis

| Opération | Résultat | Event |
|---|---|---|
| `acquireLock` success (pas d'override) | pas d'event |
| `acquireLock` avec override expiré | `lock_conflict` reason=`"expired_override"`, `currentOwnerToken`=ancien token (ou undefined si corrompu) |
| `acquireLock` avec lock actif | throw `RunLockedError` (pas d'event émis ici — c'est l'engine qui émet `phase_error` / `orchestrator_end` dans le flow préflight) |
| `refreshLock` success | pas d'event |
| `refreshLock` token mismatch | `lock_conflict` reason=`"stolen_at_release"`, `currentOwnerToken`=autre token |
| `releaseLock` success | pas d'event |
| `releaseLock` token mismatch | `lock_conflict` reason=`"stolen_at_release"`, `currentOwnerToken`=autre token |
| `releaseLock` ENOENT | pas d'event (no-op silencieux) |

### 6.2 Discipline cwd × runId scope

Le lock est scopé par `lockPath` qui contient `cwd × runId` (via `resolveRunDir`). Deux runs sur `runId` différents n'interfèrent pas. Deux runs dans des `cwd` différents n'interfèrent pas (RUN_DIRs disjoints).

### 6.3 SIGKILL crash recovery

Un SIGKILL laisse le lock orphelin sur disque. `leaseUntilEpochMs` expire après 30 min. La re-entry suivante override via `expired_override` (T-LK-17). Pas de reprise de state transparente (§17 NX — limitation v1 assumée), mais le lock n'est pas un blocage permanent.

### 6.4 Scope de la protection

Le lock protège contre :
- ✅ Deux `runOrchestrator` concurrents sur le même `runId` (re-entry parasite, bug parent agent)
- ✅ Crashes orphelins (lease expire, un successor peut reprendre)

Le lock NE protège PAS contre :
- ❌ Corruption de `state.json` par un tiers (scope différent)
- ❌ Deux `runOrchestrator` sur `runId` différents (scope différent, et c'est voulu — runs parallèles OK)
- ❌ Tout processus hors-runtime qui touche au fichier de lock

---

## 7. Tests NIB-T (rappel §11)

| Groupe | Tests |
|---|---|
| Acquire | T-LK-01 à T-LK-05 (premier acquire, lock actif, expiré, edge, concurrence) |
| Refresh | T-LK-06 à T-LK-08 (owned, stolen, rapide succession) |
| Release | T-LK-09 à T-LK-11 (owned, stolen, ENOENT) |
| Events | T-LK-12 à T-LK-16 (émission discipline) |
| SIGKILL recovery | T-LK-17, T-LK-18 |
| `io.refreshLock()` phase | T-LK-19, T-LK-20 |
| Propriétés | P-LK-a (acquire+release → FS propre), P-LK-b (refresh-not-owned = no-op), P-LK-c (mutex 10 acquires concurrents → 1 success), P-LK-d (acquire → N refresh → release → clean) |

---

## 8. Constraints

- **Fs sync** : cohérence avec le reste du runtime (state-io, logger). Acceptable car appels rares (acquire/release une fois, refresh par phase-start ≤ 30/run).
- **Imports figés** :
  - `node:fs` (`fs.openSync`, `fs.writeSync`, `fs.closeSync`, `fs.readFileSync`, `fs.writeFileSync`, `fs.renameSync`, `fs.unlinkSync`)
  - `node:process` (`process.pid`)
  - `./run-id` (`generateRunId` pour `ownerToken`)
  - `./clock` (type `Clock`)
  - `../errors/concrete` (`RunLockedError`)
  - `../types/events` (type `OrchestratorLogger`)
- **Constante `DEFAULT_IDLE_LEASE_MS = 30 * 60 * 1000`** exportée et utilisée (pas hardcodée dans le code métier).
- **Pas de cleanup automatique des `.lock.tmp` résiduels** : le prochain override/refresh/release écrase. Cohérent avec la stratégie state-io.
- **Pas de retry sur EEXIST** : un `acquireLock` fail immédiatement sur lock actif. Le caller (runOrchestrator préflight) gère en émettant `RunLockedError` via le protocole.

---

## 9. Integration snippets

### 9.1 Consommation par `runOrchestrator` préflight (§14.1 step 7)

```ts
import { acquireLock } from "../services/lock";

const lockPath = path.join(runDir, ".lock");
let handle: LockHandle;
try {
  handle = acquireLock(lockPath, clock, logger, runId);
} catch (err) {
  if (err instanceof RunLockedError) {
    logger.emit({ eventType: "phase_error", runId, phase: "preflight", errorKind: "run_locked",
                  message: err.message.slice(0, 200), timestamp: clock.nowWallIso() });
    // Note : orchestrator_end NON émis en préflight (C12 NX : pas de run).
    const block = writeProtocolBlock("ERROR", { runId, orchestrator: config.name, errorKind: "run_locked",
                                                  message: err.message.slice(0, 200), phase: null, phasesExecuted: 0 });
    process.stdout.write(block);
    process.exit(2);  // Exit code spécifique pour RunLockedError (§14.1 step 7 NX).
  }
  throw err;
}
// handle en main. Activer events.ndjson logger.
logger.enableDiskEmit(path.join(runDir, "events.ndjson"));
```

### 9.2 Refresh à chaque phase-start (§14.1 step 16.b)

```ts
import { refreshLock } from "../services/lock";
refreshLock(lockPath, handle, clock, logger, runId);
```

### 9.3 Release avant tout exit (branches delegate/done/fail + handlers SIGINT/SIGTERM)

```ts
import { releaseLock } from "../services/lock";
releaseLock(lockPath, handle, clock, logger, runId);
process.exit(0);
```

### 9.4 `io.refreshLock()` exposé côté phase user

```ts
// Dans la construction du PhaseIO (NIB-M-DISPATCH-LOOP step 16.f)
const io: PhaseIO = {
  // ... autres méthodes
  refreshLock: () => refreshLock(lockPath, handle, clock, logger, runId),
};
```

---

## 10. Definition of Done (DoD)

1. **1 fichier** créé : `src/services/lock.ts` avec `acquireLock`, `refreshLock`, `releaseLock`, `DEFAULT_IDLE_LEASE_MS`, `LockFile`, `LockHandle`.
2. **`acquireLock`** :
   - Atomique via `fs.openSync("wx")`.
   - Throw `RunLockedError` avec ownerPid/acquiredAtEpochMs/leaseUntilEpochMs si lease actif.
   - Override avec event `lock_conflict "expired_override"` si lease expiré.
   - Génère `ownerToken` distinct via `generateRunId`.
3. **`refreshLock`** :
   - Check ownerToken avant write — mismatch → event + no-op.
   - Update atomique tmp+rename.
   - `leaseUntilEpochMs = nowEpoch + DEFAULT_IDLE_LEASE_MS`.
   - Silent fail si fichier absent/corrompu.
4. **`releaseLock`** :
   - Check ownerToken — mismatch → event + skip unlink.
   - ENOENT silencieux.
   - Unlink via `fs.unlinkSync`.
5. **Events** conformes au mapping §6.1 (aucune émission sur opérations normales).
6. **Tests NIB-T** : T-LK-01 à T-LK-20, P-LK-a/b/c/d.
7. **LOC** : 200-250.
8. **Constante `DEFAULT_IDLE_LEASE_MS`** exportée.

---

## 11. Relation avec les autres NIB-M

- **Consomme** :
  - `NIB-M-INFRA-UTILS` (`generateRunId` pour ownerToken, type `Clock`)
  - `NIB-M-ERRORS` (`RunLockedError` + propriétés publiques)
  - `NIB-M-LOGGER` (type `OrchestratorLogger`)
- **Consommé par** :
  - `NIB-M-RUN-ORCHESTRATOR` (acquire au préflight, release au téardown)
  - `NIB-M-DISPATCH-LOOP` (refresh phase-start, release avant exit, `io.refreshLock()`)
  - `NIB-M-HANDLE-RESUME` (acquire au préflight resume)
  - Handler SIGINT/SIGTERM dans `NIB-M-RUN-ORCHESTRATOR` (release avant exit 130/143)

---

## 12. Metadata

| Champ | Valeur |
|---|---|
| Source NX | §4.11, §4.13 (intégral), §7.5 (LockFile), §13.2 |
| NIB-T associé | §11 (T-LK, P-LK) |
| Invariants NIB-S couverts | I-3, I-11 (single process per run mécaniquement) |
| Fichier produit | `src/services/lock.ts` |
| LOC cible | 200-250 |
| Non exporté publiquement | oui (interne) |

---

*turnlock — Implicit-Free Execution — "Reliability precedes intelligence."*
