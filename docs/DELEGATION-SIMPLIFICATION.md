# Delegation Simplification — 3→2 kinds

**Status** : Implémenté côté runtime turnlock — amendement de design appliqué
**Date** : 2026-07-11
**Version cible** : v0.8.0 (breaking)
**Implémentation** : source, tests, fixtures et NIBs turnlock alignés le 2026-07-11. La publication npm et la mise à jour de consumers externes restent des étapes de release séparées.

**Version contract** :
- `PROTOCOL_VERSION: 1 → 2` — le champ `kind` dans le bloc `@@TURNLOCK@@` change de valeurs (nouvelle taxonomie)
- `MANIFEST_VERSION: 1 → 2` — le champ `kind` dans le manifest JSON change de valeurs ; `skill`, `skillArgs`, `agentType` supprimés
- `STATE_SCHEMA_VERSION: 1 → 2` — `pendingDelegation.kind` change de valeurs ; les runs v1 sont rejetés par `readState()` (I-2 fail-closed)

**Décision antérieure annulée** : ce plan invalide [L2-6 de docs/SEPARATION.md](docs/SEPARATION.md#l2-6--vocabulaire-des-bindings-skill--agent--agent-batch----close-2026-04-23-par-décision-option-a) (CLOS 2026-04-23). Le frame a changé : le vocabulaire "agent-host primitives" était pertinent quand turnlock ciblait exclusivement le main agent de la session. Aujourd'hui le seul consumer existant contourne le harness (appels API directs), et le protocole n'a pas à présupposer le mode d'exécution. `docs/SEPARATION.md` sera mis à jour pour remplacer L2-6 par une nouvelle décision référençant ce document.

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

Les trois versions de contrat passent à `2`. Le changement est visible dans le protocole stdout, les manifests JSON, et le snapshot `state.json` ; un ancien consumer ou un ancien run doit donc être rejeté explicitement (principe fail-closed I-2).

## 3. Design decisions

### 3.1 Asymétrie `delegate` / `delegateBatch`

Le cas commun (1 job) garde le nom court `delegate`. Le batch est qualifié `delegateBatch`. Pattern courant dans les SDKs (`send`/`sendBatch`).

### 3.2 `worker` optionnel

Remplacé `agentType` par `worker`. Optionnel dans les deux types de requête.

**Sémantique par défaut** : quand `worker` est absent, le consumer utilise son propre worker par défaut. Chaque consumer définit ce que "défaut" signifie dans son contexte :
- Un consumer harness (Claude Code) → le main agent de la session
- Un consumer standalone (bridge) → le modèle LLM configuré dans le consumer
- Un consumer custom → sa propre convention de routage

Le protocole ne spécifie pas le défaut — c'est une décision du consumer. Exemples de workers nommés : `"git-commit-generator"`, `"code-reviewer"`, `"deepseek-v4-flash"`.

### 3.3 Pas de rétrocompatibilité

Les runs existants avec `schemaVersion: 1` ne seront plus relançables après la mise à jour. Acceptable : aucun run productif longue durée n'existe aujourd'hui.

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

## 5. Fichiers impactés

### 5.1 Turnlock — source (18 fichiers)

| # | Fichier | Changement |
|---|---------|------------|
| 1 | `src/constants.ts` | `PROTOCOL_VERSION: 1 → 2`, `MANIFEST_VERSION: 1 → 2`, `STATE_SCHEMA_VERSION: 1 → 2` |
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
| 12 | `src/engine/delegate-handler.ts` | `handleDelegate()` : `kind === "batch"`, `worker`. |
| 13 | `src/engine/handle-resume.ts` | `classifyResultFiles()`, `buildExpectedResultPaths()` : `kind === "batch"`. Retry : quand l'ancien manifest est relu pour reconstruire une tentative, valider `manifestVersion === 2` avant `reconstructManifest()`. |
| 14 | `src/engine/context.ts` | `LoadedResults.kind` : `"prompt" \| "batch"` |
| 15 | `src/engine/run-orchestrator.ts` | Remplacer les écritures `schemaVersion: 1` par `STATE_SCHEMA_VERSION` (`2`) lors de la création du state initial. Le rejet `schemaVersion !== 2` reste centralisé dans `readState()`. |
| 16 | `src/services/state-io.ts` | `PendingDelegationRecord.kind` : `"prompt" \| "batch"`. `readState()` : `schemaVersion !== 2` → erreur. Validation kind : `["prompt", "batch"]`. |
| 17 | `src/services/protocol.ts` | `DelegateFields.kind` : `"prompt" \| "batch"`. `parseProtocolBlock()` rejette `version !== 2`. |
| 18 | `src/index.ts` | Exports : supprimer `SkillDelegationRequest`, `AgentDelegationRequest`. Ajouter `PromptDelegationRequest`. Renommer `AgentBatchDelegationRequest` → `BatchDelegationRequest`. |

### 5.2 Turnlock — tests (14 fichiers)

| # | Fichier | Changement |
|---|---------|------------|
| 19 | `tests/bindings/skill-binding.test.ts` | **Supprimer** |
| 20 | `tests/bindings/agent-binding.test.ts` | Renommer en `prompt-binding.test.ts`. Adapter. |
| 21 | `tests/bindings/agent-batch-binding.test.ts` | Renommer en `batch-binding.test.ts`. Adapter. |
| 22 | `tests/services/protocol.test.ts` | Remplacer `"skill"`/`"agent"`/`"agent-batch"` → `"prompt"`/`"batch"`. Mettre à jour `version` dans les blocs. |
| 23 | `tests/services/state-io.test.ts` | `schemaVersion: 2` devient valide ; `schemaVersion: 1` devient le cas `StateVersionMismatchError`. |
| 24 | `tests/contracts/surface.test.ts` | Constantes attendues : `PROTOCOL_VERSION === 2`, `STATE_SCHEMA_VERSION === 2`; surface publique mise à jour avec les nouveaux types exportés. |
| 25 | `tests/helpers/state-builder.ts` | `buildPendingSkill()` → `buildPendingPrompt()`. Kinds mis à jour. `schemaVersion: 2`. |
| 26 | `tests/engine/run-initial-happy-path.test.ts` | Remplacer `delegateSkill` → `delegate`, kinds mis à jour (7 occurrences). |
| 27 | `tests/engine/run-resume-happy-path.test.ts` | Idem. |
| 28 | `tests/engine/run-composition.test.ts` | Compilation : types `PhaseIO`, `DelegationRequest` mis à jour. |
| 29 | `tests/engine/run-retry.test.ts` | Compilation : idem. Ajouter un cas fail-closed si le manifest relu pour retry est `manifestVersion: 1`. |
| 30 | `tests/engine/run-signals.test.ts` | Compilation : idem. |
| 31 | `tests/integration/ping-pong.test.ts` | Remplacer méthodes et kinds. |
| 32 | `tests/observability/events-taxonomy.test.ts` | Valider `"prompt"` et `"batch"`. |

### 5.3 Turnlock — fixtures et snapshots

| # | Fichier | Changement |
|---|---------|------------|
| 33 | `tests/fixtures/manifests/skill-attempt-0.json` | **Supprimer** |
| 34 | `tests/fixtures/manifests/skill-attempt-1.json` | **Supprimer** |
| 35 | `tests/fixtures/manifests/agent-attempt-0.json` | `manifestVersion: 2`, `kind: "prompt"`, `agentType` → `worker` |
| 36 | `tests/fixtures/manifests/agent-batch-3jobs.json` | `manifestVersion: 2`, `kind: "batch"`, `agentType` → `worker` |
| 37 | `tests/fixtures/manifests/agent-batch-5jobs-attempt-1.json` | Idem |
| 38 | `tests/fixtures/protocol/delegate-skill.txt` | **Supprimer** |
| 39 | `tests/fixtures/protocol/delegate-agent.txt` | `version: 2`, `kind: prompt` |
| 40 | `tests/fixtures/protocol/delegate-batch.txt` | `version: 2`, `kind: batch` |
| 41 | `tests/fixtures/protocol/done-minimal.txt` | `version: 2` |
| 42 | `tests/fixtures/protocol/error-*.txt` (2 fichiers) | `version: 2` |
| 43 | `tests/fixtures/protocol/aborted-sigint.txt` | `version: 2` |
| 44 | `tests/fixtures/states/mid-run-skill-pending.json` | **Supprimer** |
| 45 | `tests/fixtures/states/mid-run-agent-pending.json` | `schemaVersion: 2`, `kind: "prompt"` |
| 46 | `tests/fixtures/states/mid-run-batch-pending.json` | `schemaVersion: 2`, `kind: "batch"` |
| 47 | `tests/fixtures/states/mid-run-retry-attempt-1.json` | `schemaVersion: 2`, `kind: "prompt"` |
| 48 | `tests/fixtures/states/mid-run-no-pending.json` | `schemaVersion: 2` |
| 49 | `tests/fixtures/states/initial-empty.json` | `schemaVersion: 2` |
| 50 | `tests/fixtures/states/corrupted-schema.json` | Inchangé (teste le rejet → ajuster le test si besoin) |
| 51 | `tests/fixtures/states/version-mismatch.json` | `schemaVersion: 1` (teste le rejet v1 → devient un test de rejet valide) |
| 52 | `tests/fixtures/events/*.ndjson` (3 fichiers) | Remplacer les occurrences de `"kind":"skill"`/`"agent"`/`"agent-batch"` → `"prompt"`/`"batch"` |

### 5.4 Turnlock — specs et docs (22 fichiers)

| # | Fichier | Changement |
|---|---------|------------|
| 51 | `docs/SEPARATION.md` | Remplacer L2-6 par une nouvelle entrée référençant ce document |
| 52 | `docs/DELEGATION-SIMPLIFICATION.md` | Ce document (déjà créé, à maintenir comme référence) |
| 53 | `specs/NIB-S-TURNLOCK.md` | Remplacer toutes les occurrences (types, kinds, méthodes) |
| 54 | `specs/NIB-M-PUBLIC-API.md` | Idem |
| 55 | `specs/NIB-M-BINDINGS.md` | Idem |
| 56 | `specs/NIB-M-DISPATCH-LOOP.md` | Idem |
| 57 | `specs/NIB-M-ERROR-CLASSIFIER.md` | Idem |
| 58 | `specs/NIB-M-ERRORS.md` | Idem |
| 59 | `specs/NIB-M-HANDLE-RESUME.md` | Idem |
| 60 | `specs/NIB-M-PROTOCOL.md` | Idem |
| 61 | `specs/NIB-M-RUN-ORCHESTRATOR.md` | Idem |
| 62 | `specs/NIB-M-STATE-IO.md` | Idem |
| 63 | `specs/NIB-T-TURNLOCK.md` | Idem |
| 64 | `docs/NX-TURNLOCK.md` | Idem |
| 65 | `docs/consumers/README.md` | Idem |
| 66 | `docs/consumers/claude-code/README.md` | Idem |
| 67 | `docs/consumers/claude-code/EXECUTION-FLOW-WALKTHROUGH.md` | Idem |
| 68 | `docs/consumers/claude-code/UX-VISION-AND-GAPS.md` | Idem |
| 69 | `docs/formalizing-fsm-builder/empiric-observations-for-fsm-builder.md` | Idem |
| 70 | `docs/ADOPTION-FROM-SENIOR-REVIEW.md` | Idem |

### 5.5 Consumer git-commits-push (3 fichiers, repo `dotagents`)

| # | Fichier | Changement |
|---|---------|------------|
| 71 | `src/entrypoints/turnlock-to-llm-bridge.ts` | `manifestVersion: 2`, `kind: "batch"` |
| 72 | `src/phases/step1-discovery-validation.ts` | `io.delegateBatch(...)`, `kind: "batch"`, `agentType` → `worker` |
| 73 | `src/phases/step2-commit-push.ts` | Idem |

> **Note** : les fichiers de test qui importent les types `PhaseIO`, `DelegationRequest`, etc. sans référencer directement les anciens noms cassent à la compilation si les types publics changent. La liste ci-dessus couvre les tests avec occurrences explicites ; une passe `tsc --noEmit` après implémentation détectera les cassures résiduelles.

## 6. Ordre d'implémentation

Deux repos, séquence contrainte :

### Phase A — Amendement des specs (commit unique, repo turnlock)

1. Créer ce document (`docs/DELEGATION-SIMPLIFICATION.md`)
2. Mettre à jour `docs/SEPARATION.md` : remplacer L2-6 par une référence à ce document (annulation de la décision CLOS 2026-04-23)
3. Modifier les fichiers de specs/docs listés en §5.4 : remplacer tous les noms de types, valeurs de `kind`, constantes de version et exemples de protocole/state/manifest
4. Commit : `docs: amend delegation kinds from 3 to 2 (prompt/batch) — supersedes SEPARATION L2-6`

### Phase B — Implémentation turnlock (commits groupés, repo turnlock)

L'ordre est dicté par les dépendances internes. Blocs atomiques :

4. **Constants** : `PROTOCOL_VERSION: 2`, `MANIFEST_VERSION: 2`, `STATE_SCHEMA_VERSION: 2`
5. **Types** : `types/delegation.ts`, `types/phase.ts`, `types/events.ts`
6. **Bindings** : supprimer `skill.ts` + `agent.ts`, créer `prompt.ts`, renommer `agent-batch.ts` → `batch.ts`, `types.ts`, `index.ts`
7. **Engine** : `shared.ts`, `phase-io.ts`, `delegate-handler.ts`, `delegation-reemit.ts`, `terminal-handlers.ts`, `handle-resume.ts`, `context.ts`, `run-orchestrator.ts`
8. **Services** : `state-io.ts` (validation `schemaVersion !== 2`), `protocol.ts` (validation `version !== 2`)
9. **Public API** : `index.ts`

### Phase C — Tests et fixtures (commit groupé, repo turnlock)

9. Fixtures/snapshots : appliquer tous les changements listés en §5.3 (manifests, protocoles, states, events)
10. Tests : appliquer tous les changements listés en §5.2 (bindings, protocol, state-io, surface, engine, integration, observability)
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

- **Protocole** : `PROTOCOL_VERSION` passe à 2. `parseProtocolBlock()` rejette `version !== 2`. Un ancien consumer qui lit un bloc v2 → parse échoue → `null`. Pas d'interprétation erronée du `kind`. Un nouveau consumer qui lit un bloc v1 → parse échoue aussi (le code vérifie `parsed.version !== PROTOCOL_VERSION`).
- **Manifest** : `MANIFEST_VERSION` passe à 2. Les consumers doivent vérifier `manifestVersion === 2`. Le runtime relit aussi l'ancien manifest lors d'un retry pour reconstruire une nouvelle tentative ; cette lecture doit valider `manifestVersion === 2` et rejeter un manifest v1 au lieu de le reconstruire silencieusement.
- **State** : `STATE_SCHEMA_VERSION` passe à 2. `readState()` vérifie `schemaVersion !== 2` → `StateVersionMismatchError`. Les runs v1 (avec `pendingDelegation.kind: "skill"` ou `"agent"`) sont rejetés proprement dès la phase de resume.
