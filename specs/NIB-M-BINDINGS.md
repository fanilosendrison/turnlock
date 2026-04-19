---
id: NIB-M-BINDINGS
type: nib-module
version: "1.0.0"
scope: cc-orchestrator-runtime
module: bindings
status: approved
consumers: [claude-code]
superseded_by: []
---

# NIB-M-BINDINGS — SkillBinding + AgentBinding + AgentBatchBinding

**Package** : `cc-orchestrator-runtime`
**Source NX** : §5.4 (bindings interface), §6.5 (DelegationRequest variants), §7.2 (DelegationManifest), §7.4.1 (protocole DELEGATE)
**NIB-T associé** : §12 (T-SK, P-SK), §13 (T-AG, P-AG), §14 (T-AB, P-AB)
**NIB-S référencé** : §7.2 (manifest shape), §7.6 (DelegationBinding interface), I-15 (per-attempt paths)

---

## 1. Purpose

Trois bindings qui partagent une **interface commune** `DelegationBinding<Req>`. Chaque binding encapsule deux transformations write-side :

1. `buildManifest(request, context): DelegationManifest` — construit le JSON manifest écrit à `$RUN_DIR/delegations/<label>-<attempt>.json`.
2. `buildProtocolBlock(manifest, resumeCmd): string` — construit le bloc `@@CC_ORCH@@ action: DELEGATE` à écrire sur stdout.

**Principe normatif structurant (v0.6 C9)** : le binding **ne lit pas** les fichiers résultats. Lecture exclusivement côté engine (NIB-M-HANDLE-RESUME). Les bindings sont purs write-side.

**Pourquoi 3 bindings distincts** : chaque variant de `DelegationRequest` (skill/agent/agent-batch) a une shape de manifest distincte. Le `kind` discriminé permet au dispatcher (engine) de choisir le bon binding. Code partagé minimal — chaque binding ~40-60 LOC. Mutualisation via interface + helper `buildProtocolBlock` commun (basé sur NIB-M-PROTOCOL).

**Fichiers cibles** :
- `src/bindings/types.ts` — interface `DelegationBinding`, type `DelegationContext`
- `src/bindings/skill.ts` — `SkillBinding`
- `src/bindings/agent.ts` — `AgentBinding`
- `src/bindings/agent-batch.ts` — `AgentBatchBinding`

**LOC cible** : ~200-300 total (~50-80 par binding + 30 interface).

---

## 2. Interface commune

```ts
// src/bindings/types.ts

import type {
  DelegationRequest,
  SkillDelegationRequest,
  AgentDelegationRequest,
  AgentBatchDelegationRequest,
} from "../types/delegation";  // exports publics (NIB-M-PUBLIC-API)

export interface DelegationContext {
  readonly runId: string;
  readonly orchestratorName: string;
  readonly phase: string;               // phase émettrice
  readonly resumeAt: string;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly emittedAt: string;           // ISO
  readonly emittedAtEpochMs: number;
  readonly timeoutMs: number;
  readonly deadlineAtEpochMs: number;
  readonly runDir: string;              // chemin absolu
}

export interface DelegationManifest {
  readonly manifestVersion: 1;
  readonly runId: string;
  readonly orchestratorName: string;
  readonly phase: string;
  readonly resumeAt: string;
  readonly label: string;
  readonly kind: "skill" | "agent" | "agent-batch";
  readonly emittedAt: string;
  readonly emittedAtEpochMs: number;
  readonly timeoutMs: number;
  readonly deadlineAtEpochMs: number;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly skill?: string;
  readonly skillArgs?: Record<string, unknown>;
  readonly agentType?: string;
  readonly prompt?: string;
  readonly jobs?: ReadonlyArray<{
    readonly id: string;
    readonly prompt: string;
    readonly resultPath: string;
  }>;
  readonly resultPath?: string;
}

export interface DelegationBinding<Req extends DelegationRequest> {
  readonly kind: Req["kind"];
  buildManifest(request: Req, context: DelegationContext): DelegationManifest;
  buildProtocolBlock(manifest: DelegationManifest, resumeCmd: string): string;
}

export const MANIFEST_VERSION = 1 as const;
```

---

## 3. Module A — `SkillBinding`

### 3.1 Implémentation

```ts
// src/bindings/skill.ts

import { writeProtocolBlock } from "../services/protocol";
import { InvalidConfigError } from "../errors/concrete";
import type { DelegationBinding, DelegationContext, DelegationManifest } from "./types";
import { MANIFEST_VERSION } from "./types";
import type { SkillDelegationRequest } from "../types/delegation";
import path from "node:path";

export const skillBinding: DelegationBinding<SkillDelegationRequest> = {
  kind: "skill",

  buildManifest(request: SkillDelegationRequest, context: DelegationContext): DelegationManifest {
    // Le binding n'enforce PAS l'unicité du label (§12.1 T-SK-04 note) — c'est l'engine en amont.
    const resultPath = path.join(
      context.runDir,
      "results",
      `${request.label}-${context.attempt}.json`
    );

    const manifest: DelegationManifest = {
      manifestVersion: MANIFEST_VERSION,
      runId: context.runId,
      orchestratorName: context.orchestratorName,
      phase: context.phase,
      resumeAt: context.resumeAt,
      label: request.label,
      kind: "skill",
      emittedAt: context.emittedAt,
      emittedAtEpochMs: context.emittedAtEpochMs,
      timeoutMs: context.timeoutMs,
      deadlineAtEpochMs: context.deadlineAtEpochMs,
      attempt: context.attempt,
      maxAttempts: context.maxAttempts,
      skill: request.skill,
      resultPath,
    };

    // Omettre skillArgs si absent (convention JSON §7.2 + T-SK-02).
    if (request.args !== undefined) {
      (manifest as any).skillArgs = request.args;
    }

    return manifest;
  },

  buildProtocolBlock(manifest: DelegationManifest, resumeCmd: string): string {
    if (manifest.kind !== "skill") {
      throw new InvalidConfigError(`skillBinding.buildProtocolBlock called with kind=${manifest.kind}`);
    }
    // manifestPath : construit par l'engine avant cet appel (§14.1 step 16.n).
    // Le binding reçoit juste le manifest + resumeCmd, pas le manifestPath.
    // Mais le protocole DELEGATE a besoin de manifest: <path>.
    // DÉCISION : le binding prend `manifestPath` en paramètre implicite via le manifest.
    // → Ajuster : le block writer reçoit `manifestPath` explicitement.
    throw new Error("Use buildProtocolBlockWithPath(manifest, manifestPath, resumeCmd)");
    // Voir §6 pour la clarification — la signature évolue à `(manifest, manifestPath, resumeCmd)`.
  },
};
```

**Clarification** : la signature canonique est en fait :

```ts
buildProtocolBlock(manifest: DelegationManifest, manifestPath: string, resumeCmd: string): string
```

Le manifest ne porte pas son propre path (il vit à ce path). L'engine connaît le `manifestPath` (il vient de l'écrire). Cette interface canonique est reflétée dans §2 ci-dessus — corrigée :

```ts
export interface DelegationBinding<Req extends DelegationRequest> {
  readonly kind: Req["kind"];
  buildManifest(request: Req, context: DelegationContext): DelegationManifest;
  buildProtocolBlock(manifest: DelegationManifest, manifestPath: string, resumeCmd: string): string;
}
```

### 3.2 `buildProtocolBlock` (version corrigée)

```ts
buildProtocolBlock(manifest: DelegationManifest, manifestPath: string, resumeCmd: string): string {
  return writeProtocolBlock("DELEGATE", {
    runId: manifest.runId,
    orchestrator: manifest.orchestratorName,
    manifest: manifestPath,
    kind: manifest.kind,
    resumeCmd,
  });
}
```

### 3.3 Règles normatives SkillBinding

- **`resultPath` format `<runDir>/results/<label>-<attempt>.json`** (I-15 NIB-S, T-SK-03).
- **`skillArgs` omis si `undefined`** (T-SK-02). Convention JSON : pas `"skillArgs": {}` si absent.
- **Pas de validation de format `skill`, `label`** — l'engine valide en amont.
- **Le binding ne writes PAS le manifest sur disque** — il le construit. L'engine fait le `writeFileSync` atomique (§14.1 step 16.n).

### 3.4 Tests NIB-T (§12)

| Test | Vérification |
|---|---|
| T-SK-01 | Manifest skill complet avec tous les champs |
| T-SK-02 | `args: undefined` → `skillArgs` absent du manifest |
| T-SK-03 | `attempt: 2` → `resultPath` contient `<label>-2.json` |
| T-SK-04 | `label` invalide → **pas** throw binding (engine valide) |
| T-SK-05, T-SK-06 | `buildProtocolBlock` bloc DELEGATE cohérent kind=skill |
| P-SK-a | `buildManifest` pure |
| P-SK-b | Format `resultPath` |
| P-SK-c | `manifest.kind === "skill"` toujours |

---

## 4. Module B — `AgentBinding`

### 4.1 Implémentation

```ts
// src/bindings/agent.ts

import { writeProtocolBlock } from "../services/protocol";
import type { DelegationBinding, DelegationContext, DelegationManifest } from "./types";
import { MANIFEST_VERSION } from "./types";
import type { AgentDelegationRequest } from "../types/delegation";
import path from "node:path";

export const agentBinding: DelegationBinding<AgentDelegationRequest> = {
  kind: "agent",

  buildManifest(request: AgentDelegationRequest, context: DelegationContext): DelegationManifest {
    const resultPath = path.join(
      context.runDir,
      "results",
      `${request.label}-${context.attempt}.json`
    );

    return {
      manifestVersion: MANIFEST_VERSION,
      runId: context.runId,
      orchestratorName: context.orchestratorName,
      phase: context.phase,
      resumeAt: context.resumeAt,
      label: request.label,
      kind: "agent",
      emittedAt: context.emittedAt,
      emittedAtEpochMs: context.emittedAtEpochMs,
      timeoutMs: context.timeoutMs,
      deadlineAtEpochMs: context.deadlineAtEpochMs,
      attempt: context.attempt,
      maxAttempts: context.maxAttempts,
      agentType: request.agentType,
      prompt: request.prompt,       // préservé intégralement (T-AG-02)
      resultPath,
    };
  },

  buildProtocolBlock(manifest: DelegationManifest, manifestPath: string, resumeCmd: string): string {
    return writeProtocolBlock("DELEGATE", {
      runId: manifest.runId,
      orchestrator: manifest.orchestratorName,
      manifest: manifestPath,
      kind: manifest.kind,
      resumeCmd,
    });
  },
};
```

### 4.2 Règles normatives AgentBinding

- **`prompt` préservé intégralement** (T-AG-02) — aucune troncature côté binding. Le prompt vit dans le manifest JSON et est lu par l'agent parent.
- **`resultPath` format identique à Skill** (I-15).
- **Pas de `skill`, `skillArgs`, `jobs`** dans le manifest (kind === "agent").

### 4.3 Tests NIB-T (§13)

| Test | Vérification |
|---|---|
| T-AG-01 | Manifest agent complet |
| T-AG-02 | prompt 5000 chars préservé |
| T-AG-03 | per-attempt resultPath |
| T-AG-04, T-AG-05 | buildProtocolBlock bloc agent |
| P-AG-a | pureté |
| P-AG-b | format resultPath |

---

## 5. Module C — `AgentBatchBinding`

### 5.1 Implémentation

```ts
// src/bindings/agent-batch.ts

import { writeProtocolBlock } from "../services/protocol";
import { InvalidConfigError } from "../errors/concrete";
import type { DelegationBinding, DelegationContext, DelegationManifest } from "./types";
import { MANIFEST_VERSION } from "./types";
import type { AgentBatchDelegationRequest } from "../types/delegation";
import path from "node:path";

export const agentBatchBinding: DelegationBinding<AgentBatchDelegationRequest> = {
  kind: "agent-batch",

  buildManifest(request: AgentBatchDelegationRequest, context: DelegationContext): DelegationManifest {
    // Défense en profondeur : batch vide → InvalidConfigError (T-AB-04).
    // L'engine valide aussi en amont, mais le binding défend (double ceinture).
    if (request.jobs.length === 0) {
      throw new InvalidConfigError(`agent-batch delegation '${request.label}' has no jobs`);
    }

    // Chaque job a son propre resultPath per-attempt : results/<label>-<attempt>/<jobId>.json
    const batchDir = path.join(context.runDir, "results", `${request.label}-${context.attempt}`);
    const jobs = request.jobs.map((job) => ({
      id: job.id,
      prompt: job.prompt,
      resultPath: path.join(batchDir, `${job.id}.json`),
    }));

    return {
      manifestVersion: MANIFEST_VERSION,
      runId: context.runId,
      orchestratorName: context.orchestratorName,
      phase: context.phase,
      resumeAt: context.resumeAt,
      label: request.label,
      kind: "agent-batch",
      emittedAt: context.emittedAt,
      emittedAtEpochMs: context.emittedAtEpochMs,
      timeoutMs: context.timeoutMs,
      deadlineAtEpochMs: context.deadlineAtEpochMs,
      attempt: context.attempt,
      maxAttempts: context.maxAttempts,
      agentType: request.agentType,
      jobs,                        // resultPath top-level ABSENT pour batch
    };
  },

  buildProtocolBlock(manifest: DelegationManifest, manifestPath: string, resumeCmd: string): string {
    return writeProtocolBlock("DELEGATE", {
      runId: manifest.runId,
      orchestrator: manifest.orchestratorName,
      manifest: manifestPath,
      kind: manifest.kind,
      resumeCmd,
    });
  },
};
```

### 5.2 Règles normatives AgentBatchBinding

- **Batch vide → `InvalidConfigError`** (T-AB-04) : défense en profondeur. Le binding throw même si l'engine devrait le faire aussi.
- **IDs dupliqués non checkés ici** (T-AB-03) — l'engine valide `jobs[].id` unique en amont (§14.1 step 16.n avant `buildManifest`). Le binding construit quand même. Discipline.
- **`resultPath` per-jobId dans dossier per-attempt** : `<runDir>/results/<label>-<attempt>/<jobId>.json`.
- **`resultPath` top-level absent** dans le manifest (cohérent §7.2 : batch = `jobs[].resultPath`, non-batch = `resultPath` top-level).
- **Performance** : 20 jobs → `< 100ms` pour build (T-AB-08). Pas de hashing, pas d'I/O, juste construction en mémoire.

### 5.3 Tests NIB-T (§14)

| Test | Vérification |
|---|---|
| T-AB-01 | 1 job → structure correcte |
| T-AB-02 | 3 jobs → jobs.length === 3 |
| T-AB-03 | IDs dupliqués : binding construit quand même (engine valide) |
| T-AB-04 | 0 jobs → `InvalidConfigError` |
| T-AB-05 | `attempt: 2` → `results/<label>-2/<id>.json` |
| T-AB-06 | buildProtocolBlock bloc agent-batch |
| T-AB-07 | 5 jobs end-to-end |
| T-AB-08 | 20 jobs < 100ms |
| P-AB-a | pureté |
| P-AB-b | format job resultPath |
| P-AB-c | chemins disjoints |

---

## 6. Règles transversales aux 3 bindings

- **Tous purs** — pas d'I/O, pas de clock, pas de logger. Inputs → outputs déterministes.
- **`manifestVersion: 1`** constant (pas d'autre valeur).
- **`kind`** du manifest correspond exactement au `kind` du request.
- **Champs spécifiques mutuellement exclusifs** :
  - `skill: "skill"` → `skill`, `skillArgs?`, `resultPath` ; pas de `agentType`, `prompt`, `jobs`.
  - `kind: "agent"` → `agentType`, `prompt`, `resultPath` ; pas de `skill`, `skillArgs`, `jobs`.
  - `kind: "agent-batch"` → `agentType`, `jobs[]` ; pas de `skill`, `skillArgs`, `prompt`, `resultPath` top-level.
- **Per-attempt paths** (I-15) : tous les 3 bindings produisent des paths versionnés par tentative.
- **`buildProtocolBlock` commun** : tous appellent `writeProtocolBlock("DELEGATE", {...})` avec les mêmes champs (runId, orchestrator, manifest, kind, resumeCmd). Le kind vient du manifest.

---

## 7. Constraints

- **Pas d'I/O** — les bindings n'écrivent rien sur disque. L'engine (NIB-M-DISPATCH-LOOP) appelle `buildManifest`, puis écrit le JSON atomique (state-io pattern), puis appelle `buildProtocolBlock`, puis `process.stdout.write`.
- **Pas de clock** — le context apporte déjà `emittedAt`, `emittedAtEpochMs`, `deadlineAtEpochMs`. Les bindings ne relient jamais `clock.now*`.
- **Pas de logger** — pas d'event émis par les bindings. L'engine émet `delegation_emit` après que le binding ait produit ses artifacts.
- **Utilise `path.join`** pour la construction des paths (cross-platform clean).
- **Imports figés** :
  - `node:path` (`path.join`)
  - `../services/protocol` (`writeProtocolBlock`)
  - `../errors/concrete` (`InvalidConfigError` pour batch vide)
  - `../types/delegation` (types `SkillDelegationRequest`, `AgentDelegationRequest`, `AgentBatchDelegationRequest`)
  - `./types` (interface `DelegationBinding`, `DelegationManifest`, `DelegationContext`, `MANIFEST_VERSION`)

---

## 8. Integration snippets

### 8.1 Dispatch selon `request.kind` (dispatch-loop branche delegate)

```ts
import { skillBinding, agentBinding, agentBatchBinding } from "../bindings";

function getBinding(kind: "skill" | "agent" | "agent-batch") {
  switch (kind) {
    case "skill": return skillBinding;
    case "agent": return agentBinding;
    case "agent-batch": return agentBatchBinding;
  }
}

// Dans la branche "delegate" :
const binding = getBinding(request.kind);
const manifest = (binding as any).buildManifest(request, context);

// Persister manifest.
const manifestPath = path.join(runDir, "delegations", `${request.label}-${context.attempt}.json`);
writeFileSyncAtomic(manifestPath, JSON.stringify(manifest));

// Émettre bloc.
const resumeCmd = config.resumeCommand(runId);
const block = (binding as any).buildProtocolBlock(manifest, manifestPath, resumeCmd);
process.stdout.write(block);
```

Note : le `as any` disparaîtra avec un pattern match discriminé sur `kind` ; illustratif ici.

---

## 9. Definition of Done (DoD)

1. **4 fichiers** créés :
   - `src/bindings/types.ts` — interface + types
   - `src/bindings/skill.ts`
   - `src/bindings/agent.ts`
   - `src/bindings/agent-batch.ts`
2. **Chaque binding** :
   - `kind` littéral correct (`"skill"` | `"agent"` | `"agent-batch"`)
   - `buildManifest` pure, sans I/O
   - `buildProtocolBlock` uniforme (via `writeProtocolBlock`)
   - Per-attempt `resultPath` (§7.2 format)
   - Mutually exclusive fields selon kind
3. **AgentBatchBinding** throw `InvalidConfigError` sur jobs vides.
4. **SkillBinding** omet `skillArgs` si `args: undefined`.
5. **Tests NIB-T** : §12 (T-SK + P-SK), §13 (T-AG + P-AG), §14 (T-AB + P-AB).
6. **LOC cumulée** : 200-300.
7. **Aucun I/O, clock, logger** dans les bindings.

---

## 10. Relation avec les autres NIB-M

- **Consomme** : `NIB-M-PROTOCOL` (`writeProtocolBlock`), `NIB-M-ERRORS` (`InvalidConfigError`), types de `NIB-M-PUBLIC-API` (`SkillDelegationRequest` etc.).
- **Consommé par** : `NIB-M-DISPATCH-LOOP` (dispatch selon kind, writes manifest, émet bloc).

---

## 11. Metadata

| Champ | Valeur |
|---|---|
| Source NX | §5.4, §6.5, §7.2, §7.4.1 |
| NIB-T associé | §12 (SK), §13 (AG), §14 (AB) |
| Invariants NIB-S couverts | I-15 (per-attempt paths), §7.6 (DelegationBinding interface) |
| Fichiers produits | 4 fichiers bindings |
| LOC cible | 200-300 cumulée |
| Non exporté publiquement | oui (bindings internes ; `DelegationRequest` types restent exportés via NIB-M-PUBLIC-API) |

---

*cc-orchestrator-runtime — Implicit-Free Execution — "Reliability precedes intelligence."*
