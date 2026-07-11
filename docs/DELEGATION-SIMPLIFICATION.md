# Delegation Simplification — 3→2 kinds

**Status** : Plan d'implémentation — amendement de design approuvé
**Date** : 2026-07-11
**Version cible** : v0.8.0 (breaking)

---

## 1. Problème

Turnlock expose trois `kind` de délégation : `skill`, `agent`, `agent-batch`.

- **`skill` n'a jamais été utilisé** en production. Aucun orchestrateur ni consumer ne l'exploite.
- **`skill` et `agent` sont structurellement identiques** : les deux sont `{ nom + input }`. La seule différence (`args` structuré vs `prompt` libre) est une décision de **templating** — le fait de rendre un template avant de fournir le prompt est une responsabilité de l'orchestrateur ou du consumer, pas du protocole.
- **Le mot "agent"** dans les noms (`agent`, `agent-batch`, `agentType`) présuppose un mode d'exécution (sub-agent du harness), alors que le protocole Turnlock est conçu comme **host-agnostique**. Le consumer décide si le travail est fait par un sub-agent, un appel API direct, ou autre chose.
- **L'intention originelle** de Turnlock était de permettre à une FSM de déléguer du travail **au main agent de la session courante** (d'où le vocabulaire "agent"/"skill"). Mais le seul consumer existant (`turnlock-to-llm-bridge.ts`) contourne le harness et appelle les LLMs directement. Le vocabulaire du protocole est donc en décalage avec la réalité.

## 2. Décision

On réduit à **2 kinds** qui décrivent purement la **forme de la charge utile** :

| Actuel | Nouveau | Sémantique |
|--------|---------|------------|
| `skill` | *(supprimé)* | — |
| `agent` | `prompt` | 1 job, prompt inline |
| `agent-batch` | `batch` | N jobs indépendants, prompts inline, parallélisables |

Changements de nommage associés :

| Actuel | Nouveau |
|--------|---------|
| `SkillDelegationRequest` | *(supprimé)* |
| `AgentDelegationRequest` | `PromptDelegationRequest` |
| `AgentBatchDelegationRequest` | `BatchDelegationRequest` |
| `agentType: string` | `worker?: string` |
| `delegateSkill()` | `delegate()` |
| `delegateAgent()` | `delegate()` |
| `delegateAgentBatch()` | `delegateBatch()` |

`MANIFEST_VERSION` passe de `1` à `2` — c'est un changement de contrat qu'un ancien consumer doit pouvoir détecter (principe fail-closed I-2).

## 3. Design decisions

### 3.1 Asymétrie `delegate` / `delegateBatch`

Le cas commun (1 job) garde le nom court `delegate`. Le batch est qualifié `delegateBatch`. Pattern courant dans les SDKs (`send`/`sendBatch`).

### 3.2 `worker` optionnel

Remplacé `agentType` par `worker`. Optionnel dans les deux types de requête. Désigne l'entité qui traitera le job, sans présupposer si c'est un sub-agent, un appel API, ou autre chose. Exemples : `"git-commit-generator"`, `"code-reviewer"`, `"deepseek-v4-flash"`.

### 3.3 Pas de rétrocompatibilité

Les runs existants avec `MANIFEST_VERSION: 1` ne seront plus relançables après la mise à jour. Acceptable : aucun run productif longue durée n'existe aujourd'hui.

## 4. Avant/Après — signatures publiques

```typescript
// ── AVANT ──
export type DelegationRequest =
  | SkillDelegationRequest
  | AgentDelegationRequest
  | AgentBatchDelegationRequest;

export interface SkillDelegationRequest {
  readonly kind: "skill";
  readonly skill: string;
  readonly args?: Record<string, unknown>;
  readonly label: string;
  readonly retry?: RetryPolicy;
  readonly timeout?: TimeoutPolicy;
}

export interface AgentDelegationRequest {
  readonly kind: "agent";
  readonly agentType: string;
  readonly prompt: string;
  readonly label: string;
  readonly retry?: RetryPolicy;
  readonly timeout?: TimeoutPolicy;
}

export interface AgentBatchDelegationRequest {
  readonly kind: "agent-batch";
  readonly agentType: string;
  readonly jobs: ReadonlyArray<{ readonly id: string; readonly prompt: string }>;
  readonly label: string;
  readonly retry?: RetryPolicy;
  readonly timeout?: TimeoutPolicy;
}

// ── APRÈS ──
export type DelegationRequest =
  | PromptDelegationRequest
  | BatchDelegationRequest;

export interface PromptDelegationRequest {
  readonly kind: "prompt";
  readonly worker?: string;
  readonly prompt: string;
  readonly label: string;
  readonly retry?: RetryPolicy;
  readonly timeout?: TimeoutPolicy;
}

export interface BatchDelegationRequest {
  readonly kind: "batch";
  readonly worker?: string;
  readonly jobs: ReadonlyArray<{ readonly id: string; readonly prompt: string }>;
  readonly label: string;
  readonly retry?: RetryPolicy;
  readonly timeout?: TimeoutPolicy;
}
```

```typescript
// ── AVANT — PhaseIO ──
interface PhaseIO<S> {
  delegateSkill(req: SkillDelegationRequest, resumeAt: string, nextState: S): PhaseResult<S>;
  delegateAgent(req: AgentDelegationRequest, resumeAt: string, nextState: S): PhaseResult<S>;
  delegateAgentBatch(req: AgentBatchDelegationRequest, resumeAt: string, nextState: S): PhaseResult<S>;
  consumePendingResult<T>(schema: ZodSchema<T>): T;
  consumePendingBatchResults<T>(schema: ZodSchema<T>): readonly T[];
}

// ── APRÈS ──
interface PhaseIO<S> {
  delegate(req: PromptDelegationRequest, resumeAt: string, nextState: S): PhaseResult<S>;
  delegateBatch(req: BatchDelegationRequest, resumeAt: string, nextState: S): PhaseResult<S>;
  consumePendingResult<T>(schema: ZodSchema<T>): T;
  consumePendingBatchResults<T>(schema: ZodSchema<T>): readonly T[];
}
```

```typescript
// ── AVANT — DelegationManifest ──
interface DelegationManifest {
  readonly manifestVersion: 1;
  // ...
  readonly kind: "skill" | "agent" | "agent-batch";
  readonly skill?: string;
  readonly skillArgs?: Record<string, unknown>;
  readonly agentType?: string;
  readonly prompt?: string;
  readonly jobs?: readonly DelegationManifestJob[];
  readonly resultPath?: string;
}

// ── APRÈS ──
interface DelegationManifest {
  readonly manifestVersion: 2;
  // ...
  readonly kind: "prompt" | "batch";
  readonly worker?: string;
  readonly prompt?: string;
  readonly jobs?: readonly DelegationManifestJob[];
  readonly resultPath?: string;
}
```

## 5. Fichiers impactés — 57 fichiers, 2 repos

### 5.1 Turnlock — source (17 fichiers)

| # | Fichier | Changement |
|---|---------|------------|
| 1 | `src/constants.ts` | `MANIFEST_VERSION: 1 → 2` |
| 2 | `src/types/delegation.ts` | Supprimer `SkillDelegationRequest`, `AgentDelegationRequest`. Renommer `AgentBatchDelegationRequest` → `BatchDelegationRequest`. Créer `PromptDelegationRequest`. `DelegationRequest` = union des 2. |
| 3 | `src/types/phase.ts` | `PhaseIO` : remplacer 3 méthodes par 2 (`delegate`, `delegateBatch`). Mettre à jour imports. |
| 4 | `src/types/events.ts` | `delegation_emit.kind` : `"prompt" \| "batch"` |
| 5 | `src/bindings/types.ts` | `DelegationManifest.kind` : `"prompt" \| "batch"`. `manifestVersion` : `2`. Supprimer `skill`, `skillArgs`, `agentType`. Ajouter `worker?`. |
| 6 | `src/bindings/skill.ts` | **Supprimer** |
| 7 | `src/bindings/agent.ts` | **Supprimer** → remplacer par `src/bindings/prompt.ts` (kind: `"prompt"`) |
| 8 | `src/bindings/agent-batch.ts` | Renommer en `src/bindings/batch.ts` (kind: `"batch"`, `worker`) |
| 9 | `src/bindings/index.ts` | Exporter `promptBinding`, `batchBinding`. Supprimer anciens exports. |
| 10 | `src/engine/shared.ts` | `selectBinding()` → switch sur `"prompt"`, `"batch"`. `reconstructManifest()` → `kind === "batch"`. |
| 11 | `src/engine/phase-io.ts` | Remplacer 3 méthodes par 2. Gardes : `kind === "batch"`. |
| 12 | `src/engine/dispatch-handlers.ts` | `handleDelegate()` : `kind === "batch"`, `worker`. |
| 13 | `src/engine/handle-resume.ts` | `classifyResultFiles()`, `buildExpectedResultPaths()` : `kind === "batch"`. |
| 14 | `src/engine/context.ts` | `LoadedResults.kind` : `"prompt" \| "batch"` |
| 15 | `src/services/state-io.ts` | `PendingDelegationRecord.kind` : `"prompt" \| "batch"`. Validation : `["prompt", "batch"]`. |
| 16 | `src/services/protocol.ts` | `DelegateFields.kind` : `"prompt" \| "batch"` |
| 17 | `src/index.ts` | Exports : supprimer `SkillDelegationRequest`, `AgentDelegationRequest`. Ajouter `PromptDelegationRequest`. Renommer `AgentBatchDelegationRequest` → `BatchDelegationRequest`. |

### 5.2 Turnlock — tests (8 fichiers)

| # | Fichier | Changement |
|---|---------|------------|
| 18 | `tests/bindings/skill-binding.test.ts` | **Supprimer** |
| 19 | `tests/bindings/agent-binding.test.ts` | Renommer en `prompt-binding.test.ts`. Adapter. |
| 20 | `tests/bindings/agent-batch-binding.test.ts` | Renommer en `batch-binding.test.ts`. Adapter. |
| 21 | `tests/services/protocol.test.ts` | Remplacer `"skill"`/`"agent"`/`"agent-batch"` → `"prompt"`/`"batch"`. |
| 22 | `tests/helpers/state-builder.ts` | `buildPendingSkill()` → `buildPendingPrompt()`. Kinds mis à jour. |
| 23 | `tests/engine/run-*.test.ts` (6 fichiers) | Remplacer méthodes et kinds. |
| 24 | `tests/integration/ping-pong.test.ts` | Idem. |
| 25 | `tests/observability/events-taxonomy.test.ts` | Valider `"prompt"` et `"batch"`. |

### 5.3 Turnlock — fixtures (8 fichiers)

| # | Fichier | Changement |
|---|---------|------------|
| 26 | `tests/fixtures/manifests/skill-attempt-0.json` | **Supprimer** |
| 27 | `tests/fixtures/manifests/skill-attempt-1.json` | **Supprimer** |
| 28 | `tests/fixtures/manifests/agent-attempt-0.json` | `manifestVersion: 2`, `kind: "prompt"`, `agentType` → `worker` |
| 29 | `tests/fixtures/manifests/agent-batch-3jobs.json` | `manifestVersion: 2`, `kind: "batch"`, `agentType` → `worker` |
| 30 | `tests/fixtures/manifests/agent-batch-5jobs-attempt-1.json` | Idem |
| 31 | `tests/fixtures/protocol/delegate-skill.txt` | **Supprimer** |
| 32 | `tests/fixtures/protocol/delegate-agent.txt` | `kind: prompt` |
| 33 | `tests/fixtures/protocol/delegate-batch.txt` | `kind: batch` |

### 5.4 Turnlock — specs et docs (21 fichiers)

| # | Fichier | Changement |
|---|---------|------------|
| 34 | `specs/NIB-S-TURNLOCK.md` | Remplacer toutes les occurrences (types, kinds, méthodes) |
| 35 | `specs/NIB-M-PUBLIC-API.md` | Idem |
| 36 | `specs/NIB-M-BINDINGS.md` | Idem |
| 37 | `specs/NIB-M-DISPATCH-LOOP.md` | Idem |
| 38 | `specs/NIB-M-ERROR-CLASSIFIER.md` | Idem |
| 39 | `specs/NIB-M-ERRORS.md` | Idem |
| 40 | `specs/NIB-M-HANDLE-RESUME.md` | Idem |
| 41 | `specs/NIB-M-PROTOCOL.md` | Idem |
| 42 | `specs/NIB-M-RUN-ORCHESTRATOR.md` | Idem |
| 43 | `specs/NIB-M-STATE-IO.md` | Idem |
| 44 | `specs/NIB-T-TURNLOCK.md` | Idem |
| 45 | `docs/NX-TURNLOCK.md` | Idem |
| 46 | `docs/consumers/README.md` | Idem |
| 47 | `docs/consumers/claude-code/README.md` | Idem |
| 48 | `docs/consumers/claude-code/EXECUTION-FLOW-WALKTHROUGH.md` | Idem |
| 49 | `docs/consumers/claude-code/UX-VISION-AND-GAPS.md` | Idem |
| 50 | `docs/formalizing-fsm-builder/empiric-observations-for-fsm-builder.md` | Idem |
| 51 | `docs/ADOPTION-FROM-SENIOR-REVIEW.md` | Idem |
| 52 | `docs/SEPARATION.md` | Revue (si applicable) |
| 53-54 | Autres fichiers référençant les anciens noms | Revue exhaustive |

### 5.5 Consumer git-commits-push (3 fichiers, repo `dotagents`)

| # | Fichier | Changement |
|---|---------|------------|
| 55 | `src/entrypoints/turnlock-to-llm-bridge.ts` | `manifestVersion: 2`, `kind: "batch"` |
| 56 | `src/phases/step1-discovery-validation.ts` | `io.delegateBatch(...)`, `kind: "batch"`, `agentType` → `worker` |
| 57 | `src/phases/step2-commit-push.ts` | Idem |

## 6. Ordre d'implémentation

Deux repos, séquence contrainte :

### Phase A — Amendement des specs (commit unique, repo turnlock)

1. Créer ce document (`docs/DELEGATION-SIMPLIFICATION.md`)
2. Modifier les 21 fichiers de specs/docs : remplacer mécaniquement tous les noms de types et valeurs de `kind`
3. Commit : `docs: amend delegation kinds from 3 to 2 (prompt/batch)`

### Phase B — Implémentation turnlock (commits groupés, repo turnlock)

L'ordre est dicté par les dépendances internes. Blocs atomiques :

4. **Constants + Types** : `constants.ts`, `types/delegation.ts`, `types/phase.ts`, `types/events.ts`
5. **Bindings** : supprimer `skill.ts` + `agent.ts`, créer `prompt.ts`, renommer `agent-batch.ts` → `batch.ts`, `types.ts`, `index.ts`
6. **Engine** : `shared.ts`, `phase-io.ts`, `dispatch-handlers.ts`, `handle-resume.ts`, `context.ts`
7. **Services** : `state-io.ts`, `protocol.ts`
8. **Public API** : `index.ts`

### Phase C — Tests et fixtures (commit groupé, repo turnlock)

9. Fixtures : supprimer 3, modifier 5
10. Tests : supprimer `skill-binding.test.ts`, renommer 2, adapter tous les autres
11. `bun test` — doit passer au vert

### Phase D — Publish turnlock v0.8.0

12. Bump version dans `package.json`
13. `bun publish` (ou lien local pour test)

### Phase E — Mise à jour consumer (commit séparé, repo dotagents)

14. Mettre à jour `package.json` : `"turnlock": "^0.8.0"`
15. `bun install`
16. Modifier les 3 fichiers du consumer
17. Lancer les tests du skill

## 7. Comportement fail-closed

- **Protocole** : un ancien consumer qui parse un bloc `@@TURNLOCK@@` avec `version: 2` → `parseProtocolBlock()` retourne `null` (le bloc est ignoré silencieusement). Pas d'interprétation erronée du `kind`.
- **Manifest** : un ancien consumer qui lit un manifest `manifestVersion: 2` doit explicitement le rejeter. Le runtime lui-même ne reparse pas les manifests — c'est le consumer qui les lit.
- **State** : `readState()` vérifie `schemaVersion !== 1` → erreur. Les runs existants seront rejetés. Acceptable : zéro run productif longue durée.
