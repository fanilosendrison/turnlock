---
id: TURNLOCK-MIXED-PARALLEL-DELEGATIONS
version: "1.0.0"
scope: turnlock
status: draft
extends: TURNLOCK-RUNNERS@1.5.0
---

# Turnlock — Délégations parallèles hétérogènes et fork/join mixte

**Date** : 2026-07-20  
**Statut** : draft — architecture cible pour batchs hétérogènes, sub-agents parallèles et participation concurrente du main agent  
**Référence principale** : `TURNLOCK-RUNNERS` v1.5.0

---

## 1. Objet

Ce document définit l’extension de Turnlock nécessaire pour supporter :

- plusieurs sub-agents exécutés en parallèle ;
- un modèle différent par job ;
- un niveau de reasoning / effort différent par job ;
- des outils ou profils d’outils différents par job ;
- un worker ou rôle différent par job ;
- la participation du main agent dans le même groupe parallèle ;
- une barrière de synchronisation explicite (`join`);
- la collecte, validation et livraison contrôlée des résultats ;
- une reprise déterministe après crash ;
- des capacités différentes selon le runner ou le harness.

L’objectif n’est pas de transformer Turnlock core en SDK Claude, Pi, Codex ou autre.

L’objectif est de conserver :

```text
Turnlock core
    = control plane déclaratif et durable

Runner / bridge spécifique au harness
    = execution plane concret

Main agent
    = participant sémantique, pas scheduler
```

---

## 2. Décision architecturale principale

### 2.1 Le main agent ne doit pas être le scheduler par défaut

Lorsqu’un manifest contient plusieurs jobs destinés à des sub-agents, le main agent ne doit pas recevoir une instruction textuelle du type :

```text
Lance ces trois sub-agents en parallèle, attends leur terminaison,
vérifie leurs fichiers, puis reprends Turnlock.
```

Cette approche réintroduit un LLM dans le control plane.

Le main agent pourrait :

- lancer les jobs séquentiellement ;
- oublier un job ;
- utiliser le mauvais worker ;
- modifier un prompt ;
- ignorer une option de modèle ou d’effort ;
- donner trop d’outils ;
- reprendre Turnlock avant la fin ;
- échouer à écrire un résultat ;
- réagir différemment selon le harness.

Le dispatch des sub-agents doit donc être effectué directement par le runner ou par un dispatcher résident du bridge.

### 2.2 Le main agent reste un exécuteur possible

Le main agent peut néanmoins être ciblé explicitement par un job :

```typescript
executor: {
  kind: "main"
}
```

Dans ce cas, le bridge injecte une continuation dans sa session.

Le main agent est alors un worker parmi d’autres, pas le coordinateur technique du groupe parallèle.

---

## 3. Modèle mental : fork / join

Le besoin fondamental est un workflow de type :

```text
phase N
  │
  ├── fork
  │    ├── job A → sub-agent
  │    ├── job B → sub-agent
  │    ├── job C → sub-agent
  │    └── job D → main agent
  │
  ├── join(all)
  │
  └── phase N+1
```

Le `fork` lance plusieurs travaux indépendants.

Le `join` empêche la reprise de Turnlock tant que la condition de synchronisation n’est pas satisfaite.

Pour la première version, une seule stratégie est recommandée :

```typescript
join: "all"
```

Toutes les tâches doivent réussir avant la reprise.

Les stratégies suivantes sont volontairement hors scope de la v1 :

- `any`;
- `race`;
- `quorum`;
- dépendances partielles entre jobs ;
- DAG imbriqué dans un batch ;
- joins conditionnels ;
- cancellation distribuée complexe.

---

## 4. Deux sens différents du mot « parallèle »

### 4.1 Parallèle d’exécution

Plusieurs workers travaillent simultanément :

```text
sub-agent A → architecture
sub-agent B → tests
main agent  → exigences utilisateur
```

### 4.2 Parallèle vis-à-vis du main agent

Turnlock peut attendre les sub-agents sans bloquer inutilement le main agent.

La relation correcte est :

```text
Turnlock attend les résultats
≠
le main agent doit rester bloqué sans pouvoir agir
```

Le dispatcher doit être résident dans le harness et survivre au tool call initial.

Un simple processus CLI bloquant jusqu’à la fin de tous les sub-agents ne suffit pas si l’on veut que le main agent puisse continuer son propre travail.

---

## 5. Limite du modèle actuel

Le modèle Turnlock Runners v1.5 repose encore sur :

```typescript
pendingDelegation?: {
  label: string;
  kind: "prompt" | "batch";
  manifestPath: string;
  attempt: number;
}
```

Cette structure représente une seule délégation logique.

Elle ne permet pas de représenter proprement :

- plusieurs tâches en cours ;
- des exécuteurs différents ;
- des statuts individuels ;
- une tâche du main agent en parallèle des sub-agents ;
- une reprise partielle ;
- une barrière de synchronisation ;
- une collecte graduelle de résultats.

Le modèle doit évoluer vers un `pendingWorkset`.

---

## 6. Nouveau concept : Workset

Un `workset` est un ensemble durable de tâches lancées par un même fork et réunies par une même barrière de synchronisation.

### 6.1 Schéma conceptuel

```typescript
interface PendingWorkset {
  readonly version: 1;
  readonly label: string;
  readonly attempt: number;
  readonly manifestPath: string;
  readonly join: "all";
  readonly status:
    | "pending"
    | "running"
    | "joining"
    | "completed"
    | "failed";
  readonly tasks: readonly PendingWorksetTask[];
}
```

```typescript
interface PendingWorksetTask {
  readonly id: string;
  readonly executorKind: "main" | "subagent";
  readonly status:
    | "pending"
    | "dispatched"
    | "running"
    | "completed"
    | "failed"
    | "cancelled";
  readonly resultPath: string;
  readonly errorPath?: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
}
```

### 6.2 Invariant principal

Pour `join: "all"` :

```text
workset completed
⟺
chaque tâche a un résultat valide et un statut completed
```

Un fichier présent sans validation ne suffit pas.

Un statut `completed` sans fichier valide ne suffit pas.

---

## 7. API publique proposée

## 7.1 Exécuteurs

```typescript
type DelegationExecutor =
  | MainAgentExecutor
  | SubagentExecutor
  | LlmExecutor;
```

### Main agent

```typescript
interface MainAgentExecutor {
  readonly kind: "main";
  readonly effort?: ReasoningEffort;
  readonly toolProfile?: string;
  readonly additionalTools?: readonly string[];
  readonly deniedTools?: readonly string[];
}
```

### Sub-agent

```typescript
interface SubagentExecutor {
  readonly kind: "subagent";
  readonly worker?: string;
  readonly model?: string;
  readonly effort?: ReasoningEffort;
  readonly toolProfile?: string;
  readonly additionalTools?: readonly string[];
  readonly deniedTools?: readonly string[];
}
```

### LLM direct

```typescript
interface LlmExecutor {
  readonly kind: "llm";
  readonly runtime?: string;
  readonly model?: string;
  readonly effort?: ReasoningEffort;
}
```

### Reasoning effort

```typescript
type ReasoningEffort =
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "max";
```

Les runners peuvent supporter seulement un sous-ensemble de ces valeurs.

---

## 7.2 Job de batch

```typescript
interface ParallelDelegationJob {
  readonly id: string;
  readonly prompt: string;
  readonly executor: DelegationExecutor;
  readonly resultSchema?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}
```

Le champ `task` n’est pas nécessaire si `prompt` contient déjà la tâche complète.

Si une séparation explicite est souhaitée :

```typescript
interface ParallelDelegationJob {
  readonly id: string;
  readonly task?: string;
  readonly prompt: string;
  readonly executor: DelegationExecutor;
}
```

Mais `task` ne doit jamais remplacer le prompt complet persisté dans le manifest.

---

## 7.3 Requête batch hétérogène

```typescript
interface ParallelBatchDelegationRequest {
  readonly kind: "batch";
  readonly label: string;
  readonly jobs: readonly ParallelDelegationJob[];
  readonly join: "all";
  readonly dispatch?: ParallelDispatchPolicy;
  readonly delivery?: ResultDeliveryPolicy;
  readonly retry?: RetryPolicy;
  readonly timeout?: TimeoutPolicy;
}
```

```typescript
interface ParallelDispatchPolicy {
  readonly mode: "parallel";
  readonly maxConcurrency?: number;
  readonly failureMode?: "collect-all" | "fail-fast";
}
```

Pour la première version, la recommandation est :

```typescript
failureMode: "collect-all"
```

Cela permet de produire un diagnostic complet du workset avant de déclarer l’échec.

---

## 8. Batch hétérogène

Chaque job porte sa propre configuration d’exécution.

Exemple :

```typescript
await io.delegate({
  kind: "batch",
  label: "parallel-review",
  join: "all",

  jobs: [
    {
      id: "architecture",
      prompt: "Analyse l’architecture et identifie les défauts structurels.",
      executor: {
        kind: "subagent",
        worker: "architect",
        model: "claude-opus",
        effort: "high",
        toolProfile: "repository-analysis",
      },
    },

    {
      id: "tests",
      prompt: "Analyse la couverture des tests et les scénarios manquants.",
      executor: {
        kind: "subagent",
        worker: "test-reviewer",
        model: "claude-sonnet",
        effort: "medium",
        toolProfile: "repository-read-only",
      },
    },

    {
      id: "requirements",
      prompt: "Extrais les exigences importantes de la conversation courante.",
      executor: {
        kind: "main",
        effort: "medium",
        toolProfile: "repository-read-only",
      },
    },
  ],

  dispatch: {
    mode: "parallel",
    maxConcurrency: 3,
    failureMode: "collect-all",
  },

  delivery: {
    target: "pipeline",
    mode: "auto",
    inlineMaxBytes: 8192,
  },
});
```

Ici :

- les trois tâches sont indépendantes ;
- elles peuvent commencer en même temps ;
- elles utilisent des exécuteurs différents ;
- le workset ne se termine que lorsque les trois résultats sont valides.

---

## 9. Defaults et overrides

Pour éviter la répétition, l’API peut accepter des defaults au niveau du batch.

```typescript
interface ParallelBatchDelegationRequest {
  readonly kind: "batch";
  readonly label: string;
  readonly defaults?: Partial<SubagentExecutor>;
  readonly jobs: readonly ParallelDelegationJobInput[];
  readonly join: "all";
}
```

Exemple :

```typescript
await io.delegate({
  kind: "batch",
  label: "review",
  join: "all",

  defaults: {
    kind: "subagent",
    model: "sonnet",
    effort: "medium",
    toolProfile: "repository-read-only",
  },

  jobs: [
    {
      id: "tests",
      prompt: "Analyse les tests.",
    },
    {
      id: "architecture",
      prompt: "Analyse l’architecture.",
      executor: {
        model: "opus",
        effort: "high",
      },
    },
  ],
});
```

### 9.1 Règle de persistance

Le manifest durable ne doit pas conserver uniquement les defaults et overrides.

Il doit contenir la configuration complètement résolue de chaque job :

```typescript
const resolvedExecutor = {
  ...batch.defaults,
  ...job.executor,
};
```

Pourquoi :

- reprise déterministe ;
- audit exact ;
- aucun changement si les defaults du code évoluent ;
- pas de résolution différente selon le runner ;
- hashing stable du manifest.

---

## 10. Worker, modèle, effort et outils sont des axes différents

Ces concepts ne doivent pas être fusionnés.

### Worker

Le `worker` décrit :

- un rôle ;
- des instructions spécialisées ;
- une personnalité opérationnelle ;
- éventuellement un skill ou un agent profile.

### Model

Le `model` indique le moteur concret utilisé.

### Effort

L’`effort` indique le budget de raisonnement demandé.

### Tool profile

Le `toolProfile` indique la classe de capacités autorisées.

### Prompt

Le `prompt` décrit la tâche particulière du job.

Deux jobs peuvent donc utiliser :

- le même worker avec deux modèles différents ;
- le même modèle avec deux profils d’outils différents ;
- le même prompt avec deux niveaux d’effort différents ;
- deux workers différents sur le même modèle.

---

## 11. Outils et profils de capacités

## 11.1 Ne pas hériter automatiquement des outils du main agent

Un sub-agent ne doit pas recevoir automatiquement tous les outils du main agent.

Raisons :

- principe du moindre privilège ;
- portabilité entre harnesses ;
- comparabilité des exécutions ;
- sécurité ;
- déterminisme ;
- réduction des effets de bord.

### Règle recommandée

```text
Un sub-agent Turnlock ne reçoit aucun outil d’écriture par défaut.
```

Si les sub-agents ne doivent jamais modifier de fichiers, cette règle doit être structurelle et non seulement textuelle.

---

## 11.2 Tool profiles portables

Exemple :

```typescript
const ToolProfiles = {
  "reasoning-only": [],

  "repository-read-only": [
    "read_file",
    "list_directory",
    "grep",
    "search",
  ],

  "repository-analysis": [
    "read_file",
    "list_directory",
    "grep",
    "search",
    "git_diff",
  ],

  "web-research": [
    "web_search",
    "web_fetch",
  ],
} as const;
```

Le runner spécifique traduit ces profils vers les outils réels du harness.

### Overrides

```typescript
executor: {
  kind: "subagent",
  toolProfile: "repository-read-only",
  additionalTools: ["web_search"],
  deniedTools: ["shell", "write_file"],
}
```

### Invariant de résolution

```text
effectiveTools
=
(profile tools ∪ additionalTools) - deniedTools
```

Les outils non reconnus doivent provoquer une erreur de capability.

Ils ne doivent jamais être ignorés silencieusement.

---

## 12. Capabilities du runner

Tous les runners ne supportent pas nécessairement les mêmes fonctionnalités.

```typescript
interface RunnerCapabilities {
  readonly subagents: boolean;
  readonly mixedWorksets: boolean;
  readonly heterogeneousBatch: boolean;
  readonly perJobWorker: boolean;
  readonly perJobModel: boolean;
  readonly perJobEffort: boolean;
  readonly perJobTools: boolean;
  readonly mainAgentParticipation: boolean;
  readonly maxParallelJobs?: number;
  readonly supportedModels?: readonly string[];
  readonly supportedEfforts?: readonly ReasoningEffort[];
  readonly supportedToolProfiles?: readonly string[];
}
```

### Validation preflight

Avant tout dispatch, le runner valide la totalité du workset.

Exemple d’erreur :

```text
RunnerCapabilityError:
Runner "pi" does not support per-job model selection.
Job "architecture" requested model "opus".
```

Aucune exécution partielle ne doit commencer si le workset est invalide.

---

## 13. Main agent et sub-agents dans le même fork

Oui, le main agent peut participer au même batch parallèle.

Exemple valide :

```text
fork
├── sub-agent A : analyser l’architecture
├── sub-agent B : analyser les tests
└── main agent  : extraire les exigences utilisateur

join(all)

main agent : produire la synthèse finale
```

Les trois tâches du fork sont indépendantes.

### Exemple invalide

```text
fork
├── sub-agent A : analyser l’architecture
├── sub-agent B : analyser les tests
└── main agent  : synthétiser les résultats de A et B
```

La tâche du main agent dépend de A et B.

Elle ne peut donc pas être dans le même groupe parallèle.

Le workflow correct est :

```text
phase 1
  fork
  ├── A
  └── B

  join(all)

phase 2
  └── main agent : synthèse
```

### Règle

```text
Une tâche membre d’un fork ne doit dépendre d’aucune autre tâche du même fork.
```

---

## 14. Résultats des sub-agents

## 14.1 Le main agent récupère les résultats

Oui, le main agent doit pouvoir accéder aux résultats de tous les sub-agents.

Mais les résultats ne doivent pas nécessairement être injectés immédiatement dans son contexte au moment où chaque worker termine.

### Flux recommandé

```text
sub-agent
→ resultPath
→ validation Turnlock
→ mise à jour du workset
→ join
→ phase suivante
→ livraison au main agent si nécessaire
```

Pas :

```text
sub-agent
→ injection directe immédiate dans le main agent
→ Turnlock essaie ensuite de reconstruire l’état
```

Turnlock reste la source de vérité.

---

## 14.2 Ne pas injecter les résultats un par un

Flux déconseillé :

```text
A termine → message main agent
B termine → message main agent
C termine → message main agent
```

Problèmes :

- ordre non déterministe ;
- interruptions multiples ;
- contexte gonflé ;
- synthèse prématurée ;
- déduplication plus difficile ;
- différence de comportement selon la vitesse des workers ;
- race avec la propre tâche du main agent.

Flux recommandé :

```text
A termine
B termine
C termine
join(all)
→ une seule continuation cohérente
```

---

## 14.3 Politique de livraison

```typescript
interface ResultDeliveryPolicy {
  readonly target: "pipeline" | "main";
  readonly mode: "inline" | "references" | "auto";
  readonly inlineMaxBytes?: number;
}
```

### `target: "pipeline"`

Recommandé par défaut.

Les résultats reviennent d’abord à Turnlock.

La phase suivante décide :

- quoi consommer ;
- quoi valider ;
- quoi résumer ;
- quoi envoyer au main agent.

### `target: "main"`

Peut être utile pour une délégation terminale ou un workflow très simple.

Mais cette option réduit la séparation entre control plane et contexte agent.

---

## 14.4 Modes de livraison

### Inline

```text
## architecture
<contenu>

## tests
<contenu>
```

Avantage :

- immédiatement exploitable.

Inconvénient :

- consommation de contexte ;
- risque de message énorme.

### References

```text
Résultats :
- architecture: /tmp/.../architecture.json
- tests: /tmp/.../tests.json
```

Avantage :

- scalable ;
- lecture sélective ;
- contexte maîtrisé.

### Auto

```typescript
delivery: {
  mode: "auto",
  inlineMaxBytes: 8192,
}
```

Règle possible :

```text
taille ≤ inlineMaxBytes
→ inline

taille > inlineMaxBytes
→ reference
```

Le seuil peut s’appliquer :

- par résultat ;
- au total du workset ;
- ou aux deux.

---

## 15. Schéma de manifest proposé

Le manifest doit devenir explicitement hétérogène.

```typescript
const ResolvedExecutorSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("main"),
    effort: ReasoningEffortSchema.optional(),
    toolProfile: z.string().min(1).optional(),
    additionalTools: z.array(z.string().min(1)).optional(),
    deniedTools: z.array(z.string().min(1)).optional(),
  }).strict(),

  z.object({
    kind: z.literal("subagent"),
    worker: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    effort: ReasoningEffortSchema.optional(),
    toolProfile: z.string().min(1).optional(),
    additionalTools: z.array(z.string().min(1)).optional(),
    deniedTools: z.array(z.string().min(1)).optional(),
  }).strict(),

  z.object({
    kind: z.literal("llm"),
    runtime: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    effort: ReasoningEffortSchema.optional(),
  }).strict(),
]);
```

```typescript
const WorksetManifestJobSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/),
  prompt: z.string().min(1),
  executor: ResolvedExecutorSchema,
  resultPath: z.string().refine(path.isAbsolute),
  errorPath: z.string().refine(path.isAbsolute).optional(),
  resultSchema: z.string().min(1).optional(),
  metadata: z.record(z.unknown()).optional(),
}).strict();
```

```typescript
const WorksetManifestSchema = z.object({
  manifestVersion: z.literal(3),
  runId: z.string().min(1),
  orchestratorName: z.string().min(1),
  phase: z.string().min(1),
  resumeAt: z.string().min(1),
  label: z.string().regex(/^[a-z][a-z0-9-]*$/),
  kind: z.literal("workset"),
  join: z.literal("all"),
  emittedAt: z.string().datetime(),
  emittedAtEpochMs: z.number().int().nonnegative(),
  timeoutMs: z.number().int().positive(),
  deadlineAtEpochMs: z.number().int().positive(),
  attempt: z.number().int().nonnegative(),
  maxAttempts: z.number().int().positive(),
  dispatch: z.object({
    mode: z.literal("parallel"),
    maxConcurrency: z.number().int().positive().optional(),
    failureMode: z.enum(["collect-all", "fail-fast"]),
  }).strict(),
  delivery: z.object({
    target: z.enum(["pipeline", "main"]),
    mode: z.enum(["inline", "references", "auto"]),
    inlineMaxBytes: z.number().int().positive().optional(),
  }).strict(),
  jobs: z.array(WorksetManifestJobSchema).min(1),
}).strict();
```

---

## 16. Chemins de résultats

Exemple de layout :

```text
<runDir>/
└── results/
    └── <label>-<attempt>/
        ├── architecture.json
        ├── tests.json
        ├── requirements.json
        └── errors/
            └── tests.json
```

### Chemin déterministe

```typescript
const resultPath = path.join(
  runDir,
  "results",
  `${label}-${attempt}`,
  `${job.id}.json`,
);
```

### Invariant

Le runner vérifie le chemin exact attendu.

Il ne se contente pas de vérifier que le chemin est « quelque part dans results ».

```typescript
assertSameResolvedPath(actualResultPath, expectedResultPath);
```

---

## 17. State v3 proposé

```typescript
const PendingWorksetTaskSchema = z.object({
  id: z.string().min(1),
  executorKind: z.enum(["main", "subagent", "llm"]),
  status: z.enum([
    "pending",
    "dispatched",
    "running",
    "completed",
    "failed",
    "cancelled",
  ]),
  resultPath: z.string().min(1),
  errorPath: z.string().min(1).optional(),
  startedAt: z.string().datetime().optional(),
  completedAt: z.string().datetime().optional(),
}).strict();
```

```typescript
const PendingWorksetSchema = z.object({
  version: z.literal(1),
  label: z.string().min(1),
  attempt: z.number().int().nonnegative(),
  manifestPath: z.string().min(1),
  join: z.literal("all"),
  status: z.enum([
    "pending",
    "running",
    "joining",
    "completed",
    "failed",
  ]),
  tasks: z.array(PendingWorksetTaskSchema).min(1),
}).strict();
```

```typescript
const RunnerStateEnvelopeSchema = z.object({
  schemaVersion: z.literal(3),
  runId: z.string().min(1),
  orchestratorName: z.string().min(1),
  currentPhase: z.string().min(1),
  pendingWorkset: PendingWorksetSchema.optional(),
}).passthrough();
```

---

## 18. Qui met à jour le state ?

La source de vérité durable doit rester Turnlock core.

Le runner ou le bridge ne doit pas réécrire librement `state.json`.

Deux options propres sont possibles.

### Option A — événements de complétion consommés par le core

Chaque job écrit :

```text
resultPath
completion record
```

Puis le runner reprend Turnlock.

Le core lit les résultats, valide et met à jour le state.

### Option B — journal externe de workset

Le dispatcher maintient un journal séparé :

```text
<runnerDir>/worksets/<worksetId>/status.json
```

Mais le state Turnlock ne passe à `completed` qu’après validation par le core.

### Recommandation

Utiliser l’option A pour la v1.

Le dispatcher écrit les résultats.

Le runner déclenche la reprise quand tous les jobs ont produit un résultat ou une erreur terminale.

Turnlock valide ensuite l’ensemble atomiquement.

---

## 19. Dispatch du workset

Le runner effectue :

1. validation config ;
2. validation protocole ;
3. validation state ;
4. validation manifest ;
5. validation capabilities ;
6. validation des chemins ;
7. création d’un `WorksetRecord`;
8. publication d’un événement de dispatch ;
9. le bridge lance les jobs.

### Sub-agents

Le bridge appelle directement l’API native du harness.

### Main agent

Le bridge injecte une continuation contenant uniquement les jobs destinés au main agent.

### LLM direct

Le LLM Runner ou l’adapter appelle le runtime LLM sans session d’agent.

---

## 20. Main agent : format de continuation

Exemple :

```text
Continue le workset Turnlock `review-0`.

Tu es responsable uniquement des tâches suivantes :

1. `requirements`
   Extrais les exigences importantes de la conversation.

Écris le résultat JSON dans :
/tmp/.../results/review-0/requirements.json

Ne lance pas les autres jobs.
Ils sont exécutés directement par le dispatcher Turnlock.

Ne relance pas encore le pipeline.
Le bridge reprendra automatiquement Turnlock lorsque tout le workset
sera terminé.
```

Point essentiel :

```text
Le main agent ne doit pas lancer les sub-agents.
Le main agent ne doit pas décider quand le join est satisfait.
```

---

## 21. Reprise automatique

Dans le modèle actuel, la continuation demande au main agent de relancer :

```text
bun run agent-runner.ts --resume-yield <yieldId>
```

Dans le modèle mixte, cette responsabilité doit être déplacée vers le dispatcher.

Pourquoi :

- le main agent peut finir avant les sub-agents ;
- un sub-agent peut finir après le main agent ;
- le dernier worker n’est pas nécessairement le main ;
- aucun worker ne doit décider que le join est complet.

### Nouveau flux

```text
chaque worker termine
→ écrit resultPath
→ signale completion au dispatcher

dispatcher observe :
tous les jobs terminalement résolus
→ relance agent-runner --resume-workset <worksetId>
```

Le `resume` devient donc automatique.

---

## 22. Identité durable du workset

```typescript
worksetId = `${runId}:${label}:${attempt}`;
```

Comme pour `yieldId`, le chemin de stockage utilise un hash :

```text
workset-records/<sha256(worksetId)>.json
```

### WorksetRecord

```typescript
const WorksetRecordSchema = z.object({
  version: z.literal(1),
  worksetId: z.string().min(1),
  runId: z.string().min(1),
  runnerId: z.string().min(1),
  runDir: z.string().refine(path.isAbsolute),
  manifestPath: z.string().refine(path.isAbsolute),
  label: z.string().min(1),
  attempt: z.number().int().nonnegative(),
  jobIds: z.array(z.string().min(1)).min(1),
  createdAt: z.string().datetime(),
}).strict();
```

Écriture O_EXCL.

Une collision avec contenu différent est une erreur terminale.

---

## 23. Statut terminal des jobs

Chaque job se termine avec l’un des résultats suivants :

```typescript
type JobOutcome =
  | {
      status: "completed";
      resultPath: string;
    }
  | {
      status: "failed";
      errorKind: string;
      message: string;
      retryable: boolean;
      errorPath: string;
    }
  | {
      status: "cancelled";
      reason: string;
    };
```

Le dispatcher ne doit pas déduire le succès uniquement d’un exit code.

Il doit vérifier :

- événement de fin du worker ;
- existence du fichier ;
- validation structurelle minimale ;
- correspondance jobId / worksetId ;
- absence de conflit de double écriture.

---

## 24. Failure mode

## 24.1 `collect-all`

Tous les jobs autorisés continuent même si l’un échoue.

Le workset reprend Turnlock lorsque tous les jobs ont un outcome terminal.

Turnlock décide ensuite :

- retry global ;
- retry ciblé ;
- erreur terminale ;
- synthèse partielle explicitement autorisée.

### Avantage

Diagnostic complet et comportement déterministe.

## 24.2 `fail-fast`

Lorsqu’un job échoue :

- les jobs non démarrés sont annulés ;
- les jobs en cours peuvent être annulés si le harness le supporte ;
- le workset devient terminal.

### Limite

La cancellation distribuée est difficile à garantir.

Pour la v1, `collect-all` est préférable.

---

## 25. Retry

Deux niveaux doivent être distingués.

### Retry d’un job

Réexécute uniquement le job échoué.

### Retry du workset

Réémet un nouveau workset avec un nouvel `attempt`.

Pour la première version, le plus simple est :

```text
retry = nouveau workset attempt
```

Tous les chemins changent :

```text
results/review-0/*
results/review-1/*
```

Cela évite de mélanger des résultats issus de tentatives différentes.

Une optimisation future pourra réutiliser les résultats déjà valides.

---

## 26. Exactly-once et doubles écritures

La reprise idempotente n’implique pas une exécution exactement une fois.

Exemple :

```text
job A lancé deux fois
→ deux workers écrivent architecture.json
```

Le système doit au minimum détecter les conflits.

### Helper recommandé

```text
turnlock-write-result
```

Comportement :

```text
fichier absent
→ écriture atomique

fichier présent + même payload hash
→ idempotent

fichier présent + payload hash différent
→ ResultConflictError
```

Cette protection devrait être prioritaire pour les worksets parallèles.

---

## 27. Résultat métier et enveloppe technique

Le fichier écrit par chaque worker devrait être enveloppé :

```typescript
interface JobResultEnvelope<T> {
  readonly version: 1;
  readonly worksetId: string;
  readonly jobId: string;
  readonly runId: string;
  readonly attempt: number;
  readonly producedBy: {
    readonly kind: "main" | "subagent" | "llm";
    readonly worker?: string;
    readonly model?: string;
  };
  readonly completedAt: string;
  readonly payload: T;
}
```

Avantages :

- validation croisée ;
- audit ;
- détection de mauvais fichier ;
- traçabilité modèle / worker ;
- meilleure reprise.

---

## 28. Validation des résultats

Le core doit valider :

```text
enveloppe technique
+
schéma métier du payload
```

Exemple :

```typescript
const ArchitectureReviewResultSchema =
  JobResultEnvelopeSchema(ArchitectureReviewSchema);
```

Le `join` n’est satisfait qu’après validation des deux niveaux.

---

## 29. Livraison post-join au main agent

Après le join, la phase suivante peut produire une délégation main :

```typescript
phase("synthesis", async (io) => {
  const results = await io.consumePendingWorkset(
    ReviewWorksetResultsSchema,
  );

  return io.delegate({
    kind: "prompt",
    label: "final-synthesis",
    executor: {
      kind: "main",
    },
    prompt: buildSynthesisPrompt(results),
  });
});
```

Le main agent récupère donc tous les résultats nécessaires.

Il ne les reçoit pas directement de chaque sub-agent.

Il les reçoit après :

- validation ;
- checkpoint ;
- join ;
- sélection par la phase suivante.

---

## 30. Forme de `consumePendingWorkset`

```typescript
interface ConsumedWorksetResult<TJobs> {
  readonly worksetId: string;
  readonly label: string;
  readonly attempt: number;
  readonly results: TJobs;
}
```

Exemple :

```typescript
const result = io.consumePendingWorkset(
  z.object({
    architecture: ArchitectureReviewSchema,
    tests: TestReviewSchema,
    requirements: RequirementsSchema,
  }).strict(),
);
```

L’association se fait par `job.id`.

---

## 31. Événements bridge supplémentaires

Le bridge actuel gère :

- `CONTINUATION`;
- `DONE`;
- `ERROR`;
- `ABORTED`.

Pour les worksets, il faut distinguer le dispatch de la continuation main.

```typescript
type BridgeEvent =
  | WorksetDispatchEvent
  | MainTaskContinuationEvent
  | WorksetCompletedEvent
  | WorksetFailedEvent
  | DoneEvent
  | ErrorEvent
  | AbortedEvent;
```

### Workset dispatch

```typescript
interface WorksetDispatchEvent {
  readonly type: "WORKSET_DISPATCH";
  readonly worksetId: string;
  readonly jobs: readonly ResolvedWorksetJob[];
}
```

### Main task continuation

```typescript
interface MainTaskContinuationEvent {
  readonly type: "MAIN_TASKS";
  readonly worksetId: string;
  readonly jobs: readonly MainWorksetJob[];
}
```

### Workset completion

Événement interne au bridge ou au runner :

```typescript
interface WorksetCompletedEvent {
  readonly type: "WORKSET_COMPLETED";
  readonly worksetId: string;
  readonly outcomes: readonly JobOutcome[];
}
```

Il n’est pas nécessaire de l’injecter dans le main agent.

Il sert à déclencher la reprise.

---

## 32. Ordonnancement

### Règle de dispatch

Tous les jobs du workset sont validés avant le premier lancement.

Puis :

```text
sub-agent jobs → dispatch direct
main jobs      → injection main
llm jobs       → runtime direct
```

### maxConcurrency

```typescript
maxConcurrency?: number;
```

Cette limite s’applique aux jobs externes.

Le main agent peut être compté ou non selon le harness, mais la politique doit être documentée.

Recommandation :

```text
maxConcurrency compte tous les jobs du workset,
y compris les jobs main.
```

---

## 33. Verrou de session

Le verrou `active-runner.lock` reste valable pour le workflow logique entier.

Mais un workset peut contenir plusieurs exécutions simultanées.

Le verrou ne doit donc pas signifier :

```text
un seul processus actif
```

Il signifie :

```text
un seul workflow Turnlock propriétaire de cette session
```

Les sub-agents enfants appartiennent au même runner logique.

Ils ne tentent pas d’acquérir le verrou de session principal.

---

## 34. Crash recovery

### Crash du bridge

Le spool restaure :

- les événements non livrés ;
- les jobs dispatchés ;
- les outcomes déjà reçus.

### Crash du runner

Le `WorksetRecord` et le state Turnlock permettent de reconstruire l’identité.

### Crash d’un sub-agent

Le dispatcher écrit un outcome `failed`.

### Crash après écriture du résultat mais avant outcome

Au redémarrage :

- vérifier le fichier ;
- valider l’enveloppe ;
- reconstituer `completed`.

### Crash après tous les résultats mais avant reprise

Le dispatcher recalcule le join et relance le runner.

---

## 35. Invariants de sécurité

1. Chaque `job.id` est unique dans le workset.
2. Chaque `resultPath` est déterministe.
3. Aucun résultat n’est en dehors du répertoire du workset.
4. Chaque job possède un executor résolu.
5. Aucun outil inconnu n’est ignoré.
6. Aucun modèle inconnu n’est remplacé silencieusement.
7. Aucun effort inconnu n’est downgradé silencieusement.
8. Le main agent ne reçoit que ses propres jobs.
9. Un sub-agent ne peut pas déclencher directement la reprise.
10. Le dispatcher est le seul à évaluer le join.
11. Le core est le seul à valider définitivement les résultats.
12. Une tâche du fork ne dépend pas d’une autre tâche du même fork.
13. Un ancien workset ne peut pas reprendre un attempt plus récent.
14. Une double écriture divergente est une erreur.
15. Un workset invalide échoue avant tout dispatch.

---

## 36. Compatibilité avec le modèle existant

### Prompt simple

```typescript
kind: "prompt"
```

Peut rester inchangé.

### Batch homogène historique

```typescript
{
  kind: "batch",
  worker: "reviewer",
  jobs: [...]
}
```

Peut être normalisé vers :

```typescript
{
  kind: "batch",
  join: "all",
  defaults: {
    kind: "subagent",
    worker: "reviewer",
  },
  jobs: [...]
}
```

### Migration

Le core peut accepter temporairement les deux versions :

```text
manifestVersion 2
→ batch homogène historique

manifestVersion 3
→ workset hétérogène
```

Le runner v2 peut supporter les deux.

---

## 37. Proposition de nouvelle union publique

```typescript
type DelegationRequest =
  | PromptDelegationRequest
  | LegacyBatchDelegationRequest
  | WorksetDelegationRequest;
```

À terme :

```typescript
type DelegationRequest =
  | PromptDelegationRequest
  | WorksetDelegationRequest;
```

Un batch homogène devient simplement un workset dont tous les jobs partagent le même executor.

---

## 38. API cible simplifiée

```typescript
await io.delegate({
  kind: "workset",
  label: "review",
  join: "all",

  jobs: [
    {
      id: "architecture",
      prompt: "...",
      executor: {
        kind: "subagent",
        worker: "architect",
        model: "opus",
        effort: "high",
        toolProfile: "repository-analysis",
      },
    },
    {
      id: "tests",
      prompt: "...",
      executor: {
        kind: "subagent",
        worker: "tester",
        model: "sonnet",
        effort: "medium",
        toolProfile: "repository-read-only",
      },
    },
    {
      id: "requirements",
      prompt: "...",
      executor: {
        kind: "main",
      },
    },
  ],

  dispatch: {
    mode: "parallel",
    maxConcurrency: 3,
    failureMode: "collect-all",
  },

  delivery: {
    target: "pipeline",
    mode: "auto",
    inlineMaxBytes: 8192,
  },
});
```

Le nom `kind: "workset"` est plus précis que `kind: "batch"` dès lors que :

- les exécuteurs sont hétérogènes ;
- le main agent peut participer ;
- un join explicite existe ;
- le runtime suit les statuts individuellement.

---

## 39. Flux complet cible

```text
1. pipeline.ts appelle io.delegate(kind="workset")

2. Turnlock core :
   - valide la requête
   - résout les defaults
   - génère les resultPath
   - écrit WorksetManifest v3
   - checkpoint state.pendingWorkset
   - émet DELEGATE kind=workset

3. agent-runner :
   - parse le protocole
   - valide config / state / manifest
   - vérifie les capabilities
   - crée WorksetRecord
   - publie WORKSET_DISPATCH

4. bridge / dispatcher :
   - lance les jobs subagent
   - lance les jobs llm
   - injecte les jobs main
   - collecte les outcomes

5. chaque job :
   - écrit JobResultEnvelope
   - signale sa terminaison

6. dispatcher :
   - vérifie que tous les jobs sont terminalement résolus
   - applique join(all)
   - relance agent-runner --resume-workset <worksetId>

7. Turnlock core :
   - lit tous les résultats
   - valide enveloppes + schémas métier
   - checkpoint
   - avance à la phase suivante

8. phase suivante :
   - consomme le workset
   - décide si les résultats doivent être envoyés au main agent
   - inline / references / auto
```

---

## 40. Cas d’usage détaillé

### Objectif

- deux audits indépendants ;
- une extraction d’exigences par le main agent ;
- synthèse après join.

### Phase 1

```typescript
phase("parallel-review", async (io) => {
  return io.delegate({
    kind: "workset",
    label: "review",
    join: "all",

    jobs: [
      {
        id: "architecture",
        prompt: "Analyse l’architecture.",
        executor: {
          kind: "subagent",
          worker: "architect",
          model: "opus",
          effort: "high",
          toolProfile: "repository-analysis",
        },
      },
      {
        id: "tests",
        prompt: "Analyse les tests.",
        executor: {
          kind: "subagent",
          worker: "test-reviewer",
          model: "sonnet",
          effort: "medium",
          toolProfile: "repository-read-only",
        },
      },
      {
        id: "requirements",
        prompt: "Extrais les exigences utilisateur pertinentes.",
        executor: {
          kind: "main",
          effort: "medium",
        },
      },
    ],

    dispatch: {
      mode: "parallel",
      failureMode: "collect-all",
    },

    delivery: {
      target: "pipeline",
      mode: "references",
    },
  });
});
```

### Phase 2

```typescript
phase("synthesis", async (io) => {
  const reviews = io.consumePendingWorkset(
    z.object({
      architecture: ArchitectureReviewSchema,
      tests: TestReviewSchema,
      requirements: RequirementsSchema,
    }).strict(),
  );

  return io.delegate({
    kind: "prompt",
    label: "synthesis",
    executor: {
      kind: "main",
    },
    prompt: buildSynthesisPrompt(reviews),
  });
});
```

---

## 41. Scénarios d’erreur

### Un modèle non supporté

Échec preflight avant dispatch.

### Un profil d’outils inconnu

Échec preflight avant dispatch.

### Le main agent écrit le mauvais fichier

Outcome invalide, workset échoué ou retry.

### Un sub-agent finit deux fois avec deux contenus différents

`ResultConflictError`.

### Un job ne finit jamais

Timeout du workset ou du job.

### Le main agent finit avant les sub-agents

Aucun problème.

Le dispatcher attend le join.

### Les sub-agents finissent avant le main agent

Aucun problème.

Le dispatcher attend le job main.

### Tous les jobs finissent pendant que le bridge redémarre

Le bridge reconstruit les outcomes depuis les fichiers et reprend.

### Une ancienne continuation main est rejouée

Le `worksetId`, l’attempt et le résultat immuable empêchent une reprise obsolète.

---

## 42. Tests nécessaires

### Schémas

- executor main valide ;
- executor subagent valide ;
- executor llm valide ;
- champs inattendus rejetés ;
- jobId dupliqué rejeté ;
- effort invalide rejeté ;
- toolProfile invalide rejeté ;
- manifest v3 round-trip.

### Capabilities

- per-job model supporté ;
- per-job model non supporté ;
- per-job tools non supporté ;
- mixedWorksets non supporté ;
- limite de concurrence dépassée ;
- modèle non listé ;
- effort downgradé interdit.

### Dispatch

- trois sub-agents parallèles ;
- deux sub-agents + main ;
- sub-agent + llm + main ;
- maxConcurrency ;
- collect-all ;
- fail-fast si implémenté.

### Join

- tous complétés ;
- un échoué ;
- résultat absent ;
- résultat invalide ;
- résultat présent avant outcome ;
- outcome présent avant résultat ;
- crash avant resume ;
- double resume.

### Livraison

- inline ;
- references ;
- auto sous seuil ;
- auto au-dessus du seuil ;
- plusieurs gros résultats ;
- continuation unique après join.

### Sécurité

- resultPath traversal ;
- mauvais worksetId dans le résultat ;
- mauvais jobId ;
- double écriture divergente ;
- tool escalation ;
- ancien attempt rejoué ;
- manifest modifié après dispatch.

### Compatibilité

- prompt v2 ;
- batch homogène v2 ;
- workset v3 ;
- migration v2 vers v3.

---

## 43. Ordre d’implémentation recommandé

1. Définir `DelegationExecutor`.
2. Définir `WorksetDelegationRequest`.
3. Définir `WorksetManifestSchema` v3.
4. Résoudre defaults et overrides côté core.
5. Générer les chemins exacts par job.
6. Ajouter `pendingWorkset` au state v3.
7. Ajouter `WorksetRecord`.
8. Ajouter la validation des capabilities.
9. Implémenter les tool profiles.
10. Implémenter `WORKSET_DISPATCH`.
11. Implémenter le dispatcher sub-agent.
12. Implémenter la continuation ciblée main.
13. Implémenter la collecte des outcomes.
14. Implémenter le join `all`.
15. Déplacer le resume vers le dispatcher.
16. Ajouter `JobResultEnvelope`.
17. Ajouter l’écriture atomique avec payload hash.
18. Implémenter `consumePendingWorkset`.
19. Implémenter la delivery inline / references / auto.
20. Ajouter crash recovery.
21. Ajouter tests de concurrence et reprise.
22. Migrer le batch homogène vers le workset générique.

---

## 44. Décisions finales

### Décision 1

Le main agent ne lance pas les sub-agents par défaut.

### Décision 2

Le runner / bridge spécifique au harness effectue le dispatch direct.

### Décision 3

Chaque job peut posséder :

- son propre prompt ;
- son propre worker ;
- son propre modèle ;
- son propre effort ;
- son propre profil d’outils ;
- son propre exécuteur.

### Décision 4

Le main agent peut être membre du même groupe parallèle, à condition que sa tâche soit indépendante des autres jobs.

### Décision 5

Les résultats reviennent d’abord à Turnlock.

### Décision 6

Le main agent reçoit les résultats après le join, pas au fil de l’eau, sauf besoin explicitement différent.

### Décision 7

Le dispatcher évalue le join et déclenche la reprise.

Aucun worker individuel ne décide que le workset est terminé.

### Décision 8

La v1 ne supporte que :

```text
join = all
failureMode = collect-all
```

### Décision 9

Les résultats sont livrés selon :

```text
inline | references | auto
```

### Décision 10

Le concept public cible doit être nommé `workset`, car il représente plus qu’un simple batch homogène.

---

## 45. Résumé

L’architecture cible devient :

```text
Turnlock core
  → décrit un workset durable et validé

Runner
  → valide le protocole et les capabilities

Bridge / dispatcher
  → lance les sub-agents, LLMs et tâches main en parallèle

Workers
  → écrivent des résultats immuables

Dispatcher
  → attend join(all) puis reprend Turnlock

Turnlock core
  → valide les résultats et avance

Main agent
  → récupère les résultats au moment décidé par la phase suivante
```

Cette séparation conserve Turnlock comme control plane déterministe tout en permettant une exécution multi-agent réellement parallèle, hétérogène, portable et récupérable.
