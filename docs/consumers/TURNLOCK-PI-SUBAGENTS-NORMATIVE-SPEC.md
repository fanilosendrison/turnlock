---
id: TURNLOCK-PI-SUBAGENTS-NORMATIVE-SPEC
version: "1.0.0"
scope: turnlock
status: conceptually-frozen
normative_language: RFC-2119-style
supersedes:
  - TURNLOCK-MIXED-PARALLEL-DELEGATIONS draft
extends:
  - TURNLOCK-RUNNERS@1.5.0
requires_amendments:
  - TURNLOCK-BINDINGS
  - TURNLOCK-MANIFEST
  - TURNLOCK-STATE-IO
  - TURNLOCK-HANDLE-RESUME
  - TURNLOCK-ERRORS
  - TURNLOCK-RETRY
  - TURNLOCK-RUNNERS
  - TURNLOCK-PI-ADAPTER
---

# Turnlock Runner Worksets et intégration `pi-subagents`

## Spécification normative consolidée

**Date du freeze conceptuel :** 2026-07-21  
**Statut :** architecture conceptuellement gelée, prête pour formalisation et implémentation  
**Dépendance Pi ciblée pour la v1 :** `pi-subagents@0.35.1`, commit vérifié `071dbc1`  
**Langue normative :** les termes **DOIT**, **NE DOIT PAS**, **DEVRAIT**, **PEUT** et **RECOMMANDÉ** ont une valeur normative.

---

# 0. Résumé exécutif

Cette spécification définit comment Turnlock exécute une délégation comprenant :

- zéro ou un job confié à la session principale du harness, appelé **job host** ;
- zéro ou plusieurs jobs exécutés par des sessions enfants Pi, appelés **jobs worker** ;
- au maximum un groupe parallèle `pi-subagents` par workset et par attempt ;
- un join global durable contrôlé par le Turnlock Runner ;
- une validation protocolaire et métier autoritative par le Turnlock core.

L’architecture sépare strictement quatre couches :

1. **Turnlock core** : état métier, progression de la FSM, délégations, deadlines, retry et validation métier.
2. **Turnlock Runner** : handoff, WorksetRecord durable, ownership, fencing, intake, adoption, commit final et reprise du core.
3. **Pi Adapter** : résolution des profils, traduction vers le RPC Pi, collecte des artefacts, normalisation et observations d’exécution.
4. **`pi-subagents`** : lancement, concurrence et supervision des sessions enfants Pi.

Principe directeur :

> **Turnlock décide si le workflow peut avancer. `pi-subagents` décide comment les enfants Pi sont exécutés.**

La v1 promet :

```text
exécution LLM concrète        : at-least-once
publication d’une soumission  : idempotente par contenu
adoption d’une soumission     : exactly-once logique
commit d’un outcome final     : exactly-once par job/attempt
reprise du core               : idempotente
```

Elle ne promet pas une exécution LLM exactly-once.

---

# 1. Objectifs

La présente architecture DOIT :

1. conserver Turnlock comme source de vérité de la progression métier ;
2. utiliser les primitives robustes existantes de `pi-subagents` au lieu de les réimplémenter ;
3. permettre à plusieurs jobs worker hétérogènes d’être exécutés en parallèle ;
4. permettre le chevauchement d’un job host indépendant avec le groupe Pi ;
5. conserver un état durable permettant la récupération après crash ;
6. distinguer clairement :
   - exécution technique ;
   - soumission non privilégiée ;
   - adoption autorisée ;
   - outcome final ;
   - validation métier ;
7. empêcher un ancien contrôleur de committer ou reprendre après rotation de propriété ;
8. empêcher le mélange de résultats provenant de plusieurs exécutions LLM concurrentes ;
9. traiter les échecs d’exécuteur comme des outcomes explicites ;
10. traiter une enveloppe corrompue comme une erreur protocolaire fatale ;
11. rester portable vers d’autres harnesses et adapters ;
12. ne pas exposer au core les détails Pi tels que modèle, thinking, agent Pi ou outils concrets.

---

# 2. Non-objectifs de la v1

La v1 NE DOIT PAS tenter de fournir :

- plusieurs groupes Pi actifs ou successifs dans le même workset ;
- un scheduler global de children dans Turnlock ;
- plusieurs jobs host dans le même workset ;
- des dépendances internes host → worker ou worker → host dans le même workset ;
- `context: "fork"` sans snapshot reproductible du contexte ;
- un snapshot immuable du workspace ;
- une isolation contre un agent hostile disposant d’un shell arbitraire ;
- des outils arbitraires accordés dynamiquement à un child Pi ;
- un fallback automatique demandant au main agent de spawn les children ;
- un digest de la configuration Pi effectivement résolue si l’API publique Pi ne l’expose pas ;
- un arbitrage global de concurrence entre plusieurs runs Pi ;
- une transaction atomique multi-fichiers pour plusieurs jobs host ;
- une adoption tardive basée uniquement sur les timestamps internes Pi.

Tout besoin de dépendance entre jobs DOIT être représenté par une nouvelle phase Turnlock après un join.

---

# 3. Architecture canonique

```text
pipeline.ts
    │
    ▼
Turnlock core
    │ pendingDelegation(kind=batch)
    │ manifest v3 neutre
    │ delegationId + attemptId
    ▼
Turnlock Runner
    │ AttemptRecord
    │ WorksetRecord durable
    │ owner lease + transaction mutex
    │ resolved execution specs
    ▼
Pi Adapter résident
    ├── 0..1 job host
    │      └── continuation main agent
    │          └── script runner-owned
    │              └── HostJobSubmissionEnvelope
    │
    └── 0..1 groupe Pi
           └── pi-subagents RPC async
               └── sessions Pi enfants
                   └── sorties brutes et lifecycle
                       └── Pi Adapter
                           └── PiWorkerJobSubmissionEnvelope
    │
    ▼
Current owner
    │ adoption fenced
    │ JobOutcomeEnvelope final
    │ barrière all-terminal
    ▼
agent-runner --resume-attempt <attemptId>
    │ charge et exécute le resumeCmd du core
    ▼
Turnlock core / handle-resume
    │ valide les outcomes
    │ agrège les failures
    │ unwrap les success payloads
    │ validation Zod métier lazy
    │ retry ou phase suivante
    ▼
workflow
```

---

# 4. Autorité par couche

## 4.1 Turnlock core

Le core est autoritatif pour :

- `turnlockRunId` ;
- `delegationId` ;
- `attemptId` et compteur `attempt` ;
- manifest v3 neutre ;
- `manifestDigest` ;
- `resultEnvelopeVersion` ;
- deadline métier ;
- taxonomie `transient | permanent | abort` ;
- politique de retry ;
- ordre des jobs du manifest ;
- validation de l’identité core-owned dans les outcomes ;
- recomputation des digests de payload ;
- validation Zod métier ;
- décision de progression de la FSM.

Le core NE DOIT PAS connaître :

- `worksetId` comme état métier ;
- `piRunId` ;
- `launchId` ;
- modèle ou thinking Pi ;
- agent Pi concret ;
- outils concrets ;
- session Pi ;
- `chainDir` ;
- chemins de staging d’un launch ;
- ownership du workset.

## 4.2 Turnlock Runner

Le Runner est autoritatif pour :

- `AttemptRecord` ;
- `worksetId` ;
- `WorksetRecord` ;
- owner lease et fence ;
- transaction mutex ;
- état logique `intake: open | closed` ;
- résolution des profils ;
- specs d’exécution engagés ;
- drift checks ;
- bindings runtime ;
- launch éligible ;
- adoption des soumissions ;
- commit des outcomes finaux ;
- barrière all-terminal ;
- sélection d’un attempt à reprendre ;
- exécution exacte du `resumeCmd` produit par le core.

## 4.3 Pi Adapter

Le Pi Adapter est autoritatif pour :

- mapping du profil Turnlock vers les inputs Pi connus ;
- handshake RPC ;
- création de la requête `pi-subagents` ;
- collecte tolérante des artefacts Pi ;
- observation du lifecycle ;
- transformation d’un output brut en soumission worker ;
- corrélation `launchId ↔ piRunId` ;
- observation du modèle réellement tenté/utilisé lorsque disponible ;
- stop/interrupt technique des runs Pi.

Le Pi Adapter NE DOIT PAS décider :

- du retry métier ;
- de la classification finale Turnlock ;
- de l’avancement de la FSM ;
- d’accorder des outils arbitraires hors profils Pi configurés.

## 4.4 `pi-subagents`

`pi-subagents` est autoritatif pour :

- création des sessions enfants ;
- scheduling interne du groupe parallèle ;
- concurrence des children ;
- preflight Pi ;
- fallback modèle/provider interne ;
- lifecycle de chaque child ;
- timeout/runtime interne ;
- stop et interrupt ;
- artefacts techniques Pi.

---

# 5. Topologie v1

Un workset v1 DOIT respecter :

```text
workset
├── 0..1 groupe Pi parallèle
└── 0..1 job host
```

Contraintes :

1. un seul groupe Pi total par `worksetId` et `attemptId` ;
2. aucun groupe Pi successif ;
3. zéro ou un host ;
4. `failFast` DOIT être `false` ;
5. `context` DOIT être `fresh` ;
6. le host et tous les workers DOIVENT être indépendants ;
7. le workspace partagé DOIT être coopérativement read-only durant leur chevauchement ;
8. tous les worker jobs DOIVENT être compatibles avec un même :
   - contexte ;
   - workspace ;
   - session Pi ;
   - environnement ;
   - domaine de deadline ;
   - domaine de cancellation ;
   - politique de permissions ;
   - modèle de recovery.

Toute topologie incompatible DOIT échouer en preflight avec une erreur permanente explicite.

---

# 6. Identités et portées

Les identités DOIVENT avoir des portées distinctes :

```text
turnlockRunId
└── delegationId
    ├── attemptId A
    │   └── worksetId A
    │       ├── launchId 1 → piRunId 1
    │       └── launchId 2 → piRunId 2 éventuel
    └── attemptId B
        └── worksetId B
            └── launchId 3 → piRunId 3
```

## 6.1 `turnlockRunId`

Identifie le workflow Turnlock complet.

## 6.2 `delegationId`

Identifie une délégation logique et reste stable entre ses retries.

Exemple : « obtenir tous les résultats du batch review ».

## 6.3 `attemptId`

Identifie un attempt Turnlock précis. Un retry métier DOIT créer un nouvel `attemptId` et incrémenter `attempt`.

## 6.4 `worksetId`

Identifie l’exécution Runner de l’attempt. Il DOIT rester stable pendant la récupération du même attempt.

## 6.5 `launchId`

Identifie une tentative concrète de dispatch du groupe Pi dans le même workset. Plusieurs `launchId` PEUVENT exister dans un workset, mais un seul peut être éligible à un instant donné.

## 6.6 `piRunId`

Identifie un processus/groupe concret `pi-subagents`. Plusieurs `piRunId` PEUVENT correspondre au même `attemptId` à cause de la garantie at-least-once.

## 6.7 Suppression de l’ambiguïté `yieldId`

Le nouveau modèle normatif utilise `attemptId` comme identité de sélection Runner.

Commande :

```text
agent-runner --resume-attempt <attemptId>
```

Cette commande NE remplace PAS le contrat de reprise du core. Elle :

1. charge l’AttemptRecord ;
2. vérifie que `state.pendingDelegation.attemptId` correspond ;
3. charge le `resumeCmd` émis par Turnlock ;
4. exécute exactement ce `resumeCmd`.

Un alias `--resume-yield` n’est nécessaire que pour une compatibilité déjà publiée.

---

# 7. Manifest v3 neutre

## 7.1 Cible portable

```typescript
type DelegationTargetV1 =
  | { readonly kind: "host" }
  | { readonly kind: "worker"; readonly profile: string }
  | { readonly kind: "direct"; readonly profile: string };
```

Le core PEUT connaître la topologie portable, mais NE DOIT PAS inclure :

- `model` ;
- `thinking` ;
- `tools` ;
- `piAgent` ;
- `claudeAgent` ;
- `sessionRef`.

## 7.2 Schéma conceptuel

```typescript
interface ManifestJobV3 {
  readonly id: string;
  readonly prompt: string;
  readonly target: DelegationTargetV1;
  readonly resultPath: string;
  readonly resultContractId?: string;
}

interface DelegationManifestV3 {
  readonly manifestVersion: 3;

  readonly turnlockRunId: string;
  readonly delegationId: string;
  readonly attemptId: string;
  readonly attempt: number;

  readonly orchestratorName: string;
  readonly label: string;
  readonly kind: "prompt" | "batch";
  readonly jobs: readonly ManifestJobV3[];

  readonly resultEnvelopeVersion: 1;
  readonly deadlineAtEpochMs: number;
  readonly resumeCmd: string;
}
```

## 7.3 Digest du manifest

Le core DOIT :

1. produire le manifest ;
2. valider ses octets comme I-JSON ;
3. canonicaliser avec RFC 8785 JCS ;
4. calculer SHA-256 ;
5. persister le digest dans `pendingDelegation`.

Le manifest NE DOIT PAS contenir son propre digest de manière autoréférentielle.

---

# 8. Évolution de `pendingDelegation`

```typescript
interface PendingDelegationV3 {
  readonly kind: "prompt" | "batch";
  readonly label: string;

  readonly delegationId: string;
  readonly attemptId: string;
  readonly attempt: number;

  readonly manifestPath: string;
  readonly manifestVersion: 3;
  readonly manifestDigest: PayloadDigest;
  readonly resultEnvelopeVersion: 1;

  readonly jobIds: readonly string[];
  readonly deadlineAtEpochMs: number;
  readonly resumeCmd: string;
}
```

Le core conserve `pendingDelegation`. Il NE DOIT PAS ajouter `pendingWorkset` dans `state.json`.

---

# 9. Records Runner

## 9.1 AttemptRecord

```typescript
interface AttemptRecordV1 {
  readonly version: 1;
  readonly turnlockRunId: string;
  readonly delegationId: string;
  readonly attemptId: string;
  readonly attempt: number;
  readonly worksetId: string;

  readonly manifestPath: string;
  readonly manifestDigest: PayloadDigest;
  readonly resumeCmd: string;

  readonly createdAtEpochMs: number;
}
```

## 9.2 WorksetRecord

Le WorksetRecord est snapshot-authoritative pour l’exécution Runner.

```typescript
interface WorksetRecordV1 {
  readonly version: 1;

  readonly turnlockRunId: string;
  readonly delegationId: string;
  readonly attemptId: string;
  readonly attempt: number;
  readonly worksetId: string;

  readonly manifestDigest: PayloadDigest;
  readonly deadlineAtEpochMs: number;

  readonly owner: WorksetOwnerV1;
  readonly intake: "open" | "closed";

  readonly workspaceInputCommitment: WorkspaceInputCommitmentV1;

  readonly host?: HostExecutionStateV1;
  readonly pi?: PiExecutionStateV1;

  readonly outcomes: readonly CommittedOutcomeRefV1[];

  readonly state:
    | "prepared"
    | "dispatching"
    | "running"
    | "collecting"
    | "committing"
    | "joined"
    | "resuming"
    | "resumed"
    | "failed";

  readonly updatedAtEpochMs: number;
}
```

Les records internes Turnlock/Runner DOIVENT être validés avec des schémas fermés `.strict()`.

---

# 10. Owner lease, fence et transaction mutex

## 10.1 Owner lease

Le lease répond à : « qui est le contrôleur courant ? »

```typescript
interface WorksetOwnerV1 {
  readonly generation: number;
  readonly ownerToken: string;
  readonly acquiredAtEpochMs: number;
  readonly leaseUntilEpochMs: number;
  readonly heartbeatAtEpochMs: number;
}
```

Propriétés :

- longue durée ;
- heartbeat ;
- expiration ;
- récupération ;
- incrément atomique de génération ;
- nouveau token à chaque récupération.

Le `ownerToken` NE DOIT JAMAIS être transmis :

- au main agent ;
- à un child Pi ;
- au script de soumission ;
- dans un ticket worker.

## 10.2 Transaction mutex

Le mutex répond à : « qui effectue une transaction courte sur le workset ? »

Il DOIT :

- utiliser une acquisition atomique ;
- être récupérable après abandon ;
- relire le WorksetRecord sous lock ;
- protéger toutes les compare-and-write ;
- sérialiser publication, fermeture d’intake, adoption et commit.

Acquérir le mutex NE confère PAS une propriété du workset.

## 10.3 Fencing

Toute opération propriétaire DOIT, sous mutex :

1. relire le WorksetRecord ;
2. comparer `generation` et `ownerToken` ;
3. refuser si le fence ne correspond plus ;
4. effectuer la transition ;
5. écrire atomiquement le nouveau snapshot.

Opérations propriétaires :

- mutation du WorksetRecord hors publication worker ;
- adoption d’une soumission ;
- sélection/supersession d’un launch ;
- commit d’un outcome final ;
- fermeture de l’intake ;
- satisfaction du join ;
- lancement de la reprise.

## 10.4 Actions non propriétaires sous mutex

Le script host PEUT, sous mutex :

- vérifier son ticket ;
- vérifier l’attempt ;
- vérifier l’intake et la deadline ;
- publier une soumission immuable.

Il NE PEUT PAS :

- modifier le state du workset ;
- fermer l’intake ;
- adopter ;
- committer un outcome ;
- joindre ;
- reprendre Turnlock.

---

# 11. Intake et fermeture atomique

## 11.1 État logique

```typescript
type IntakeState = "open" | "closed";
```

Le submission gate est une responsabilité logique implémentée par `intake` sous le transaction mutex. Il ne nécessite pas un troisième lock physique.

## 11.2 Publication host

```text
script
→ acquire transaction mutex
→ lire WorksetRecord
→ vérifier ticket + attempt + intake=open + deadline
→ publier HostJobSubmissionEnvelope par rename atomique
→ release
```

## 11.3 Publication worker

Un output brut Pi disponible NE constitue PAS un résultat reçu.

```text
Pi child termine
→ output brut disponible
→ Pi Adapter parse et normalise
→ acquire transaction mutex
→ vérifier attempt + launch éligible + intake=open + deadline
→ publier PiWorkerJobSubmissionEnvelope
→ release
```

La réception normative est :

```text
WorkerSubmissionEnvelope publiée sous mutex
=
résultat reçu par Turnlock Runner
```

## 11.4 Fermeture à la deadline

```text
current owner
→ acquire transaction mutex
→ vérifier fence
→ dernier scan des soumissions
→ intake := closed
→ écrire atomiquement WorksetRecord
→ release
→ demander stop/interrupt des jobs running ou paused
→ réconcilier leurs états terminaux
→ produire les failure outcomes nécessaires
→ évaluer all-terminal
```

Une soumission publiée avant la fermeture PEUT être adoptée après la deadline et après rotation du propriétaire.

Une soumission qui n’a pas été publiée avant fermeture NE DOIT PAS être adoptée, même si le child Pi a terminé avant la deadline.

## 11.5 Marge temporelle

Invariant :

```text
pi-subagents maxRuntimeMs
<
Turnlock deadline restante
```

La marge DOIT couvrir :

- observation du lifecycle ;
- lecture bornée de l’output ;
- validation ;
- canonicalisation ;
- publication sous mutex ;
- adoption ;
- commit ;
- reprise.

---

# 12. Workspace partagé et drift detection

## 12.1 Règle v1

Pendant le chevauchement :

```text
phase A
├── groupe Pi read-only
└── host read-only

join

phase B
└── mutations
```

La propriété read-only est coopérative dans le threat model v1.

## 12.2 Politique d’inputs

```typescript
interface WorkspaceInputPolicyV1 {
  readonly version: 1;
  readonly includeRoots: readonly string[];
  readonly excludedPatterns: readonly string[];
  readonly includeUntracked: boolean;
  readonly includeIgnored: boolean;
  readonly includeSubmodules: boolean;
}
```

Le terme « fichiers pertinents » NE DOIT PAS être utilisé sans politique déterministe.

## 12.3 Manifeste Git fermé

Le calcul du workspace input digest DOIT couvrir selon la politique :

- OID de HEAD ;
- entrées de l’index ;
- contenu des fichiers tracked modifiés ;
- fichiers untracked inclus ;
- modes exécutables ;
- cibles de symlinks ;
- OID des submodules ;
- politique versionnée pour les ignored/excluded.

```typescript
interface WorkspaceInputCommitmentV1 {
  readonly policy: WorkspaceInputPolicyV1;
  readonly policyDigest: PayloadDigest;
  readonly manifestDigest: PayloadDigest;
}
```

## 12.4 Sémantique

`workspaceInputDigest` est un détecteur de drift, pas un snapshot.

Il NE prouve PAS que tous les lecteurs ont observé les mêmes octets au même instant.

Il DOIT être vérifié :

1. avant dispatch ;
2. avant publication/adoption des soumissions ;
3. avant commit final du join.

Tout écart produit `ConfigurationDriftError`, classée permanente pour l’attempt courant.

---

# 13. Résolution des profils

## 13.1 Principe

Le manifest contient uniquement :

```typescript
{ kind: "worker", profile: "architect-deep" }
```

Le Runner/Pi Adapter résout le profil une seule fois par attempt.

## 13.2 Limite d’autorité

L’API publique actuelle de `pi-subagents` ne fournit pas nécessairement un snapshot complet de la configuration effective de l’agent.

La v1 NE DOIT PAS prétendre posséder un `effectiveAgentDigest` si elle ne peut pas le prouver.

Elle DOIT persister un digest des inputs connus :

```typescript
interface AgentResolverInputsV1 {
  readonly profileName: string;
  readonly profileDefinitionDigest: PayloadDigest;
  readonly agentName: string;
  readonly agentFileDigest?: PayloadDigest;
  readonly knownPiConfigDigest: PayloadDigest;
  readonly toolProfileDigest: PayloadDigest;
  readonly permissionProfileDigest?: PayloadDigest;
  readonly configuredExtensions: readonly string[];
  readonly adapterVersion: string;
  readonly piSubagentsPackagePin: string;
}
```

Nom normatif :

```typescript
agentResolverInputDigest: PayloadDigest;
```

Une future opération publique Pi `resolve-execution-plan` POURRA permettre un snapshot plus fort.

## 13.3 Drift de résolution

Avant un respawn dans le même attempt, le Runner DOIT recalculer les inputs connus.

Si le digest courant diffère du digest engagé :

```text
ConfigurationDriftError
```

Le Runner NE DOIT PAS prétendre reproduire le même attempt.

---

# 14. Spec Pi pré-dispatch

## 14.1 Contexte de groupe

```typescript
interface ResolvedPiGroupContextSpecV1 {
  readonly version: 1;
  readonly adapter: "pi-subagents";
  readonly rpcProtocolVersion: 1;

  readonly context: "fresh";
  readonly workspaceInputDigest: PayloadDigest;

  readonly maxRuntimeMs: number;
  readonly concurrency: number;
  readonly failFast: false;
  readonly artifacts: true;

  readonly turnBudget?: ResolvedTurnBudgetV1;
}
```

`context: "fork"` est interdit en v1, sauf futur snapshot reconstructible explicitement engagé.

## 14.2 Spec par job

```typescript
interface ResolvedPiJobSpecV1 {
  readonly version: 1;
  readonly jobId: string;
  readonly taskDigest: PayloadDigest;

  readonly profileName: string;
  readonly agentName: string;
  readonly agentResolverInputDigest: PayloadDigest;

  readonly modelSelector: string;
  readonly requestedThinking?: ThinkingLevel;

  readonly toolProfile: string;
  readonly toolProfileDigest: PayloadDigest;
  readonly permissionProfileDigest?: PayloadDigest;

  readonly toolBudget?: ResolvedToolBudgetV1;
  readonly acceptance?: ResolvedAcceptancePolicyV1;

  readonly resultContractDigest?: PayloadDigest;
  readonly workspaceInputDigest: PayloadDigest;
}
```

`modelSelector` est la valeur exacte envoyée avant dispatch.

Les valeurs suivantes NE DOIVENT PAS entrer dans le spec :

- modèle réellement utilisé ;
- modèle normalisé après dispatch ;
- fallbacks ;
- attemptedModels ;
- `piRunId` ;
- session concrète ;
- chemins du launch ;
- timestamps.

## 14.3 Spec complet

```typescript
interface ResolvedPiGroupSpecV1 {
  readonly contextSpec: ResolvedPiGroupContextSpecV1;
  readonly jobs: readonly ResolvedPiJobSpecV1[];
}
```

## 14.4 Digests

```text
groupSpecDigest
=
digest(ResolvedPiGroupContextSpecV1)
```

```text
executorSpecDigest(worker job)
=
digest({
  version: 1,
  groupSpecDigest,
  jobSpec
})
```

Définition commune :

> Digest de tous les paramètres pré-dispatch engagés qui gouvernent l’exécution de ce job.

---

# 15. Spec host

```typescript
interface ResolvedHostExecutionSpecV1 {
  readonly version: 1;
  readonly target: "host";
  readonly jobId: string;
  readonly taskDigest: PayloadDigest;
  readonly resultContractDigest?: PayloadDigest;
  readonly workspaceInputDigest: PayloadDigest;
}
```

```text
executorSpecDigest(host)
=
digest(ResolvedHostExecutionSpecV1)
```

La v1 autorise au maximum un job host par workset.

---

# 16. Bindings runtime Pi

Les bindings concrets DOIVENT être séparés du spec reproductible.

```typescript
interface PiExecutionStateV1 {
  readonly groupSpecDigest: PayloadDigest;
  readonly executorSpecDigests: Readonly<Record<string, PayloadDigest>>;

  readonly eligibleLaunchId?: string;
  readonly launches: readonly PiLaunchRecordV1[];
}
```

## 16.1 Launch record

```typescript
type PiLaunchState =
  | "dispatch-intent"
  | "spawned"
  | "completed"
  | "failed"
  | "stopped"
  | "superseded"
  | "orphaned";

interface PiLaunchRecordV1 {
  readonly version: 1;
  readonly launchSequence: number;
  readonly launchId: string;
  readonly executionSpecHash: PayloadDigest;

  readonly state: PiLaunchState;

  readonly sessionRef: string;
  readonly chainDirRef: ArtifactRef;
  readonly rawOutputs: readonly {
    readonly jobId: string;
    readonly rawOutputRef: ArtifactRef;
  }[];

  readonly piRunId?: string;
  readonly executionRef?: ArtifactRef;

  readonly hasAdoptedSubmission: boolean;
  readonly hasCommittedOutcome: boolean;

  readonly dispatchedAtEpochMs: number;
  readonly updatedAtEpochMs: number;
}
```

Les chemins DOIVENT être propres au launch :

```text
workset/<worksetId>/launches/<launchId>/chain/
workset/<worksetId>/launches/<launchId>/raw/<jobId>.json
workset/<worksetId>/launches/<launchId>/observations/
```

Deux launches NE DOIVENT JAMAIS écrire dans les mêmes chemins.

---

# 17. Éligibilité et supersession des launches

## 17.1 Invariant d’unicité

```text
eligibleLaunchId absent
ou
référence exactement un launch dans un état éligible fermé
```

États éligibles :

```typescript
type EligiblePiLaunchState =
  | "dispatch-intent"
  | "spawned"
  | "completed"
  | "failed"
  | "stopped";
```

États non éligibles :

- `superseded` ;
- `orphaned`.

## 17.2 Adoption

Une `PiWorkerJobSubmissionEnvelope` est recevable seulement si :

```text
submission.source.launchId === workset.pi.eligibleLaunchId
```

## 17.3 Interdiction de supersession après adoption

Dès qu’une soumission de ce launch a été adoptée OU qu’un outcome final a été committé :

```text
launch irrévocablement non supersedable
```

Normativement :

```text
hasAdoptedSubmission = true
ou
hasCommittedOutcome = true
→ supersession interdite
```

Cette règle empêche un workset de mélanger des résultats issus de deux exécutions LLM différentes.

## 17.4 Respawn

Le respawn est autorisé uniquement avant toute adoption :

```text
acquire transaction mutex
→ vérifier fence
→ réconcilier le launch éligible
→ aucune soumission adoptée
→ aucune ambiguïté non résolue
→ ancien launch marqué superseded ou orphaned
→ nouveau launch dispatch-intent engagé
→ eligibleLaunchId := nouveau launchId
→ écrire WorksetRecord atomiquement
→ release
→ spawn Pi
```

En cas d’incertitude non résoluble, le Runner DOIT échouer fail-closed au lieu de lancer un second groupe concurrent.

---

# 18. Requête `pi-subagents`

Le chemin v1 DOIT utiliser un seul run async contenant un groupe parallèle statique.

Exemple conceptuel :

```typescript
{
  chain: [{
    phase: "<workset-or-launch-correlation>",
    parallel: [
      {
        agent: "turnlock-architect",
        label: "architecture",
        as: "architecture",
        task: "...",
        model: "<modelSelector>",
        output: "<launch-root>/raw/architecture.json",
        outputMode: "file-only",
      },
      {
        agent: "turnlock-test-reviewer",
        label: "tests",
        as: "tests",
        task: "...",
        model: "<modelSelector>",
        output: "<launch-root>/raw/tests.json",
        outputMode: "file-only",
      },
    ],
    concurrency: 2,
    failFast: false,
  }],
  async: true,
}
```

Le Pi Adapter DOIT laisser `pi-subagents` gérer la concurrence interne.

Turnlock NE DOIT PAS distribuer lui-même des slots child.

---

# 19. Outils, profils et permissions Pi

Les outils effectifs sont accordés par les agents/profils Pi configurés.

Turnlock NE DOIT PAS transmettre une liste arbitraire d’outils donnant de nouvelles capacités à un child.

Mapping recommandé :

```text
profile Turnlock
→ agent Pi configuré
→ tool profile
→ permission profile
→ modelSelector
→ thinking demandé
```

Le Dependency Contract DOIT vérifier que les profils attendus sont disponibles et compatibles.

---

# 20. Handshake Pi

## 20.1 Runtime

Le Pi Adapter DOIT :

1. tenter un `ping` RPC ;
2. appliquer un timeout ;
3. effectuer un retry borné pendant l’initialisation ;
4. vérifier la version de protocole ;
5. vérifier la présence des opérations nécessaires ;
6. échouer fail-closed si incompatibilité.

L’événement `ready` est opportuniste et NE DOIT PAS être l’unique signal autoritatif.

Le handshake runtime ne doit pas prétendre obtenir :

- la version npm complète si elle n’est pas exposée ;
- un snapshot complet des capabilities par tâche ;
- la résolution effective de l’agent.

## 20.2 CI

Les garanties plus fortes proviennent de :

- pin exact de la dépendance ;
- lockfile ;
- Dependency Contract versionné ;
- fixtures `status.json` et events ;
- tests de crash windows ;
- tests de groupes parallèles ;
- tests de stop/interrupt ;
- tests de drift ;
- tests de schémas externes tolérants.

Une suite complète de contract tests NE DOIT PAS s’exécuter au démarrage de chaque session.

---

# 21. Observations d’exécution Pi

Le terme « observation » est préféré à « attestation », car le record est dérivé des artefacts Pi et n’est pas cryptographique.

```typescript
type PiJobTerminalState =
  | "completed"
  | "failed"
  | "stopped";

interface PiJobExecutionObservationV1 {
  readonly version: 1;

  readonly worksetId: string;
  readonly launchId: string;
  readonly jobId: string;

  readonly modelSelector: string;
  readonly attemptedModels: readonly string[];
  readonly actualModel?: string;
  readonly actualThinking?: ThinkingLevel;

  readonly terminalState: PiJobTerminalState;

  readonly piStatusDigest: PayloadDigest;
  readonly piResultDigest?: PayloadDigest;
  readonly observedAtEpochMs: number;
}
```

`paused` n’est PAS terminal.

Un job paused :

- reste non terminal pour all-terminal ;
- doit être repris ou stoppé ;
- peut conduire à `deadline-exceeded` après fermeture d’intake et réconciliation.

---

# 22. Tickets host et script runner-owned

## 22.1 Ticket

```typescript
interface HostSubmissionTicketV1 {
  readonly version: 1;
  readonly ticketId: string;
  readonly turnlockRunId: string;
  readonly delegationId: string;
  readonly attemptId: string;
  readonly worksetId: string;
  readonly jobId: string;
  readonly attempt: number;

  readonly executorSpecDigest: PayloadDigest;
  readonly payloadSchemaHash?: PayloadDigest;
  readonly stagingInputRef: ArtifactRef;

  readonly issuedAtEpochMs: number;
  readonly expiresAtEpochMs: number;
}
```

Le ticket NE DOIT PAS contenir :

- `ownerToken` ;
- `fenceGeneration` comme autorisation ;
- chemin final contrôlé par l’agent ;
- état mutable du workset.

Le hash du ticket DOIT être enregistré préalablement dans le WorksetRecord.

## 22.2 Commande

```bash
turnlock-submit-result --ticket-id '<opaque-id>'
```

Le script résout lui-même :

- le ticket ;
- son chemin d’input ;
- le job ;
- le workset ;
- l’attempt.

L’agent NE DOIT PAS fournir un chemin arbitraire en CLI.

## 22.3 Responsabilités du script

Le script DOIT :

1. résoudre le ticket dans le répertoire Runner ;
2. vérifier son hash ;
3. vérifier son expiration ;
4. acquérir le transaction mutex ;
5. lire le WorksetRecord ;
6. vérifier l’attempt, le job host, l’intake et la deadline ;
7. refuser symlinks et sorties du staging root ;
8. lire un nombre borné d’octets ;
9. parser/valider I-JSON ;
10. calculer le digest JCS ;
11. écrire une soumission immuable ;
12. retourner succès si absente ;
13. retourner succès idempotent si même hash ;
14. retourner erreur si hash divergent ;
15. libérer le mutex.

Le script NE DOIT PAS :

- muter le WorksetRecord hors publication ;
- écrire l’outcome final ;
- décider du join ;
- reprendre Turnlock.

---

# 23. Enveloppes de soumission

## 23.1 Header commun

```typescript
interface JobSubmissionHeaderV1 {
  readonly version: 1;
  readonly turnlockRunId: string;
  readonly delegationId: string;
  readonly attemptId: string;
  readonly worksetId: string;
  readonly jobId: string;

  readonly executorSpecDigest: PayloadDigest;
  readonly manifestDigest: PayloadDigest;
  readonly payloadDigest: PayloadDigest;
  readonly publishedAtEpochMs: number;
}
```

## 23.2 Source

```typescript
type SubmissionSourceV1 =
  | {
      readonly kind: "host";
      readonly ticketId: string;
    }
  | {
      readonly kind: "pi-worker";
      readonly launchId: string;
      readonly piRunId?: string;
    };
```

## 23.3 Enveloppe commune

```typescript
interface BaseJobSubmissionEnvelopeV1 {
  readonly header: JobSubmissionHeaderV1;
  readonly source: SubmissionSourceV1;
  readonly payload: JsonValue;
}

type JobSubmissionEnvelopeV1 =
  | HostJobSubmissionEnvelopeV1
  | PiWorkerJobSubmissionEnvelopeV1;
```

Les soumissions sont non privilégiées. Elles deviennent autoritatives uniquement après adoption par le propriétaire courant.

---

# 24. Adoption des soumissions

Le current owner DOIT adopter sous transaction mutex et fence valide.

Validation Runner :

- `worksetId` ;
- `executorSpecDigest` ;
- `executionRef` ;
- source host ou launch Pi ;
- `eligibleLaunchId` ;
- correspondance du spec résolu ;
- workspace drift ;
- absence d’adoption antérieure divergente ;
- intake semantics ;
- confinement des artefacts.

Après adoption :

- `hasAdoptedSubmission` DOIT devenir vrai pour le launch concerné ;
- le launch ne peut plus être superseded ;
- l’adoption divergente d’un autre payload DOIT échouer.

---

# 25. JobOutcomeEnvelope final

## 25.1 Failure codes fermés

```typescript
type ExecutionFailureCodeV1 =
  | "executor-unavailable"
  | "provider-exhausted"
  | "deadline-exceeded"
  | "cancelled-by-user"
  | "cancelled-by-controller"
  | "budget-exceeded"
  | "invalid-executor-output"
  | "executor-protocol-failure"
  | "configuration-drift"
  | "unknown";
```

`unknown` DOIT être fail-closed.

## 25.2 Enveloppe

```typescript
type JobOutcomeEnvelopeV1<T extends JsonValue = JsonValue> =
  | {
      readonly version: 1;
      readonly status: "success";

      readonly turnlockRunId: string;
      readonly delegationId: string;
      readonly attemptId: string;
      readonly attempt: number;
      readonly worksetId: string;
      readonly jobId: string;

      readonly manifestDigest: PayloadDigest;
      readonly executorSpecDigest: PayloadDigest;

      readonly payload: T;
      readonly payloadDigest: PayloadDigest;
      readonly executionRef: ArtifactRef;
      readonly completedAtEpochMs: number;
    }
  | {
      readonly version: 1;
      readonly status: "failure";

      readonly turnlockRunId: string;
      readonly delegationId: string;
      readonly attemptId: string;
      readonly attempt: number;
      readonly worksetId: string;
      readonly jobId: string;

      readonly manifestDigest: PayloadDigest;
      readonly executorSpecDigest: PayloadDigest;

      readonly failureCode: ExecutionFailureCodeV1;
      readonly message: string;
      readonly executionRef: ArtifactRef;
      readonly diagnosticRef?: ArtifactRef;
      readonly completedAtEpochMs: number;
    };
```

Le message DOIT être borné, recommandé : 200 caractères.

Les diagnostics longs DOIVENT être placés dans un artefact référencé.

## 25.3 Autorité de validation

Le core valide :

- `turnlockRunId` ;
- `delegationId` ;
- `attemptId` ;
- `attempt` ;
- `jobId` ;
- `manifestDigest` ;
- version d’enveloppe ;
- recomputation de `payloadDigest` ;
- cohérence success/failure.

Le Runner valide avant commit :

- `worksetId` ;
- `executorSpecDigest` ;
- `executionRef` ;
- adoption et source ;
- correspondance au launch/spec ;
- fence.

Le core NE DOIT PAS prétendre comparer un `executorSpecDigest` qu’il n’a pas engagé.

---

# 26. Commit final

Le commit final par job DOIT être :

```text
outcome absent
→ write temp
→ fsync si requis par la politique
→ rename atomique vers resultPath
→ succès

outcome présent avec même digest
→ succès idempotent

outcome présent avec digest différent
→ ResultConflictError fatal Runner
```

Après commit :

- `hasCommittedOutcome` devient vrai pour le launch ;
- le launch n’est plus supersedable ;
- le WorksetRecord référence l’outcome ;
- aucune écriture worker directe dans le resultPath final n’est autorisée.

---

# 27. Barrière all-terminal

La barrière est satisfaite lorsque chaque job attendu possède un outcome final committé :

- `success`, ou
- `failure` valide.

`paused` n’est pas terminal.

Le Runner attend des outcomes terminaux, pas uniquement des successes.

Le join NE DOIT PAS dépendre de l’ordre de terminaison Pi.

---

# 28. Agrégation des failures

## 28.1 Mapping fermé

Le core DOIT mapper chaque `failureCode` vers :

```typescript
type RetryClassification = "transient" | "permanent" | "abort";
```

Mapping recommandé v1 :

| Failure code | Classification |
|---|---|
| `executor-unavailable` | transient |
| `provider-exhausted` | transient |
| `deadline-exceeded` | transient |
| `invalid-executor-output` | transient |
| `budget-exceeded` | permanent |
| `executor-protocol-failure` | permanent |
| `configuration-drift` | permanent |
| `cancelled-by-user` | abort |
| `cancelled-by-controller` | selon cause fermée attachée au contrôleur |
| `unknown` | permanent |

## 28.2 Réduction globale

Pour un retry global du batch :

```text
abort présent
→ abort

sinon permanent présent
→ permanent

sinon transient présent
→ transient
```

Un permanent domine un transient parce que la v1 relance tout le batch.

## 28.3 Diagnostic principal

Le `primaryFailure` utilisé pour l’affichage DOIT être choisi par un tri stable :

```text
classification
→ failureCode
→ ordre du manifest ou jobId
```

Il NE DOIT PAS dépendre de l’ordre de terminaison Pi.

---

# 29. `handle-resume` vNext

Le pipeline normatif :

```text
handle-resume
→ présence de tous les resultPath attendus
→ lecture bornée des octets
→ parsing I-JSON strict
→ validation stricte JobOutcomeEnvelope
→ validation des identités core-owned
→ recomputation manifestDigest/payloadDigest
→ enveloppe invalide : fatal protocol error
→ failure outcomes valides : agrégation + retry resolver
→ tous success : unwrap payloads dans l’ordre du manifest
→ dispatch-loop
→ validation Zod métier lazy
```

## 29.1 Enveloppe invalide

Une enveloppe malformée ou étrangère est :

```text
DelegationOutcomeProtocolError fatal
```

Elle NE DOIT PAS devenir un failure outcome normal et NE DOIT PAS déclencher un retry ordinaire.

Motifs fermés :

```typescript
type OutcomeProtocolViolationV1 =
  | "malformed-json"
  | "unsupported-envelope-version"
  | "identity-mismatch"
  | "manifest-digest-mismatch"
  | "payload-digest-mismatch"
  | "incoherent-success-envelope"
  | "incoherent-failure-envelope"
  | "unexpected-job"
  | "duplicate-job-outcome";
```

## 29.2 Payload métier invalide

Une enveloppe success valide contenant un payload rejeté par le schéma métier est un échec de validation métier et suit la politique retry existante du core.

## 29.3 Ordre

Après unwrap, les payloads DOIVENT être remis à la phase dans l’ordre du manifest, indépendamment de l’ordre de fin des executors.

---

# 30. RFC 8785 JCS et digests

## 30.1 Type

```typescript
interface PayloadDigest {
  readonly canonicalization: "rfc8785";
  readonly digestAlgorithm: "sha256";
  readonly value: `sha256:${string}`;
}
```

## 30.2 API depuis octets bruts

```typescript
function parseAndCanonicalizeIJsonRfc8785(
  rawUtf8: Uint8Array,
  limits: JsonInputLimitsV1,
): {
  value: JsonValue;
  canonicalUtf8: Uint8Array;
};
```

Cette API DOIT :

1. borner la taille avant lecture complète ;
2. valider UTF-8 strict ;
3. détecter les propriétés dupliquées avant perte d’information ;
4. valider I-JSON ;
5. rejeter les nombres non interopérables ;
6. rejeter NaN et infinities ;
7. normaliser `-0` selon JCS ;
8. produire les octets RFC 8785 ;
9. laisser SHA-256 à une étape distincte.

Les grands identifiants et entiers exacts DOIVENT être encodés comme strings.

## 30.3 Limites

```typescript
interface JsonInputLimitsV1 {
  readonly maxEnvelopeBytes: number;
  readonly maxPayloadBytes: number;
  readonly maxDiagnosticMessageBytes: number;
  readonly maxDepth: number;
  readonly maxObjectProperties: number;
  readonly maxArrayLength: number;
}
```

## 30.4 Dépendance

La v1 DEVRAIT utiliser une dépendance JCS maintenue, auditée et pinée, complétée par un parser strict si nécessaire.

L’ajout DOIT amender explicitement l’invariant historique « runtime dependencies = Zod + ULID ».

Un ADR DOIT documenter :

- package choisi ;
- licence ;
- maintenance ;
- support des vecteurs RFC ;
- parsing strict ;
- détection des doublons ;
- comportement numérique ;
- pin exact ;
- tests de conformité.

---

# 31. ArtifactRef et confinement

```typescript
type ArtifactRefV1 =
  | {
      readonly kind: "runner-relative";
      readonly path: string;
    }
  | {
      readonly kind: "content-addressed";
      readonly digest: `sha256:${string}`;
    };
```

Pour `runner-relative` :

- chemin relatif uniquement ;
- aucun segment `..` ;
- aucune racine absolue ;
- résolution confinée sous `runnerDir` ;
- refus des symlinks lors de l’ouverture ;
- politique explicite de `realpath` et de race TOCTOU.

`executionRef` et `diagnosticRef` NE DOIVENT PAS être des chemins absolus arbitraires.

---

# 32. Consommation des artefacts Pi

Les schémas externes Pi DOIVENT être extension-tolerant :

- champs inconnus : acceptés ;
- événements inconnus : ignorés ;
- nouvelles propriétés : tolérées.

Mais ils DOIVENT refuser :

- champ requis manquant ;
- type invalide ;
- version incompatible ;
- artefact corrompu ;
- état impossible ;
- état terminal inconnu ;
- transition interdite.

Les artefacts externes NE DOIVENT PAS être validés avec la même politique `.strict()` que les records internes.

Le terminal ou widget Pi NE DOIT PAS être scrapé. Les artefacts machine-readable sont la source de collecte.

---

# 33. Recovery et fenêtres de crash

## 33.1 Avant spawn

```text
WorksetRecord engage launch dispatch-intent
→ crash avant spawn
```

Recovery :

- retrouve le launch éligible `dispatch-intent` ;
- réconcilie les artefacts ;
- ne crée pas immédiatement un nouveau launch ;
- peut spawn si absence prouvée selon Dependency Contract.

## 33.2 Spawn réussi, `piRunId` non persisté

```text
spawn Pi
→ child vivant
→ crash avant persist piRunId
```

Recovery DOIT :

1. scanner les artefacts selon les corrélations engagées ;
2. rechercher un candidat exact ;
3. adopter si un candidat unique ;
4. échouer fail-closed si plusieurs candidats ;
5. respawn uniquement après invalidation explicite du launch précédent.

## 33.3 Soumission publiée, contrôleur crash

La soumission immuable est adoptable par le nouveau propriétaire, même si elle a été publiée sous une génération précédente.

Le worker n’a pas de fence ; seule l’adoption en a un.

## 33.4 Outcome committé, WorksetRecord non mis à jour

Recovery DOIT scanner les outcomes finaux, vérifier leurs digests et reconstruire la référence idempotemment sous mutex.

## 33.5 Join satisfait, crash avant reprise

La reprise par `attemptId` DOIT être idempotente. Le Runner DOIT vérifier l’état avant d’exécuter le `resumeCmd`.

## 33.6 Reprise exécutée, crash avant state `resumed`

Le core et le Runner DOIVENT tolérer une réinvocation stale et l’ignorer ou confirmer l’état sans relancer la FSM de manière divergente.

---

# 34. Adoption fail-closed

Lors de la recherche d’un run Pi existant :

```text
0 candidat exact
→ respawn possible selon politique

1 candidat exact
→ adoption possible

plusieurs candidats
→ AdoptionConflictError
→ quarantaine
→ aucun choix arbitraire
```

Les corrélations PEUVENT inclure :

- `worksetId` ;
- `launchId` ;
- phase/label/as ;
- `chainDirRef` ;
- chemins raw outputs ;
- session ;
- digest du spec ;
- timestamps de fenêtre.

Aucune combinaison heuristique ne doit être présentée comme une clé d’idempotence durable si le Dependency Contract ne le garantit pas.

---

# 35. Timeouts, pause et cancellation

## 35.1 Autorité

| Responsabilité | Propriétaire |
|---|---|
| fallback modèle/provider | pi-subagents |
| relance technique interne | pi-subagents |
| retry métier / nouvel attempt | Turnlock core |
| runtime maximum child | pi-subagents |
| deadline autoritative | Turnlock core |
| stop/interrupt concret | Pi Adapter via pi-subagents |
| reprise FSM | Turnlock core via Runner |

## 35.2 `paused`

`paused` :

- n’est pas terminal ;
- bloque all-terminal ;
- doit être repris ou stoppé ;
- après fermeture d’intake, le contrôleur demande stop/interrupt ;
- l’outcome métier devient généralement `deadline-exceeded` ou une autre cause explicite après réconciliation.

## 35.3 Annulations

La spec DOIT distinguer :

- `cancelled-by-user` → abort ;
- stop dû à deadline → `deadline-exceeded` ;
- stop dû à supersession pré-adoption → diagnostic Runner, pas outcome adopté de l’ancien launch ;
- stop dû à shutdown contrôleur → cause explicite et policy définie.

---

# 36. Threat model

La v1 protège contre :

- erreurs de l’agent ;
- payload malformé ;
- doubles soumissions accidentelles ;
- divergence de contenu ;
- races normales ;
- retries ;
- crashes ;
- contrôleurs obsolètes ;
- launch tardif superseded ;
- drift selon politique ;
- chemins arbitraires involontaires ;
- artefacts Pi étendus mais valides.

La v1 NE protège PAS contre :

- un agent hostile avec shell arbitraire ;
- un processus du même utilisateur capable de modifier directement les données du contrôleur ;
- une compromission de la machine ;
- un provider LLM malveillant ;
- une falsification locale d’artefacts par un acteur ayant les mêmes permissions.

Un custom tool ne crée pas une isolation adversariale si l’agent conserve simultanément un bash capable de modifier les mêmes fichiers.

Une isolation forte nécessiterait :

- utilisateurs système séparés ;
- sandbox/container ;
- broker privilégié ;
- suppression de l’accès shell aux données du contrôleur ;
- canal authentifié.

---

# 37. Garanties et invariants finaux

1. Un seul groupe Pi maximum par workset/attempt.
2. Zéro ou un job host.
3. `context: fresh` uniquement.
4. Groupe Pi et host indépendants dans le même workset.
5. Toute dépendance exige une nouvelle phase Turnlock.
6. Workspace partagé coopérativement read-only pendant le chevauchement.
7. Workspace drift vérifié aux trois frontières définies.
8. Spec pré-dispatch séparé des bindings et observations runtime.
9. Chaque launch possède ses propres chemins.
10. Un seul `eligibleLaunchId`.
11. Un launch superseded ou orphaned ne peut jamais être adopté.
12. Aucune supersession après adoption ou commit.
13. `paused` est non terminal.
14. Host et workers publient sous le même transaction mutex logique.
15. Les workers ne possèdent jamais le fence.
16. Seul le current owner adopte, committe, ferme le join et reprend.
17. Une enveloppe invalide est une erreur protocolaire fatale.
18. Un failure outcome valide passe par l’agrégation et le retry resolver.
19. `handle-resume` ne transmet que les payloads success.
20. Le Runner sélectionne par `attemptId` puis exécute le `resumeCmd` du core.
21. Les outils Pi proviennent de profils configurés, pas d’une requête arbitraire.
22. La concurrence des children appartient à `pi-subagents`.
23. Turnlock n’est pas un scheduler global de subagents.
24. L’exécution concrète est at-least-once.
25. Le commit final est exactly-once logique par job/attempt.
26. L’ordre métier des résultats est celui du manifest.

---

# 38. Préflight v1

Le Runner/Pi Adapter DOIT rejeter avant dispatch :

- plus d’un job host ;
- plus d’un groupe Pi requis ;
- job `direct` non supporté ;
- dépendances internes au workset ;
- `context != fresh` ;
- `failFast != false` ;
- profils inconnus ;
- agent Pi manquant ;
- package Pi absent ou incompatible ;
- RPC sans opérations nécessaires ;
- workspace déjà divergent ;
- deadline insuffisante pour runtime + marge ;
- tool/permission profile non résolu ;
- duplicate job IDs ;
- result paths non déterministes ;
- result contract incohérent ;
- taille maximale incompatible ;
- topologie de workspace non read-only pendant chevauchement.

Aucun fallback LLM automatique n’est permis.

---

# 39. États et transitions du workset

## 39.1 Machine simplifiée

```text
prepared
→ dispatching
→ running
→ collecting
→ committing
→ joined
→ resuming
→ resumed
```

Transitions d’erreur :

```text
prepared|dispatching|running|collecting|committing|resuming
→ failed
```

## 39.2 `prepared → dispatching`

Préconditions :

- manifest validé ;
- specs résolus et engagés ;
- workspace digest vérifié ;
- owner lease valide ;
- intake open ;
- topologie v1 valide.

## 39.3 `dispatching → running`

Préconditions :

- continuation host injectée si host ;
- launch Pi engagé et spawn accepté si workers ;
- bindings persistés.

## 39.4 `running → collecting`

Déclenché lorsqu’au moins une source produit un résultat brut ou un état terminal.

## 39.5 `collecting → committing`

Toutes les sources sont terminales ou la deadline a fermé l’intake ; les soumissions recevables ont été publiées.

## 39.6 `committing → joined`

Tous les jobs ont un JobOutcomeEnvelope final committé.

## 39.7 `joined → resuming`

Le current owner engage l’intention de reprise.

## 39.8 `resuming → resumed`

Le `resumeCmd` du core a été exécuté et la reprise a été réconciliée.

---

# 40. Événements et audit

Le Runner DEVRAIT journaliser des événements immuables :

- `workset.prepared` ;
- `owner.acquired` ;
- `owner.rotated` ;
- `intake.opened` ;
- `host.dispatched` ;
- `pi.launch.intent` ;
- `pi.launch.spawned` ;
- `pi.launch.adopted` ;
- `pi.launch.superseded` ;
- `pi.launch.orphaned` ;
- `submission.published` ;
- `submission.adopted` ;
- `outcome.committed` ;
- `intake.closed` ;
- `workset.joined` ;
- `resume.started` ;
- `resume.completed` ;
- `workset.failed`.

Les événements doivent référencer les identités appropriées sans inclure de secrets.

---

# 41. Tests normatifs

## 41.1 Core

- manifest v3 strict ;
- digest manifest ;
- pendingDelegation v3 ;
- outcome success valide ;
- outcome failure valide ;
- enveloppe malformée fatale ;
- identité étrangère fatale ;
- payload digest mismatch fatal ;
- agrégation abort/permanent/transient ;
- ordre manifest ;
- payload Zod invalide après unwrap ;
- retry crée nouvel attemptId.

## 41.2 Runner ownership

- acquire lease ;
- heartbeat ;
- expiration ;
- rotation génération/token ;
- ancien owner rejeté ;
- transaction mutex récupérable ;
- mutation compare-and-write ;
- script sans privilège propriétaire.

## 41.3 Intake

- publication juste avant deadline ;
- fermeture concurrente ;
- publication après fermeture rejetée ;
- soumission publiée avant fermeture adoptée après recovery ;
- worker raw output avant deadline mais publication après fermeture rejetée ;
- dernier scan sous mutex.

## 41.4 Launches

- un seul eligible launch ;
- crash après dispatch-intent ;
- crash après spawn avant piRunId ;
- adoption candidat unique ;
- plusieurs candidats fail-closed ;
- supersession avant adoption ;
- supersession après adoption rejetée ;
- soumission tardive superseded rejetée ;
- chemins distincts par launch.

## 41.5 Pi Adapter

- handshake ping ;
- protocol mismatch ;
- méthode manquante ;
- un groupe parallèle ;
- failFast false ;
- context fresh ;
- modelSelector transmis ;
- observations attemptedModels ;
- paused non terminal ;
- stop/interrupt ;
- artefacts avec champs inconnus ;
- artefact corrompu rejeté.

## 41.6 Host script

- ticket valide ;
- ticket expiré ;
- mauvais attempt ;
- mauvais job ;
- symlink ;
- path escape ;
- payload trop grand ;
- duplicate keys ;
- JSON invalide ;
- publication idempotente même digest ;
- divergence digest ;
- aucune mutation propriétaire.

## 41.7 RFC 8785

- vecteurs officiels ;
- ordre des clés ;
- Unicode ;
- `-0` ;
- nombres limites ;
- duplicate keys ;
- non-UTF-8 ;
- grands entiers comme strings ;
- limites de profondeur et taille.

## 41.8 Workspace

- HEAD change ;
- index change ;
- tracked modified ;
- untracked inclus ;
- ignored selon policy ;
- executable bit ;
- symlink target ;
- submodule OID ;
- drift avant dispatch ;
- drift avant publication ;
- drift avant join.

## 41.9 E2E

- workers seuls ;
- host seul ;
- host + workers ;
- un worker failure + others success ;
- permanent domine transient ;
- user cancel abort ;
- deadline avec paused ;
- bridge crash ;
- Runner crash ;
- Pi Adapter crash ;
- double reprise ;
- provider fallback ;
- configuration drift ;
- terminal success complet.

---

# 42. Amendements requis aux documents existants

## 42.1 TURNLOCK-BINDINGS

Ajouter :

- `DelegationTargetV1` ;
- cible par job ;
- restriction topologique v1 ;
- résultat enveloppé.

## 42.2 TURNLOCK-MANIFEST

Créer manifest v3 :

- nouvelles identités ;
- target neutre ;
- envelope version ;
- deadline ;
- resumeCmd ;
- digest externe engagé dans state.

## 42.3 TURNLOCK-STATE-IO

Ajouter à `pendingDelegation` :

- `delegationId` ;
- `attemptId` ;
- `manifestVersion` ;
- `manifestDigest` ;
- `resultEnvelopeVersion`.

## 42.4 TURNLOCK-HANDLE-RESUME

Modifier pour :

- lire les envelopes ;
- distinguer protocol error et execution failure ;
- recomputer digests ;
- agréger failures ;
- unwrap successes ;
- conserver validation métier lazy.

## 42.5 TURNLOCK-ERRORS

Ajouter :

- `DelegationOutcomeProtocolError` ;
- `AdoptionConflictError` ;
- `ConfigurationDriftError` ;
- `ResultConflictError` ;
- `UnsupportedWorksetTopologyError` ;
- `PiDependencyContractError` ;
- `StaleOwnerError`.

## 42.6 TURNLOCK-RETRY

Ajouter :

- mapping failureCode → classification ;
- réduction globale ;
- nouvel attemptId ;
- diagnostic stable.

## 42.7 TURNLOCK-RUNNERS

Ajouter :

- AttemptRecord ;
- WorksetRecord ;
- owner lease/fence ;
- transaction mutex ;
- intake ;
- adoption ;
- exact-once commit ;
- `--resume-attempt` ;
- recovery windows.

## 42.8 TURNLOCK-PI-ADAPTER

Créer une spec distincte pour :

- pin `pi-subagents` ;
- handshake ;
- mapping profils ;
- ResolvedPiGroupSpec ;
- launches ;
- observations ;
- collecte artefacts ;
- worker submissions ;
- stop/recovery ;
- Dependency Contract.

---

# 43. ADR requis

1. **ADR-JCS** : parser strict, RFC 8785, SHA-256, limites et dépendance.
2. **ADR-IDENTITIES** : portée et génération des IDs.
3. **ADR-WORKSPACE-DIGEST** : manifeste Git et politique d’inclusion.
4. **ADR-PI-DEPENDENCY-CONTRACT** : version pinée, surfaces publiques, fixtures.
5. **ADR-RUNNER-LOCKING** : lease, transaction mutex, récupération.
6. **ADR-ARTIFACT-REFS** : confinement, content-addressing, symlink policy.
7. **ADR-RESULT-COMMIT** : immutabilité, fsync/rename et conflit.
8. **ADR-THREAT-MODEL** : confiance coopérative et limites.

---

# 44. Ordre d’implémentation recommandé

## Étape 1 — Fondations core

- identités ;
- manifest v3 ;
- pendingDelegation v3 ;
- PayloadDigest ;
- outcome envelope ;
- handle-resume vNext ;
- retry aggregation.

## Étape 2 — Runner workset

- AttemptRecord ;
- WorksetRecord ;
- owner lease ;
- transaction mutex ;
- intake ;
- outcome commit ;
- `--resume-attempt`.

## Étape 3 — Workspace et digests

- policy ;
- manifeste Git ;
- JCS strict ;
- drift checks ;
- ArtifactRef.

## Étape 4 — Host path

- host spec ;
- ticket ;
- script ;
- host submission ;
- adoption.

## Étape 5 — Pi Adapter

- handshake ;
- profile resolution ;
- spec/group digest ;
- launch record ;
- one eligible launch ;
- single parallel group ;
- observations ;
- worker submission ;
- stop/recovery.

## Étape 6 — Crash testing

- toutes les fenêtres de crash ;
- ambiguity fail-closed ;
- double resume ;
- late submissions ;
- drift ;
- supersession.

## Étape 7 — Migration et documentation

- migration manifest v2 → v3 ;
- mise à jour des runners ;
- guide profiles Pi ;
- examples ;
- ADR finalisés.

---

# 45. Exemple complet

## 45.1 Manifest neutre

```json
{
  "manifestVersion": 3,
  "turnlockRunId": "run_01",
  "delegationId": "dlg_review",
  "attemptId": "att_01",
  "attempt": 0,
  "orchestratorName": "loop-clean",
  "label": "review",
  "kind": "batch",
  "jobs": [
    {
      "id": "requirements",
      "prompt": "Review the requirements.",
      "target": { "kind": "host" },
      "resultPath": "/run/results/review-0/requirements.json"
    },
    {
      "id": "architecture",
      "prompt": "Review the architecture.",
      "target": { "kind": "worker", "profile": "architect-deep" },
      "resultPath": "/run/results/review-0/architecture.json"
    },
    {
      "id": "tests",
      "prompt": "Review the tests.",
      "target": { "kind": "worker", "profile": "test-review" },
      "resultPath": "/run/results/review-0/tests.json"
    }
  ],
  "resultEnvelopeVersion": 1,
  "deadlineAtEpochMs": 1784670000000,
  "resumeCmd": "bun run pipeline.ts --run-id run_01 --resume"
}
```

## 45.2 Résolution Runner

```text
host requirements
→ ResolvedHostExecutionSpecV1
→ executorSpecDigest host

worker architecture/tests
→ ResolvedPiGroupContextSpecV1
→ ResolvedPiJobSpecV1 x2
→ groupSpecDigest
→ executorSpecDigest par job
```

## 45.3 Dispatch

```text
WorksetRecord prepared
→ owner valide
→ workspace digest vérifié
→ intake open
→ launch_01 dispatch-intent engagé
→ eligibleLaunchId = launch_01
→ continuation host injectée
→ groupe Pi async lancé
```

## 45.4 Soumissions

```text
host payload
→ script
→ HostJobSubmissionEnvelope sous mutex

Pi raw outputs
→ Adapter
→ PiWorkerJobSubmissionEnvelope x2 sous mutex
```

## 45.5 Adoption et outcomes

```text
current owner
→ adopte requirements
→ adopte architecture
→ adopte tests
→ commit JobOutcomeEnvelope x3
→ all-terminal
```

## 45.6 Resume

```text
agent-runner --resume-attempt att_01
→ charge AttemptRecord
→ vérifie pendingDelegation.attemptId
→ exécute resumeCmd
→ handle-resume valide envelopes
→ unwrap payloads selon ordre manifest
→ validation métier
→ phase suivante ou retry
```

---

# 46. Décisions explicitement rejetées

Les décisions suivantes sont rejetées pour la v1 :

- `pendingWorkset` dans le core ;
- `--resume-workset` ;
- main agent comme scheduler ;
- N spawns Pi indépendants par défaut ;
- scheduler global Turnlock de children ;
- plusieurs groupes Pi dans un workset ;
- plusieurs hosts ;
- custom tool obligatoire ;
- fence transmis au worker ;
- worker écrivant le resultPath final ;
- `retryable: boolean` autoritatif produit par le Runner ;
- parsing terminal/widget ;
- `context: fork` non snapshoté ;
- effective-agent digest non prouvable ;
- chemins staging partagés entre launches ;
- première fin observée gagnante ;
- supersession après adoption ;
- `paused` considéré terminal ;
- canonicalisation JSON maison ;
- hash d’objet JS après perte des duplicate keys ;
- fallback main-agent-spawns-workers automatique.

---

# 47. Conclusion normative

L’architecture gelée repose sur cinq artefacts distincts :

```text
ResolvedPiGroupSpec
→ inputs connus et engagés avant dispatch

PiLaunchRecord
→ session, paths et processus concrets

PiJobExecutionObservation
→ comportement réellement observé

JobSubmissionEnvelope
→ publication non privilégiée sous intake

JobOutcomeEnvelope
→ résultat adopté et committé par le propriétaire
```

La séparation finale est :

```text
Core
→ délégation logique, protocole outcome, retry et métier

Runner
→ workset, ownership, intake, adoption, commit et reprise

Pi Adapter
→ résolution connue, traduction, collecte et observations

Workers
→ soumissions non privilégiées

pi-subagents
→ scheduling et lifecycle des children
```

Aucune nouvelle couche architecturale n’est requise. Le travail restant est :

- formaliser les schémas exacts ;
- définir les transitions atomiques ;
- implémenter les ADR ;
- amender les specs existantes ;
- construire les contract tests et tests de crash.

**Statut final : ready for normative implementation specification.**
