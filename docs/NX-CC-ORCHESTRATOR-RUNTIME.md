---
id: NX-CC-ORCHESTRATOR-RUNTIME
version: "0.8.0"
scope: cc-orchestrator-runtime
status: approved
---

# NX-CC-ORCHESTRATOR-RUNTIME — Concept consolidé

**Statut** : v0.8 — correction blocker lock/resume (lock = process-alive, release systématique) + RetryPolicy persistée + events.ndjson owner-only + cosmétique protocole, prêt pour éclatement NIBs

**Date** : 2026-04-19

**Package** : `cc-orchestrator-runtime`

**Auteur primaire** : Fanilo Sendrison

**Triangulation** : Claude Sonnet 4.7 (session dotclaude) + revue Fanilo (v0.1 → v0.2) + analyse du paysage existant (loop-clean, backlog-crush, senior-review)

---

## 1. Contexte et problème

### 1.1 Constat

L'écosystème `~/.claude/skills/` de Fanilo contient plusieurs skills dont l'exécution est **orchestrale** : ils enchaînent plusieurs sous-étapes, combinant travail mécanique (énumération de fichiers, filtrage, consolidation de JSON) et travail sémantique (review hostile, analyse de duplication, classification de findings).

Deux archétypes coexistent aujourd'hui :

**Archétype A — Orchestration par l'agent LLM** (`senior-review`, `dedup-codebase`, `fix-or-backlog` dans leur forme actuelle) : le `SKILL.md` contient une procédure en langue naturelle (identifier les fichiers, filtrer, lancer N sub-agents, consolider, décider). L'agent LLM parent lit et exécute step by step, en prenant des décisions à chaque étape. La mécanique de flux repose sur le raisonnement du modèle.

**Archétype B — Orchestration par script bash** (`loop-clean`, `backlog-crush`) : le skill délègue à un script bash (`loop-clean.sh` = ~28 Ko) qui porte toute la logique de flux (init, prepare_iter, decide, finalize). L'agent LLM exécute les étapes cognitives (appeler un skill, lire son résultat, écrire le JSON) mais **la séquence et les conditions d'arrêt sont déterministes**, portées par le script.

### 1.2 Analyse des deux archétypes

**Archétype A (LLM-orchestré)** :
- Simple à écrire initialement (juste du markdown en procédure)
- Le LLM peut rater une étape, sérialiser ce qui devait être parallèle, mal consolider un JSON
- Les "mêmes entrées" ne produisent pas forcément les "mêmes sorties" : variance stochastique à chaque invocation
- Quand l'orchestrateur est au cœur d'un système (loop-clean contient senior-review qui contient…), la variance se compose et devient une source de bugs
- Aucun retry automatique si un sub-agent rend un résultat malformé — le LLM orchestrateur improvise

**Archétype B (script-orchestré)** :
- Le flux est déterministe : mêmes entrées → mêmes décisions de flux
- Mais bash + jq est douloureux pour les orchestrateurs complexes qui manipulent du JSON (filtrage, merge, dédup, schema validation)
- `loop-clean.sh` à 28 Ko est déjà à la limite de lisibilité
- Chaque orchestrateur réimplémente : atomic writes, gestion du RUN_DIR, cleanup des vieilles runs, détection d'oscillation, émission de signaux, parsing des retours LLM
- Les nouveaux orchestrateurs complexes (senior-review, dedup-codebase) sont **impossibles** à écrire proprement en bash pur à cause du volume de manipulation JSON

### 1.3 Le problème réel

Fanilo veut passer tous ses orchestrateurs (existants et futurs) sur l'Archétype B, **mais avec un langage adapté à leur complexité** (TypeScript), **sans réécrire à la main la plomberie commune** (state durable, retry, timeout, émission de protocole, validation schema, logs).

Sans package mutualisé :
- Chaque nouvel orchestrateur de la famille review/fix (senior-review, dedup-codebase, fix-or-backlog, spec-drift, backlog-crush v2, etc.) réimplémente ~500 lignes de plomberie
- Les bugs subtils (race sur écriture d'état, erreur transient non retryée, schema invalide consommé sans validation) se multiplient
- La discipline "séparation décision mécanique / décision sémantique" (Archétype B) devient difficile à tenir parce que l'effort d'implémentation dépasse l'effort de "laisser le LLM faire"
- La composition récursive (orchestrateur qui invoque orchestrateur) n'a pas de contrat stable

### 1.4 Positionnement dans l'écosystème

`cc-orchestrator-runtime` est une **brique d'infrastructure** pour le tooling personnel de Fanilo sur Claude Code. Il n'est pas lié à un produit VegaCorp particulier. Il est consommé par tous les orchestrateurs qui vivent dans `~/.claude/scripts/<name>/` (ou équivalent) et qui sont déclenchés par un skill dans `~/.claude/skills/<name>/`.

Le nom `cc-orchestrator-runtime` est délibéré :
- `cc` = Claude Code (contexte d'exécution obligatoire)
- `orchestrator` = la promesse fonctionnelle (orchestration de phases)
- `runtime` = la nature technique (lib in-process, pas un service)

### 1.5 Distinction explicite avec `@vegacorp/llm-runtime`

`@vegacorp/llm-runtime` est un runtime provider-agnostique pour appels LLM directs (HTTP vers Anthropic, OpenAI, Google, etc.). Il est model-agnostique et tourne n'importe où.

`cc-orchestrator-runtime` est **strictement Claude-Code-dépendant** : sa primitive de délégation (signal + re-entry) n'a de sens qu'à l'intérieur d'une session Claude Code où un agent parent lit stdout et peut invoquer `Skill` et `Agent` tools. Sorti de ce contexte, le runtime ne peut rien faire.

Les deux runtimes peuvent coexister dans un même projet. Un orchestrateur `cc-orchestrator-runtime` pourrait, en théorie, utiliser `llm-runtime` pour une étape qui doit faire un call LLM direct (hors du pattern skill/agent). Ce cas n'est pas ciblé v1 mais n'est pas interdit.

### 1.6 Distinction explicite avec Temporal / Inngest / Trigger.dev

Des workflow engines existent (Temporal, Inngest, Trigger.dev, Restate). Ils offrent durable execution, retry, timeout, signals, etc. `cc-orchestrator-runtime` en reprend les **concepts** (state durable, retry policies, materialized decisions) mais **pas la forme** :

- Temporal & co. requièrent un serveur externe (ou un cloud). Incompatible avec la contrainte "tout se passe dans la session Claude Code".
- Leur primitive de délégation est un appel RPC à une `activity` qui tourne sur un worker. Ici la primitive est **l'émission d'un signal vers un agent parent qui invoque un skill/agent**.
- Leur échelle cible est 10k+ workflows/jour. Ici l'échelle est ~10-100 runs/jour sur une machine unique.

`cc-orchestrator-runtime` est un **mini-Temporal taillé pour la primitive Claude Code**, in-process, sans serveur, sans coordination distribuée.

**Divergence architecturale essentielle — snapshot-based vs event-sourced**

Temporal impose un **pur event sourcing** : `state = f(events)`, aucun snapshot persisté. Leur worker rejoue l'`Event History` depuis le début à chaque task, les activities retournent leur résultat enregistré au lieu de ré-exécuter. Le sticky cache RAM est une optimisation, jamais une source de vérité. Cette discipline requiert des workflows **déterministes par contrainte** (émettent des commandes, pas des mutations libres de state).

`cc-orchestrator-runtime` **ne fait pas ce choix**. Les phases sont du TS arbitraire qui retourne un `PhaseResult.nextState` calculé librement (§6.2, §6.4). Aucune contrainte "command/event" à la Redux. Conséquence : le pur event sourcing Temporal n'est **pas applicable** sans changer la sémantique des phases — ce qui n'est ni v1, ni v2.

Le runtime utilise un modèle **snapshot-authoritative** : `state.json` écrasé à chaque transition est la source de vérité unique. `events.ndjson` (ajouté v0.3) sert d'audit trail du flux, pas de source reconstructible.

**Table d'équivalence conceptuelle** (pour qui connaît Temporal) :

| Concept Temporal | Équivalent cc-orchestrator-runtime | Source de vérité ? |
|---|---|---|
| Workflow | `runOrchestrator` + `state.json` | oui |
| Activity | `DelegationRequest` (skill/agent/agent-batch) | — |
| Task Queue | Protocole `@@CC_ORCH@@` + agent parent | — |
| Event History (disk append-only) | `events.ndjson` (v0.3, §7.5, §11.7) | **non, audit trail seulement** |
| Sticky cache (RAM, non persisté) | `state.json` (disk, écrasé — source autoritative) | **oui, source de vérité unique** |
| Retry policy | `RetryPolicy` + `resolveRetryDecision` | — |
| Timeout + deadline cross-process | `deadlineAtEpochMs` wall-clock | — |
| Signals (inbox pattern) | — (deferred v2, §3.2) | — |
| Continue-as-new | — (deferred v2, §3.2) | — |
| Heartbeats | inapplicable (process déjà mort pendant la délégation) | — |
| Replay determinism enforcement | inapplicable (phases non déterministes by design) | — |
| Versioning / patches | inapplicable (évolution par rewrite, §17) | — |

Cette divergence n'est pas un manque : c'est une **décision de design assumée** (voir §4.12). Le pur event sourcing paierait le coût de la contrainte sur les phases sans bénéfice à cette échelle.

---

## 2. Pourquoi un package mutualisé

### 2.1 Le besoin est transversal et stable

Tous les orchestrateurs de la famille review/fix partagent les mêmes besoins mécaniques :

- Organiser l'exécution en **phases** nommées séquentielles
- Persister l'état entre phases (atomic writes)
- Charger l'état au démarrage pour savoir quelle phase exécuter
- Déléguer une étape sémantique à un skill, un agent, ou un batch d'agents
- Attendre le résultat (par re-entry après signal à l'agent parent)
- Valider le résultat contre un schéma
- Retry automatique sur résultat invalide ou timeout
- Classifier les erreurs (transient vs fatal)
- Logger structuré corrélé par `run_id`
- Émettre un verdict final au parent

Ces besoins ne dépendent pas du domaine métier (review, dedup, fix). Un orchestrateur de review hostile et un orchestrateur de dedup code ont **exactement les mêmes besoins bas niveau**.

### 2.2 Les invariants sont mécaniques

Toutes les opérations du runtime sont purement mécaniques et déterministes. Aucune interprétation sémantique — le runtime ne décide jamais ce qu'il faut faire, seulement comment l'exécuter proprement. C'est précisément ce genre de couche qui mérite d'être extraite.

### 2.3 Le coût d'extraction est faible, le bénéfice est composant

**Coût d'extraction** : ~1500-2000 lignes TS + tests. 2-3 sessions de travail.

**Bénéfice** : chaque nouvel orchestrateur (senior-review V2, dedup-codebase V2, fix-or-backlog V2, puis tous les futurs) économise ~500 lignes de plomberie et hérite automatiquement de toutes les améliorations. Dès le 2ᵉ consommateur le runtime est rentabilisé.

### 2.4 L'alternative (ne pas extraire) est inacceptable

Ne pas extraire signifie :
- Écrire senior-review avec sa propre plomberie (state, retry, timeout, protocole, validation)
- Écrire dedup-codebase avec sa propre plomberie, divergente sur les détails
- Multiplier les bugs subtils
- Rendre impossible la composition récursive stable (orchestrateur qui invoque orchestrateur)
- Laisser les orchestrateurs complexes en Archétype A (LLM-orchestré), avec la variance que ça induit au cœur du système review/fix

Cette trajectoire est incompatible avec l'ambition de Fanilo de construire un système de review/fix fiable et prévisible.

---

## 3. Domaine couvert et non-couvert

### 3.1 Ce que `cc-orchestrator-runtime` fait (v1)

- Exécution d'un orchestrateur structuré en **phases** nommées avec transitions explicites
- Persistence **atomique** de l'état entre phases (tmp + rename)
- Chargement de l'état au démarrage pour reprise à la phase courante
- **Délégation** vers un skill (`delegateSkill`), un sub-agent (`delegateAgent`), ou un batch parallèle de sub-agents (`delegateAgentBatch`)
- Émission d'un **protocole de signal** standardisé sur stdout (bloc `@@CC_ORCH@@ ... @@END@@`)
- **Validation lazy contrôlée** des résultats de délégation : la phase `resumeAt` appelle `io.consumePendingResult(schema)` (ou `io.consumePendingBatchResults(schema)` pour un batch) qui lit et valide contre un schéma `zod` fourni. Le runtime enforce la consommation **exactly once** par la phase de reprise (voir §14.2 et §16.5). Pas de validation eager en v1 — les schémas vivent dans le code de la phase, pas dans le state.
- **Retry** automatique avec backoff exponentiel sur résultat invalide, timeout de délégation, ou erreur transiente
- **Timeout** par délégation (le sub-agent doit écrire son résultat dans le délai imparti)
- **Classification** des erreurs (transient retriable / permanent fatal)
- **Observabilité** structurée via events NDJSON sur stderr, corrélés par `run_id`
- **Event log append-only persistant** (`$RUN_DIR/events.ndjson`, v0.3) : double-écriture de chaque event, audit trail du **flux** du run (phases, délégations, retries, erreurs). **Ne contient pas** `state.data` — voir §4.12 pour le rationale snapshot-based vs event-sourced.
- **Cleanup** automatique des anciennes runs (rétention configurable)
- **Abort** propagé (SIGINT / SIGTERM → exit propre, état sauvé)
- **Composition récursive** : un orchestrateur peut déléguer vers un skill qui lui-même lance un orchestrateur (skill boundary)

### 3.2 Ce que `cc-orchestrator-runtime` NE fait PAS (frontière dure v1)

- **Exécution hors session Claude Code** : le runtime suppose un agent parent qui lit stdout et invoque `Skill`/`Agent` tools. Sans ça, le protocole de délégation ne peut pas aboutir. Pas de mode "headless".
- **Call LLM direct** : le runtime ne fait pas d'appel HTTP à Anthropic/OpenAI/etc. Pour ça, consommer `llm-runtime` à l'intérieur d'une phase si besoin. Hors scope v1.
- **Scheduling / cron** : le runtime est déclenché par une invocation externe (skill utilisateur, autre orchestrateur). Il ne planifie rien lui-même. Pour du cron, voir le skill `schedule` séparé.
- **IPC distribué** : le runtime est strictement process-local et session-local. Deux sessions Claude Code en parallèle ne partagent rien.
- **Multi-process parallèle sur un même run_id** : un seul process à la fois par `run_id`, enforced via lock file `$RUN_DIR/.lock` (§4.13). Deux processes concurrents sur des `run_id` différents (ou des repos différents) sont libres et n'interfèrent pas — chemins RUN_DIR disjoints, locks disjoints.
- **Streaming de phase** : une phase retourne un résultat complet ou délègue. Pas de streaming intermédiaire.
- **Resume après kill dur** (SIGKILL) : si le process meurt sans pouvoir écrire son état final, la reprise n'est pas garantie. Couvert v2.
- **Circuit breaker** : pas de "cet orchestrateur a échoué N fois aujourd'hui, je refuse de le relancer". Out of scope v1.
- **Visibility UI** : pas de dashboard. L'inspection se fait via les fichiers `.claude/run/cc-orch/<name>/<run-id>/` et les events stderr.
- **Versioning de workflow** : migrer des runs en vol vers du nouveau code = hors scope. Les orchestrateurs évoluent par rewrite.
- **Compensation / saga pattern** : pas de rollback multi-step intégré. Si une phase a des effets de bord irréversibles, l'auteur gère le rollback dans son code.
- **Replay determinism enforcement** : le runtime suppose que les phases sont idempotentes et déterministes (discipline de l'auteur), mais ne vérifie pas cette propriété par replay.
- **Event sourcing pur type Temporal** : inapplicable par design — les phases calculent `nextState` librement, pas via commandes déterministes (§1.6, §4.12). `state.json` reste source de vérité autoritative unique.

### 3.2.bis Extensions v2 explicitement scoped (mentionnées pour planning)

Deux extensions identifiées comme utiles à terme mais **pas v1**. Listées ici pour que leur absence soit une décision, pas un oubli.

- **Signals applicatifs (inbox pattern)** — équivalent des Temporal Signals. Permettrait au parent agent d'injecter une commande asynchrone dans un run en cours (ex: `"skip ce fichier"`, `"abort gracefully"`) via un fichier `$RUN_DIR/signals/<seq>.json` que le runtime lit au re-entry. Nouvelle primitive : `io.drainSignals(schema): Signal[]` avec règle exact-once par signal seq.

  **Trigger d'activation v2** : premier orchestrateur qui a un cas concret d'injection runtime (aucun aujourd'hui). Aucun breaking change attendu — extension propre de l'API.

- **Continue-as-new** — équivalent du Temporal `ContinueAsNew`. Permettrait à un orchestrateur long (ex: `backlog-crush` avec 40+ cycles) de reset son run avec `state.data` courant comme nouvelle graine, purgeant l'historique des délégations accumulées. Nouvelle primitive : `io.continueAsNew(nextState)` émettant `@@CC_ORCH@@ action: CONTINUE` + `resume_cmd` avec nouveau `run_id`.

  **Trigger d'activation v2** : premier orchestrateur qui dépasse ~20 cycles avec state.json qui grossit ou RUN_DIR saturé. Aucun breaking change attendu.

Ces deux extensions sont **cohérentes avec la philosophie snapshot-based** (§4.12) : ni l'une ni l'autre n'exigerait un passage à event sourcing pur.

### 3.3 Chaque exclusion est explicite, pas implicite

Toute future demande d'ajouter une feature listée en §3.2 doit :

1. Ouvrir un NX séparé justifiant le besoin et l'architecture
2. Définir l'impact sur la surface publique (breaking change ou non)
3. Être validée avant implémentation

Cette règle empêche la dérive feature-creep.

---

## 4. Invariants architecturaux

### 4.1 Séparation décision mécanique / décision sémantique

Le runtime **n'incarne jamais de décision sémantique**. Toute décision sémantique (qu'est-ce qu'un bon code, quels fichiers faut-il reviewer, comment classifier ce finding) est déléguée à un skill ou un agent via le protocole de délégation. Le runtime gère uniquement :

- Le **flux** (quelle phase exécuter ensuite)
- L'**état** (qu'est-ce qu'on a déjà fait, quels résultats on a accumulés)
- La **validation** (le résultat reçu respecte-t-il le schéma)
- La **résilience** (retry sur erreur transiente, timeout respecté)

L'auteur d'un orchestrateur écrit :
- Des phases **mécaniques** : fonctions pures TS qui calculent, filtrent, transforment, consolident (pas de call LLM)
- Des phases **de délégation** : fonctions qui retournent un `DelegationRequest` vers un skill/agent, sans connaître la logique du skill/agent

### 4.2 Re-entry comme primitive de délégation

Le runtime tourne **dans un process transitoire**. Une invocation du programme = un run partiel d'une ou plusieurs phases, jusqu'à une demande de délégation ou une terminaison. Le process exit dès qu'il a émis `@@CC_ORCH@@` (délégation) ou `@@CC_ORCH@@ ... action: DONE` (terminaison).

L'agent parent relance le programme après chaque délégation terminée. Le programme lit son état sur disque, reprend à la phase suivante.

**Conséquence normative** : tout state orchestrateur doit être JSON-sérialisable. Pas de closures survivantes, pas de `Map`/`Set` non-sérialisés, pas de références à des objets non-clonables (streams, sockets, handles).

### 4.3 Atomicité de l'écriture d'état

Toute écriture de fichier de state, de manifest de délégation, ou de résultat final passe par le pattern "tmp + rename" :

```
write("state.json.tmp", content)
rename("state.json.tmp", "state.json")
```

`rename` est atomique sur un même filesystem POSIX. Le process ne peut pas mourir entre les deux étapes de `rename`. Un `state.json` partiellement écrit ne peut jamais être lu par une re-entry.

### 4.4 Fail-closed

Toute erreur → exit avec code ≠ 0 + émission `@@CC_ORCH@@ action: ERROR`. Le runtime ne retourne jamais de résultat dégradé. Si un schéma de résultat échoue après épuisement des retries, le runtime émet ERROR. Si un timeout survient, idem.

**Règle "préflight errors émettent aussi ERROR"** : les erreurs survenant **avant** que le flow nominal ait pu démarrer (config invalide, state absent ou corrompu au resume, mismatch runId/orchestratorName entre argv et state.json) émettent **également** un bloc `@@CC_ORCH@@ action: ERROR`, avec `run_id: null` si le runId n'a pas encore été généré/adopté, et `orchestrator: <nom connu>` (toujours disponible depuis `config.name` avant même la validation). Aucun throw brut ne remonte depuis `runOrchestrator()`. Le parent agent n'a qu'un seul chemin de traitement d'erreur : lire le bloc protocole.

**"throw" dans les flows §14 — sémantique runtime** (v0.7) : les mentions `throw X` dans les pseudo-codes des flows (§14.1, §14.2) désignent un **throw interne capturé par le top-level `try/catch` de `runOrchestrator`**. Ce top-level handler convertit tout throw en bloc `@@CC_ORCH@@ action: ERROR` + `exit(code)`. La Promise retournée par `runOrchestrator()` **ne rejette jamais** à l'appelant — elle résout uniquement quand le process exit (ou le process meurt via exit sans résolution de Promise, comportement standard Node). Aucun throw n'échappe à la frontière de `runOrchestrator`.

Conséquence pour les tests (§19) : vérifier qu'un **bloc ERROR est émis sur stdout** (parseable par le parent agent) ET que l'exit code est ≠ 0, **pas** qu'une exception TS remonte à l'appelant direct de `runOrchestrator()`.

### 4.5 Déterminisme mécanique

Le retry-resolver, le validator, le signal-emitter, le state-loader, le clock (sous mock), sont tous des fonctions pures ou bien isolées. Étant données les mêmes entrées, elles produisent les mêmes sorties.

**Formulation canonique** : le runtime est une composition déterministe de décisions pures et d'effets isolés.

### 4.6 Observabilité obligatoire

**Définition d'un "run"** (v0.7) : un run est marqué par l'émission de `orchestrator_start` au début et `orchestrator_end` à la fin. Les deux events constituent les bornes observables du run.

**Préflight errors ne sont PAS un run** : les erreurs survenant avant l'acquire du lock (config invalide, state manquant/corrompu au resume, mismatch runId/orchestratorName) n'émettent ni `orchestrator_start` ni `orchestrator_end`. Elles émettent uniquement le bloc protocole `@@CC_ORCH@@ action: ERROR` sur stdout (§4.4). Raison : à ce stade, le RUN_DIR n'est pas nécessairement résolu → pas de `events.ndjson` persistable, pas de run_id dans certains cas.

**Garantie v0.7 (affaiblie proprement)** : pour tout run ayant émis `orchestrator_start`, un `orchestrator_end` correspondant sera émis. Les preflight errors émettent le protocole ERROR mais bypass la taxonomie events.

Chaque **run complet** produit au minimum :

- 1 événement `orchestrator_start` (émis après acquire du lock, RUN_DIR résolu, state chargé/créé)
- N événements `phase_start`
- N événements `phase_end`
- 0..N événements `delegation_emit`
- 0..N événements `delegation_result_read`
- 0..N-1 événements `retry_scheduled`
- 0..N événements `phase_error` (erreurs non-fatales)
- 1 événement `orchestrator_end` (résumé terminal)

Tous corrélables par `run_id` (ULID généré/adopté avant `orchestrator_start`, persisté dans state).

### 4.7 Abort propagé

Tout signal OS (`SIGINT`, `SIGTERM`) reçu par le process interrompt la phase en cours proprement : flush des logs, sauvegarde de l'état à la dernière transition stable, émission `@@CC_ORCH@@ action: ABORTED`, exit code 130 (SIGINT) ou 143 (SIGTERM).

### 4.8 Configuration figée au run-init

L'orchestrateur déclare ses `phases`, ses policies par défaut (retry, timeout, validation), et son nom au moment du `runOrchestrator(config)`. Une fois le run démarré, ces valeurs sont figées pour toute la durée du run. Les phases peuvent override par délégation individuelle, pas globalement.

### 4.9 Surface publique petite et stable

Le contrat public (`runOrchestrator`, `Phase`, `PhaseIO`, `PhaseResult`, `DelegationRequest` variants, erreurs, policies) est minimal et versionné en semver strict. Toute modification breaking = major bump. Les helpers exotiques vivent dans des sous-modules séparés ou hors runtime.

**Gouvernance pré-1.0** : tant que le package est en 0.x, les changements breaking sur la surface publique sont autorisés (convention SemVer). Le changelog doit explicitement marquer `[BREAKING]` chaque entrée qui modifie la surface publique, même en 0.x, pour qu'un consommateur post-1.0 puisse reconstruire l'historique d'API. À partir de v1.0, toute modification breaking exige un major bump — cette règle devient stricte et non négociable.

### 4.10 JSON-only state

Tout state persisté est du JSON. Pas de format binaire, pas de SQLite, pas de Protobuf. Motivation : transparence et debugabilité (un développeur peut ouvrir `state.json` et comprendre où en est le run). Extension vers autre format = breaking change documenté.

### 4.11 Single process per run — mécaniquement enforced via lock

Un `run_id` correspond à **un seul process actif à la fois**. Cette règle est enforced mécaniquement via un **lock file** à `$RUN_DIR/.lock` (voir §4.13). Deux processes concurrents sur le même `run_id` sont impossibles par design : le second détecte le lock actif et throw `RunLockedError`.

### 4.12 Snapshot-authoritative, pas event-sourced

Décision architecturale fondamentale, déterminante pour toute évolution future du runtime.

**Règle normative** :

- `state.json` est la **source de vérité autoritative unique** de l'état d'un run. Écrasé à chaque transition, toujours cohérent avec le dernier commit applicatif des phases.
- `events.ndjson` (v0.3, §7.5) est un **audit trail du flux**. Append-only. Mirror des events émis sur stderr. Sert au debug forensique (quelles phases traversées, quelles délégations émises, quels retries, quelles erreurs), pas à la reconstruction de `state.data`.
- L'invariant "events suffisent à reconstruire l'état complet" **n'est pas** maintenu. L'invariant maintenu est plus faible : "events suffisent à reconstruire le **flux** du run".
- Pour reconstruire un état passé complet → combiner `state.json` final + `events.ndjson` pour le contexte flux. Pas de replay pur.

**Pourquoi pas l'event sourcing pur (à la Temporal)** :

Temporal impose le pur event sourcing (`state = f(events)`) parce qu'il contraint les workflows à être **déterministes par design** : un workflow émet des commandes (scheduleActivity, sleep, signal) et le state est dérivé mécaniquement des events résultants. Cette discipline permet le replay fiable.

`cc-orchestrator-runtime` a explicitement refusé cette contrainte : les phases sont du TS arbitraire qui retourne `nextState` via calcul libre (§6.2, §6.4). Le pattern command/event n'est pas imposé. Sans déterminisme des phases, le replay d'events ne peut pas reproduire un state.

Conséquence : si on tentait de persister "events suffisants pour reconstruire state", il faudrait **soit** imposer le déterminisme des phases (refusé, casse la facilité d'écriture), **soit** stocker `state.data` dans chaque event (anti-pattern Temporal, génère conflits snapshot vs events replayed, crée potentiellement une surface PII).

Le choix snapshot-authoritative évite ces conflits en ayant **une seule source de vérité** : `state.json`. Pas de guerre "snapshot vs events rejoués, qui gagne ?". `state.json` gagne toujours.

**Conséquences pratiques de ce choix** :

- Un `events.ndjson` perdu (corruption, purge prématurée) n'empêche **pas** la reprise : `state.json` suffit. Dégradation gracieuse du debug, pas de l'exécution.
- Un `state.json` perdu est un run cassé (impossible de reprendre). Backup recommandé si critique — scope hors v1.
- L'historique d'un run passé est dispersé : `state.json` pour l'état final, `events.ndjson` pour le flux, `delegations/` et `results/` pour les manifestes et résultats intermédiaires. Un futur CLI d'inspection pourrait les corréler par `run_id`.

### 4.13 Lock d'exécution par run

**Sémantique v0.8** : le lock file `$RUN_DIR/.lock` représente **"un process actuellement vivant dans ce run"**, **pas** une réservation longue-durée couvrant les délégations. Un process qui exit (DELEGATE, DONE, ERROR, ABORTED) release le lock immédiatement. La re-entry suivante le ré-acquiert. Pas de "chevauchement de lock sur l'inter-process".

Cette sémantique simple garantit :
- Deux processes concurrents sur le même `runId` sont impossibles (protection contre re-entries concurrentes parasites).
- La séquence normale `DELEGATE → exit → resume_cmd → acquire` fonctionne sans contention (le lock est libre pendant la délégation).
- Un SIGKILL laisse un lock orphelin, qui expire via le lease idle de 30 min → la re-entry suivante override proprement.

**Structure du fichier `.lock`** :

```ts
interface LockFile {
  readonly ownerPid: number;           // pour debug humain (ps -p)
  readonly ownerToken: string;         // ULID random, source de vérité pour release
  readonly acquiredAtEpochMs: number;
  readonly leaseUntilEpochMs: number;  // absolu, wall-clock epoch
}
```

**Règles normatives** :

- **Acquire atomique via `O_EXCL`** : création exclusive du fichier lock. Si le fichier existe déjà ET que `nowEpoch < leaseUntilEpochMs` → `RunLockedError`. Si le lease est expiré → override (le lock est orphelin, probablement après SIGKILL d'un ancien run). Génère un `ownerToken` ULID random gardé en RAM pour la durée du process.
- **Update atomique via tmp + rename** : toute mise à jour (refresh du lease) passe par `<lockPath>.tmp` puis `rename` sur le même filesystem (§4.3).
- **Release avec vérification token** : à **tout exit** (DELEGATE, DONE, ERROR, ABORTED, SIGINT, SIGTERM via handler §13.2), re-lire le lock, comparer `ownerToken` avec le token gardé en RAM. Si match → `unlink`. Si mismatch → émettre event `lock_conflict` (reason: `"stolen_at_release"`), skip le unlink (le nouveau propriétaire gère). SIGKILL ne passe pas par ici — lock reste, expire via lease.
- **Lease idle simple** : `leaseUntilEpochMs = nowEpochMs + DEFAULT_IDLE_LEASE_MS` (30 min). **Pas de lease dynamique basé sur deadline** (v0.8) — puisque le lock est release avant l'exit DELEGATE, il n'a pas besoin de couvrir la durée de la délégation.
- Le lease sert uniquement à la **crash recovery** : un SIGKILL orphelin expire après 30 min, permettant à la re-entry suivante (ou à un user qui relance manuellement) de reprendre le run.

**Constante v1** :
- `DEFAULT_IDLE_LEASE_MS = 30 * 60 * 1000` (30 min)

**Points de refresh (2) obligatoires** :

1. **Acquire** (début de process) — écriture initiale du LockFile.
2. **Start of each phase** (début de la boucle de dispatch, avant exécution de phase) — recalcul `leaseUntilEpochMs = nowEpochMs + DEFAULT_IDLE_LEASE_MS` et réécriture atomique. Couvre une phase mécanique longue (< 30 min en règle générale).

**Helper optionnel `io.refreshLock()`** : exposé sur `PhaseIO` pour le cas rare d'une phase mécanique qui dépasse 30 min sans transition (ex: énum 50k fichiers + hash, ~40 min dans une seule phase). L'auteur peut appeler `io.refreshLock()` périodiquement pour prolonger le lease idle. Invariant documentaire : phase > 30 min sans délégation → splitter en sous-phases OU appeler `refreshLock()` manuellement.

**Événements émis (§11.3 `lock_conflict`)** :
- `reason: "expired_override"` : à l'acquire, un lock expiré est trouvé et remplacé. Utile pour diagnostiquer les crashes précédents.
- `reason: "stolen_at_release"` : au release, le token ne match pas. Signal d'un lease idle trop court (>30 min sans refresh ni exit) ou d'un bug.

Les opérations normales (acquire successful, refresh successful, release successful) **n'émettent aucun event** — évite la pollution NDJSON.

**Scope du lock** : le lock est scopé au couple (cwd, runId). Deux runs en parallèle sur deux repos indépendants ne partagent **rien** — chemins RUN_DIR disjoints. Deux runs concurrents dans le même repo mais avec des `runId` différents (deux invocations indépendantes) sont également libres. Le lock ne bloque **que** deux processes visant **le même RUN_DIR** en **même temps**, cas qui correspond exclusivement à une tentative de re-entry concurrente parasite — précisément ce qu'on veut empêcher.

---

## 5. Architecture en couches

### 5.1 Vue d'ensemble

```
┌─────────────────────────────────────────────────────────┐
│ Layer 1 — Public API                                    │
│ runOrchestrator, Phase, PhaseIO, PhaseResult,           │
│ DelegationRequest, OrchestratorConfig, Errors,          │
│ Policies, Logger                                        │
├─────────────────────────────────────────────────────────┤
│ Layer 2 — Execution Engine                              │
│ engine/run.ts — main entry point                        │
│ engine/dispatch-phase.ts — phase runner loop            │
│ engine/handle-result.ts — PhaseResult interpreter       │
│ engine/handle-delegation.ts — manifest write + emit     │
│ engine/handle-resume.ts — result read + validation      │
├─────────────────────────────────────────────────────────┤
│ Layer 3 — Delegation Bindings                           │
│ bindings/skill.ts — DelegateSkill manifest + protocol   │
│ bindings/agent.ts — DelegateAgent manifest + protocol   │
│ bindings/agent-batch.ts — DelegateAgentBatch manifest   │
│ bindings/types.ts — binding interface commune           │
├─────────────────────────────────────────────────────────┤
│ Layer 4 — Transverse Services                           │
│ services/state-io.ts — atomic read/write state          │
│ services/retry-resolver.ts — retry decision pure        │
│ services/timeout.ts — AbortSignal wrapper               │
│ services/validator.ts — zod schema validation           │
│ services/error-classifier.ts — transient vs permanent   │
│ services/logger.ts — NDJSON event emitter               │
│ services/protocol.ts — @@CC_ORCH@@ block writer/reader  │
│ services/clock.ts — wall + monotonic clock abstraction  │
│ services/run-id.ts — ULID generator                     │
│ services/run-dir.ts — RUN_DIR resolver + cleanup        │
└─────────────────────────────────────────────────────────┘
```

### 5.2 Layer 1 — Public API

Types exportés :

- `OrchestratorConfig<State>` — config passée à `runOrchestrator`
- `Phase<State, Input, Output>` — signature d'une phase
- `PhaseIO<State>` — interface exposée aux phases (delegate*, log, clock, etc.)
- `PhaseResult<State>` — union discriminée des résultats possibles
- `DelegationRequest` — union discriminée (SkillDelegation, AgentDelegation, AgentBatchDelegation)
- `RetryPolicy`, `TimeoutPolicy`, `LoggingPolicy` (pas de `ValidationPolicy` — la validation passe exclusivement par les schémas `zod` fournis aux appels `io.consumePending*()`, cf §6.3)
- `OrchestratorLogger`, `OrchestratorEvent` (union discriminée d'events)
- Classes d'erreur : `OrchestratorError` (abstraite), `InvalidConfigError`, `StateCorruptedError`, `StateMissingError`, `StateVersionMismatchError`, `DelegationTimeoutError`, `DelegationSchemaError`, `DelegationMissingResultError`, `PhaseError`, `ProtocolError`, `AbortedError`, `RunLockedError`

Fonctions exportées :

- `runOrchestrator<State>(config: OrchestratorConfig<State>): Promise<void>` — entry point unique
- `definePhase<State, Input, Output>(fn: Phase<State, Input, Output>): Phase<State, Input, Output>` — helper de typage (pass-through à runtime, utile pour inférence TS)

Constantes exportées :

- `PROTOCOL_VERSION: 1` — version du protocole `@@CC_ORCH@@`
- `STATE_SCHEMA_VERSION: 1` — version du schéma `state.json`

### 5.3 Layer 2 — Execution Engine

**Non exporté publiquement.** Entry point unique : `runOrchestrator(config)`.

**Mapping canonique `PhaseResult.kind` ↔ action protocole** (référence unique pour tout le doc) :

| `PhaseResult.kind` (TS interne) | Protocole stdout | Exit code |
|---|---|---|
| `"transition"` | aucun (continue boucle in-process) | — |
| `"delegate"` | `@@CC_ORCH@@ action: DELEGATE` | 0 |
| `"done"` | `@@CC_ORCH@@ action: DONE` | 0 |
| `"fail"` | `@@CC_ORCH@@ action: ERROR` | 1 |
| (exception utilisateur non catchée) | `@@CC_ORCH@@ action: ERROR` | 1 |
| (signal SIGINT / SIGTERM) | `@@CC_ORCH@@ action: ABORTED` | 130 / 143 |

Aucun autre verbe n'est utilisé dans la suite du doc. `fail` désigne le résultat TS, `ERROR` désigne l'action protocole. Deux concepts, un mapping.

**Flow interne** :

1. **Init** : résout RUN_DIR (cf §5.5), génère ou lit le `run_id`, init logger, lit argv.
2. **Load state** : si `state.json` existe, lit et valide (schema version match §7.1). Sinon, construit l'état initial à partir de `config.initialState`.
3. **Dispatch phase** : boucle `while (!terminated)` :
   - Appelle `phases[currentPhase](state.data, io, input)`
   - Interprète `PhaseResult` selon la table ci-dessus.
   - `transition` enchaîne dans le même process ; les trois autres émettent un bloc protocole et exit.
4. **Resume** (si argv contient `--resume`) :
   - Identifie la délégation active via `state.pendingDelegation`.
   - Vérifie le deadline wall-clock (§14.2). Si dépassé et résultats absents → timeout.
   - **Lit les fichiers résultat en mémoire** (chemins per-attempt §7.2) et les met à disposition via `io.consumePendingResult(schema)` ou `io.consumePendingBatchResults(schema)`. **Ne les valide pas lui-même** : la validation est lazy, effectuée par la phase via l'appel consumePending*.
   - Transitionne vers `state.pendingDelegation.resumeAt`.
5. **Consumption check post-phase** : après l'exécution d'une phase de reprise, vérifie que `pendingDelegation.label` a été consommé **exactly once** via `consumePendingResult` OU `consumePendingBatchResults` (pas les deux, pas zéro). Sinon → `ProtocolError` (voir §14.2).
6. **Terminate** : émet `orchestrator_end`, exit.

### 5.4 Layer 3 — Delegation Bindings

Chaque type de délégation a un binding qui encapsule :

1. La **construction du manifest** (JSON écrit sur disque pour l'agent parent)
2. L'**émission du bloc protocole** sur stdout

```ts
interface DelegationBinding<Req extends DelegationRequest> {
  readonly kind: "skill" | "agent" | "agent-batch";
  buildManifest(request: Req, context: DelegationContext): DelegationManifest;
  buildProtocolBlock(manifest: DelegationManifest): string;
}
```

**Note normative v0.6** : le binding **ne lit pas** les fichiers résultats. La lecture est exclusivement effectuée par l'engine au resume (§14.2 step 12). Cette séparation évite la duplication d'architecture (un seul owner pour IO résultats). Le binding s'occupe uniquement de la construction du manifest et du bloc protocole — deux artefacts write-side.

Les trois bindings :

- **`SkillBinding`** — délègue à un skill (`/senior-review`, `/dedup-codebase`, etc.). Le skill s'exécute dans un tour du LLM parent et écrit son résultat à un chemin indiqué dans le manifest.
- **`AgentBinding`** — délègue à un sub-agent unique (`senior-reviewer-file`, etc.). Le sub-agent reçoit un prompt incluant le chemin où écrire son résultat.
- **`AgentBatchBinding`** — délègue à N sub-agents du **même type** en parallèle. Le manifest liste les N jobs, chaque job a son propre path de résultat. L'agent parent lance les N `Agent(...)` dans un seul message.

Taille cible par binding : 60-120 LOC.

### 5.5 Layer 4 — Transverse Services

Composants isolés, testables unitairement sans LLM :

- **`state-io.ts`** : `readState(path) → State | null`, `writeStateAtomic(path, state) → void`. Pattern tmp + rename. Valide `STATE_SCHEMA_VERSION` au read.
- **`retry-resolver.ts`** : `resolveRetryDecision(error, attempt, policy) → RetryDecision`. Fonction pure. Table de décision en §10.1.
- **`timeout.ts`** : wrapper `AbortSignal.timeout(ms)` composable. Pour les délégations, le timeout est la **durée max entre l'émission du signal et la lecture du résultat** côté process re-entry (pas côté process émetteur — qui est déjà mort).
- **`validator.ts`** : `validateResult(rawJson, schema) → ValidationResult`. Utilise `zod`. Retourne succès + données typées, ou échec + raison.
- **`error-classifier.ts`** : `classify(error) → ErrorCategory`. Retourne `"transient"`, `"permanent"`, `"abort"`, ou `"unknown"`. Fonction pure.
- **`logger.ts`** : `emit(event: OrchestratorEvent) → void`. Double-write **conditionnel** (v0.8 C14) :
  - **Stderr** : toujours actif dès le début du process (sauf `LoggingPolicy.enabled === false`). Permet d'émettre les erreurs preflight et RunLockedError.
  - **events.ndjson** : activé uniquement **après acquire lock réussi**. Seul un owner process écrit dans ce fichier — garantit qu'un contender bloqué sur O_EXCL ne pollue pas l'audit trail du run actif.
  - Injectable via `LoggingPolicy.logger` — un logger custom remplace l'émission stderr uniquement. Le disque events.ndjson (owner-only) est toujours actif sauf si `persistEventLog: false` ou `enabled: false`.
- **`protocol.ts`** : `writeProtocolBlock(action, fields) → string` + `parseProtocolBlock(stdout) → ProtocolBlock | null`. Format défini §7.4.
- **`clock.ts`** : `{ nowWall(): Date, nowWallIso(): string, nowEpochMs(): number, nowMono(): number }`. Abstraction pour tests. `nowEpochMs` est central pour les deadlines cross-process et le lock lease (§12.3).
- **`run-id.ts`** : `generateRunId() → string`. Utilise `ulid`. ULID car tri chronologique lexicographique natif.
- **`run-dir.ts`** : `resolveRunDir(orchestratorName, runId) → string` + `cleanupOldRuns(baseDir, retentionDays) → number`. Retourne `.claude/run/cc-orch/<name>/<run-id>`.

### 5.6 Dépendances externes (v1)

Le package est conçu pour avoir une empreinte minimale.

| Package | Version | Rôle | Justification |
| --- | --- | --- | --- |
| `zod` | `^3.x` | Schema validation pour résultats de délégations | Standard TS pour validation runtime. ~50 Ko gzipped mais API mature, zero vulnérabilité historique majeure, types inférés automatiquement. Seule alternative crédible : écrire un micro-validator maison (~200 lignes), non rentable. |
| `ulid` | `^2.x` | Génération du `run_id` et autres IDs (ex. `delegation_id`) | ~2 Ko, zéro sous-dépendance. ULID = tri chronologique lexicographique natif. Même choix que `llm-runtime`. |

**Tout le reste est écrit maison ou utilise l'API standard Node ≥ 22** :

- `fs/promises` natif pour les IO fichier
- `crypto` natif pour les hashs si besoin
- `AbortSignal.timeout()` natif
- `performance.now()` natif
- `process.stderr.write()` pour le logger
- Pas de framework de tests : `node:test` natif ou `vitest` (dev-only)

**Règle normative** : ajouter une dépendance runtime = modification du NX + justification écrite. Dev-dependencies (vitest, biome, tsc, etc.) sont libres.

**Justification du zod-only pour validation** : `zod` est le standard TS pour schema validation. Écrire notre propre validator serait rouler une feature complexe (parsing d'erreurs, coercion, types inférés) pour un gain marginal. `ajv` (JSON Schema) est plus strict sur le standard mais moins ergonomique côté TS.

### 5.7 Manager de packages et runtime Node

- **Package manager** : `pnpm >= 10` (cohérence avec `llm-runtime` qui est le modèle architectural)
- **Node runtime** : `>= 22 LTS`. Les APIs natives utilisées (`AbortSignal.timeout`, `fs/promises.rename`, `performance.now`) sont toutes stables en Node 22.
- **Bun comme runtime de consommation** : les consommateurs (orchestrateurs dans `~/.claude/scripts/`) peuvent exécuter le package via `bun run` sans problème — `bun` consomme des packages installés par `pnpm` nativement. Le runtime ne dépend d'aucune API exclusive à Node ou Bun.

---

## 6. Contrat public

### 6.1 OrchestratorConfig

```ts
export interface OrchestratorConfig<State extends object = object> {
  /** Nom unique de l'orchestrateur. Utilisé pour RUN_DIR, logs, protocole. Kebab-case requis. */
  readonly name: string;

  /** Phase initiale, exécutée au premier démarrage. */
  readonly initial: string;

  /** Map des phases, keyed by phase name. */
  readonly phases: Readonly<Record<string, Phase<State, any, any>>>;

  /**
   * État initial du run (required v0.6). Validé au démarrage si stateSchema fourni.
   * Le runtime ne fournit pas de fallback {} pour éviter un état invalide face au type métier réel.
   */
  readonly initialState: State;

  /**
   * Builder de la commande de reprise (required v0.6). Le runtime appelle
   * resumeCommand(runId) à chaque délégation et place le résultat dans le champ
   * `resume_cmd` du bloc @@CC_ORCH@@ action: DELEGATE.
   *
   * La fonction DOIT retourner une commande complète incluant l'interpréteur
   * (bun/node), le chemin du main, --run-id <runId>, et --resume.
   *
   * Exemple : (runId) => `bun run ~/.claude/scripts/senior-review/main.ts --run-id ${runId} --resume`
   */
  readonly resumeCommand: (runId: string) => string;

  /** Schéma zod du state. Validé au read/write. Défaut: z.object({}).passthrough(). */
  readonly stateSchema?: ZodSchema<State>;

  /** Policies globales. Chaque phase peut override par délégation individuelle. */
  readonly retry?: RetryPolicy;
  readonly timeout?: TimeoutPolicy;
  readonly logging?: LoggingPolicy;

  /** Durée de rétention des runs antérieures (jours). Défaut: 7. */
  readonly retentionDays?: number;
}
```

**Règles** :

- `name` doit être un kebab-case non-vide. Validation regex : `/^[a-z][a-z0-9-]*$/`. Un nom invalide → `InvalidConfigError` émis via bloc ERROR preflight (§4.4).
- `initial` doit être une clé présente dans `phases`. Sinon `InvalidConfigError`.
- `phases` doit être non-vide. `{}` → `InvalidConfigError`.
- Les clés de `phases` sont des identifiants kebab-case non-vides.
- `initialState` est **required** (v0.6). Si absent ou undefined → `InvalidConfigError`. Si `stateSchema` fourni, `initialState` est validé contre lui au démarrage. Pas de fallback `{}` silencieux — un type `State` avec champs requis doit avoir un initialState correspondant.
- `resumeCommand` est **required** (v0.6). Absent ou non-fonction → `InvalidConfigError`. Le runtime appellera la fonction à chaque émission DELEGATE avec le runId courant.
- Si `stateSchema` est fourni, tout state lu ou écrit est validé contre ce schéma. Échec de validation = `StateCorruptedError`.

### 6.2 Phase

```ts
export type Phase<State, Input = void, Output = void> = (
  state: State,
  io: PhaseIO<State>,
  input?: Input
) => Promise<PhaseResult<State, Output>>;
```

**Règles** :

- La phase est **asynchrone** (retourne `Promise<PhaseResult>`).
- **Invariant runtime (prod, pas dev-only)** : le `state` passé à la phase est **gelé en profondeur** via `Object.freeze` récursif avant l'appel. Toute tentative de mutation déclenche un `TypeError` natif Node, y compris en production. Cette garantie est du moteur, pas une aide au développement. Auteurs : composer un nouveau state à retourner via `io.transition(...)`, jamais muter celui reçu.
- **Invariant runtime — single PhaseResult** : chaque phase ne peut retourner qu'**un seul** `PhaseResult`. Le runtime track via un flag interne la première émission (`io.transition/delegate*/done/fail`) et throw `ProtocolError("PhaseResult already committed")` à toute tentative d'en produire un second dans le même appel de phase. Garde mécanique, pas documentaire.
- **Invariant documentaire — phase max duration** : une phase mécanique sans délégation ne devrait pas dépasser `DEFAULT_IDLE_LEASE_MS` (30 min, cf §4.13). Au-delà, le lock expire et un second process peut usurper le run. Solution : soit splitter en sous-phases (refresh automatique à chaque phase-start), soit appeler `io.refreshLock()` périodiquement depuis la phase.
- La phase ne doit pas écrire sur disque hors des API fournies par `io`. Si elle le fait, elle brise l'atomicité et l'idempotence. (Invariant documentaire, non enforced mécaniquement — trop invasif à surveiller.)
- La phase **peut** faire des IO en lecture (lire des fichiers du repo, exécuter git, etc.) — ces effets sont considérés externes et hors du state managé.
- La phase doit être **idempotente** si possible (même input → même résultat), parce que re-exécuter une phase après crash est supporté v1 via state reload.
- **`input` est un canal in-process uniquement** (v0.6) : le second argument `input?: Input` de `Phase<State, Input, Output>` et le champ `input?: unknown` dans `PhaseResult.transition` sont des canaux légers pour passer des données entre deux phases contiguës **dans le même process**. Ils **ne sont pas persistés** dans `state.json`, `pendingDelegation`, ou le manifest. **Toute transition qui franchit une délégation** (phase de reprise → phase suivante via delegate) **ne peut pas s'appuyer sur `input`** — au resume, la phase reçoit `input: undefined`. Si des données doivent survivre à une délégation, elles vont dans `state.data` (le canal durable par conception). Discipline auteur : utiliser `input` uniquement pour les transitions intra-process où la non-persistance est acceptable.

### 6.3 PhaseIO

```ts
export interface PhaseIO<State extends object> {
  /** Transition vers la phase suivante, même process. */
  transition<NextInput = void>(
    nextPhase: string,
    nextState: State,
    input?: NextInput
  ): PhaseResult<State>;

  /** Délégation à un skill. Le process exit après émission. */
  delegateSkill(req: SkillDelegationRequest): PhaseResult<State>;

  /** Délégation à un sub-agent unique. Le process exit après émission. */
  delegateAgent(req: AgentDelegationRequest): PhaseResult<State>;

  /** Délégation à un batch parallèle de sub-agents du même type. */
  delegateAgentBatch(req: AgentBatchDelegationRequest): PhaseResult<State>;

  /** Terminaison réussie. Le process exit avec code 0 après émission DONE. */
  done<FinalOutput>(output: FinalOutput): PhaseResult<State>;

  /** Terminaison en erreur. Le process exit avec code 1 après émission ERROR. */
  fail(error: Error): PhaseResult<State>;

  /** Logger structuré, corrélé par run_id. */
  readonly logger: OrchestratorLogger;

  /** Clock abstrait pour tests. */
  readonly clock: Clock;

  /** Run ID (ULID stable pour toute la durée du run). */
  readonly runId: string;

  /** Argv parsé (après retrait des flags internes --resume, --phase, etc.). */
  readonly args: readonly string[];

  /** Chemin absolu du RUN_DIR. */
  readonly runDir: string;

  /** Signal d'abort OS-propagé (SIGINT/SIGTERM). Utilisable dans les awaits longues de la phase. */
  readonly signal: AbortSignal;

  /** Consomme le résultat d'une délégation skill ou agent (non-batch). Throw si pending.kind === "agent-batch". */
  consumePendingResult<T>(schema: ZodSchema<T>): T;

  /** Consomme les résultats d'une délégation agent-batch. Throw si pending.kind !== "agent-batch". */
  consumePendingBatchResults<T>(schema: ZodSchema<T>): readonly T[];

  /** Rafraîchit le lock file avec un nouveau leaseUntilEpochMs. Utile pour phases mécaniques longues (cf §4.13). */
  refreshLock(): void;
}
```

**Règles** :

- `transition`, `delegate*`, `done`, `fail` retournent un `PhaseResult`. La phase doit **retourner** ce résultat (`return io.transition(...)`). Retourner autre chose (ou ne rien retourner) = `PhaseError`.
- **Single PhaseResult enforcé mécaniquement** : le runtime flag la première émission. Un second appel à `transition/delegate*/done/fail` dans le même appel de phase → `ProtocolError("PhaseResult already committed")` immédiat. Cohérent avec §6.2 invariant runtime.
- `consumePendingResult(schema)` : lit le JSON unique écrit par une délégation skill ou agent (`pending.kind === "skill" | "agent"`). Validé par le schéma. Si manquant → `DelegationMissingResultError`. Si invalide → `DelegationSchemaError`. Si `pending.kind === "agent-batch"` → `ProtocolError("use consumePendingBatchResults for batch delegations")`.
- `consumePendingBatchResults(schema)` : lit les N JSONs écrits par une délégation agent-batch, retourne `readonly T[]` aligné sur l'ordre de `pending.jobIds`. Schéma appliqué à **chaque** élément. Si un fichier manque → `DelegationMissingResultError` (pas de tolérance partielle). Si un fichier est invalide → `DelegationSchemaError` (pas de sortie partielle). Si `pending.kind !== "agent-batch"` → `ProtocolError("use consumePendingResult for single delegations")`.
- **Règle d'exactement-une-consommation** : durant une phase de reprise (invocation déclenchée par `--resume`), la phase doit appeler **exactement un** des deux (`consumePendingResult` OU `consumePendingBatchResults`). Zéro appels, deux appels, ou un appel dans la mauvaise méthode pour le kind → `ProtocolError`. La vérification se fait à l'appel (wrong-kind) ou post-phase (zero-call).
- `io.refreshLock()` : recalcule `leaseUntilEpochMs` et écrit atomiquement le nouveau lock (cf §4.13). Utile pour phases qui dépassent `DEFAULT_IDLE_LEASE_MS` (30 min) sans transition. Coût : une écriture disque par appel. Appelable plusieurs fois par phase sans effet cumulatif indésirable.
- `io.signal` abort quand le process reçoit SIGINT/SIGTERM. Une phase qui fait `await fetch(url, { signal: io.signal })` sera interrompue proprement.

### 6.4 PhaseResult

```ts
export type PhaseResult<State, Output = void> =
  | { readonly kind: "transition"; readonly nextPhase: string; readonly nextState: State; readonly input?: unknown }
  | { readonly kind: "delegate"; readonly request: DelegationRequest; readonly resumeAt: string; readonly nextState: State }
  | { readonly kind: "done"; readonly output: Output }
  | { readonly kind: "fail"; readonly error: Error };
```

**Règles** :

- `transition.nextPhase` doit exister dans `config.phases`. Sinon `ProtocolError` au runtime.
- `delegate.resumeAt` doit exister dans `config.phases`. Sinon `ProtocolError`.
- `delegate.nextState` est le state à persister **avant** d'exit. À la re-entry, la phase `resumeAt` reçoit ce state + accès au résultat via `io.consumePendingResult(schema)` ou `io.consumePendingBatchResults(schema)` selon le kind de la délégation.
- `done.output` est sérialisé en JSON dans `$RUN_DIR/output.json`. Type arbitraire, doit être JSON-sérialisable.

### 6.5 DelegationRequest (union discriminée)

```ts
export type DelegationRequest =
  | SkillDelegationRequest
  | AgentDelegationRequest
  | AgentBatchDelegationRequest;

export interface SkillDelegationRequest {
  readonly kind: "skill";
  readonly skill: string;              // ex: "dedup-codebase"
  readonly args?: Record<string, unknown>;
  readonly label: string;              // identifie cette délégation dans le RUN_DIR
  readonly retry?: RetryPolicy;        // override policy globale
  readonly timeout?: TimeoutPolicy;
}

export interface AgentDelegationRequest {
  readonly kind: "agent";
  readonly agentType: string;          // ex: "senior-reviewer-file"
  readonly prompt: string;
  readonly label: string;
  readonly retry?: RetryPolicy;
  readonly timeout?: TimeoutPolicy;
}

export interface AgentBatchDelegationRequest {
  readonly kind: "agent-batch";
  readonly agentType: string;
  readonly jobs: ReadonlyArray<{
    readonly id: string;               // identifiant unique au sein du batch
    readonly prompt: string;
  }>;
  readonly label: string;
  readonly retry?: RetryPolicy;
  readonly timeout?: TimeoutPolicy;
}
```

**Note v0.6 — pas de `outputSchema` dans `DelegationRequest`** : la validation des résultats se fait **exclusivement** via le schéma zod passé à `io.consumePendingResult(schema)` ou `io.consumePendingBatchResults(schema)` côté phase de reprise (§6.3). Un `outputSchema` dans `DelegationRequest` serait non-sérialisable (zod non portable cross-process) et redondant avec la validation lazy. Décision cohérente avec M1 (v0.2, lazy validation).

**Règles** :

- `label` doit être unique au sein d'un run (runtime vérifie contre `state.usedLabels`, cf §7.1, et throw `ProtocolError` si collision).
- `label` suit le pattern `/^[a-z][a-z0-9-]*$/`.
- `skill` et `agentType` sont des chaînes arbitraires (pas de validation runtime — le runtime ne connaît pas la liste des skills/agents).
- Dans `AgentBatchDelegationRequest`, `jobs.length >= 1`. Batch vide = `InvalidConfigError` ; utiliser `transition` direct si 0 job.
- `jobs[].id` doit être unique au sein du batch. Les IDs sont utilisés pour nommer les fichiers de résultat individuels.

### 6.6 Errors

Toutes les erreurs héritent de `OrchestratorError` :

```ts
export abstract class OrchestratorError extends Error {
  abstract readonly kind: OrchestratorErrorKind;
  readonly runId?: string;
  readonly orchestratorName?: string;
  readonly phase?: string;
}

export type OrchestratorErrorKind =
  | "invalid_config"
  | "state_corrupted"
  | "state_missing"
  | "state_version_mismatch"
  | "delegation_timeout"
  | "delegation_schema"
  | "delegation_missing_result"
  | "phase_error"
  | "protocol"
  | "aborted"
  | "run_locked";
```

Liste canonique :

| Classe | Situation | Retriable ? |
| --- | --- | --- |
| `InvalidConfigError` | Config invalide au `runOrchestrator` | Non |
| `StateCorruptedError` | `state.json` non parseable, schéma violé | Non |
| `StateMissingError` | `--resume` mais pas de state.json | Non |
| `StateVersionMismatchError` | `state.json` d'une version incompatible | Non |
| `DelegationTimeoutError` | Le résultat n'est pas apparu dans le délai | Oui (retry) |
| `DelegationSchemaError` | Le résultat est là mais ne respecte pas le schéma | Oui (retry) |
| `DelegationMissingResultError` | `consumePending*` appelé mais fichier absent (bug parent agent) | Non |
| `PhaseError` | Exception jetée par une phase utilisateur | Dépend de la catégorie du `cause` |
| `ProtocolError` | Violation du protocole (nextPhase invalide, label dupliqué, wrong consume kind, double PhaseResult, etc.) | Non |
| `AbortedError` | Signal SIGINT/SIGTERM reçu | Non (voulu) |
| `RunLockedError` | Au démarrage, `.lock` actif détenu par un autre process (lease non expiré). Propriétés publiques : `ownerPid`, `acquiredAtEpochMs`, `leaseUntilEpochMs`. | Non (exit immédiat) |

### 6.7 Logger

```ts
export interface OrchestratorLogger {
  emit(event: OrchestratorEvent): void;
}

export type OrchestratorEvent =
  | { eventType: "orchestrator_start"; runId: string; orchestratorName: string; initialPhase: string; timestamp: string }
  | { eventType: "phase_start"; runId: string; phase: string; attemptCount: number; timestamp: string }
  | { eventType: "phase_end"; runId: string; phase: string; durationMs: number; resultKind: "transition" | "delegate" | "done" | "fail"; timestamp: string }
  | { eventType: "delegation_emit"; runId: string; phase: string; label: string; kind: "skill" | "agent" | "agent-batch"; jobCount: number; timestamp: string }
  | { eventType: "delegation_result_read"; runId: string; phase: string; label: string; jobCount: number; filesLoaded: number; timestamp: string }
  | { eventType: "delegation_validated"; runId: string; phase: string; label: string; timestamp: string }
  | { eventType: "delegation_validation_failed"; runId: string; phase: string; label: string; zodErrorSummary: string; timestamp: string }
  | { eventType: "retry_scheduled"; runId: string; phase: string; label: string; attempt: number; delayMs: number; reason: string; timestamp: string }
  | { eventType: "phase_error"; runId: string; phase: string; errorKind: OrchestratorErrorKind; message: string; timestamp: string }
  | { eventType: "lock_conflict"; runId: string; reason: "expired_override" | "stolen_at_release"; currentOwnerToken?: string; timestamp: string }
  | { eventType: "orchestrator_end"; runId: string; orchestratorName: string; success: boolean; durationMs: number; phasesExecuted: number; timestamp: string };
```

Default logger : écrit `JSON.stringify(event) + "\n"` sur stderr.

### 6.8 Policies

```ts
export interface RetryPolicy {
  readonly maxAttempts: number;           // défaut 3
  readonly backoffBaseMs: number;         // défaut 1000
  readonly maxBackoffMs: number;          // défaut 30000
}

export interface TimeoutPolicy {
  /** Durée max entre émission DELEGATE et disponibilité du résultat (ms). */
  readonly perDelegationMs: number;       // défaut 600000 (10 min)
}

export interface LoggingPolicy {
  readonly logger?: OrchestratorLogger;   // défaut: stderr NDJSON
  readonly enabled: boolean;              // défaut true
  readonly persistEventLog?: boolean;     // défaut true (v0.3+) — double-write à $RUN_DIR/events.ndjson
}
```

**Rationale `persistEventLog`** (v0.3) : flag opt-out pour les cas où l'audit trail disque n'est pas souhaité (tests unitaires du runtime, stress runs sans I/O). Défaut `true` parce que le coût est négligeable (quelques Ko par run typique) et le bénéfice forensique important. Si `LoggingPolicy.enabled === false`, `persistEventLog` est ignoré (zéro émission partout, stderr ET disque).

---

## 7. Formes canoniques intermédiaires

Ces formes vivent entre les re-entries. Elles ne sont pas exportées publiquement mais sont normatives : tout orchestrateur et agent parent doit les respecter.

### 7.1 state.json — forme canonique unique

Cette section est la **seule** source de vérité pour le format de `state.json`. Les §12 et §14 y renvoient sans redéfinir.

```ts
interface StateFile<State> {
  readonly schemaVersion: 1;
  readonly runId: string;                      // ULID
  readonly orchestratorName: string;

  // Temporal — wall clock uniquement (cross-process safe).
  // Aucun champ monotonic ici : performance.now() ne survit pas à un process exit.
  readonly startedAt: string;                  // ISO 8601
  readonly startedAtEpochMs: number;           // epoch ms, pour deltas cross-process
  readonly lastTransitionAt: string;           // ISO 8601
  readonly lastTransitionAtEpochMs: number;    // epoch ms

  // Flow state.
  readonly currentPhase: string;
  readonly phasesExecuted: number;
  readonly accumulatedDurationMs: number;      // somme des durées de phases traversées (measure monotonic intra-process, accumulée dans le state)

  // User data — typée par l'orchestrateur.
  readonly data: State;

  // Délégation en cours (undefined hors période de délégation active).
  readonly pendingDelegation?: PendingDelegationRecord;

  // Registre des labels déjà utilisés dans ce run.
  // Append-only : chaque émission de délégation ajoute son label.
  // Jamais retiré, même après consommation. Permet l'enforcement "unicité label au run" (§6.5).
  readonly usedLabels: readonly string[];
}

interface PendingDelegationRecord {
  readonly label: string;
  readonly kind: "skill" | "agent" | "agent-batch";
  readonly resumeAt: string;
  readonly manifestPath: string;               // chemin absolu du manifest JSON

  // Deadline — wall clock epoch ms uniquement.
  // Aucun champ monotonic ici non plus.
  readonly emittedAtEpochMs: number;
  readonly deadlineAtEpochMs: number;          // = emittedAtEpochMs + timeoutMs effectif de la tentative

  // Retry state.
  readonly attempt: number;                    // 0-indexé, capturé à l'émission
  readonly effectiveRetryPolicy: {             // policy complète capturée à l'émission initiale (v0.8 M26)
    readonly maxAttempts: number;
    readonly backoffBaseMs: number;
    readonly maxBackoffMs: number;
  };

  // Batch uniquement.
  readonly jobIds?: readonly string[];
}
```

**Règles normatives** :

- Écrit atomiquement (tmp + rename, cf §4.3) à chaque transition et à chaque émission de délégation.
- Lu au démarrage de toute invocation sauf au tout premier run (pas de state.json → initial state via `config.initialState`).
- `schemaVersion === 1` obligatoire. Un `state.json` avec autre valeur → `StateVersionMismatchError`.
- `data` est opaque au runtime sauf si `config.stateSchema` a été fourni (alors validé à chaque read/write).
- `accumulatedDurationMs` est incrémenté uniquement à la fin de chaque phase terminée (transition/delegate/done/fail) par la durée monotonic de cette phase. Jamais de double-comptage.
- `pendingDelegation` est écrit juste avant l'exit pour délégation. Il est effacé (set à `undefined`) **au traitement du PhaseResult de la phase de reprise** (§14.1 step 15.n "transition"/"done"/"fail"), **pas au début de la phase de reprise**. Cette règle est critique au crash : un crash pendant la phase de reprise avant qu'elle ait émis son PhaseResult laisse `pendingDelegation` en place → la re-reprise retente la phase correctement. Si on effaçait au début de la phase, un crash mid-phase transformerait l'état en "pas de délégation active" et casserait la reprise.
- **Pas de champ monotonic dans le state**. Tout timing cross-process utilise wall clock epoch ms. Le monotonic ne sert que pour les durées intra-process et pour les sleeps de retry (via `AbortSignal.timeout`).

### 7.2 Manifest de délégation

Écrit par le binding dans `$RUN_DIR/delegations/<label>-<attempt>.json` juste avant émission du signal. Le suffixe `-<attempt>` évite l'écrasement cross-tentative et permet de garder la trace des manifests antérieurs pour debug.

```ts
interface DelegationManifest {
  readonly manifestVersion: 1;
  readonly runId: string;
  readonly orchestratorName: string;
  readonly phase: string;                      // phase qui a émis la délégation
  readonly resumeAt: string;                   // phase à reprendre après résultat
  readonly label: string;
  readonly kind: "skill" | "agent" | "agent-batch";

  // Temporal — wall clock epoch ms, cohérent avec state.json.
  readonly emittedAt: string;                  // ISO 8601 pour humains/logs
  readonly emittedAtEpochMs: number;           // epoch ms pour deadline math
  readonly timeoutMs: number;                  // timeoutPolicy.perDelegationMs effectif de cette tentative
  readonly deadlineAtEpochMs: number;          // = emittedAtEpochMs + timeoutMs

  // Retry state (cohérent avec state.pendingDelegation).
  readonly attempt: number;
  readonly maxAttempts: number;

  // Fields specific to kind.
  readonly skill?: string;
  readonly skillArgs?: Record<string, unknown>;
  readonly agentType?: string;
  readonly prompt?: string;
  readonly jobs?: ReadonlyArray<{
    readonly id: string;
    readonly prompt: string;
    readonly resultPath: string;               // chemin absolu où écrire le résultat
  }>;

  // Pour skill et agent (non-batch), le resultPath est top-level.
  readonly resultPath?: string;
}
```

**Règles** :

- Pour `kind: "agent-batch"`, `jobs` est obligatoire et `resultPath` absent. Chaque job a son propre `resultPath`.
- Pour `kind: "skill"` ou `"agent"`, `resultPath` est obligatoire et `jobs` absent.
- **Résultats per-attempt (v0.4)** : `resultPath` est un chemin **versionné par tentative** pour éviter qu'un sub-agent lent d'une tentative précédente ne pollue la tentative courante. Format :
  - `kind: "skill" | "agent"` : `$RUN_DIR/results/<label>-<attempt>.json`
  - `kind: "agent-batch"` : `$RUN_DIR/results/<label>-<attempt>/<jobId>.json`
- Les tentatives antérieures conservent leurs fichiers dans `$RUN_DIR/results/<label>-<ancien_attempt>/*` — le runtime **ne les lit plus** (il ne consulte que l'`attempt` courant via `state.pendingDelegation.attempt`). Nettoyage via rétention RUN_DIR standard.
- Conséquence : un sub-agent orphelin d'une tentative N-1 qui écrit tardivement dans le path de N-1 ne peut **plus** polluer la tentative N (chemins disjoints). Race de sub-agent lent résolue structurellement.

### 7.3 Fichier de résultat

Écrit par le skill ou le sub-agent au chemin `resultPath` indiqué dans le manifest. Format : JSON arbitraire.

**Règle normative** : le runtime **ne validera** le résultat que contre le schéma zod fourni par la phase de reprise lors de son appel à `io.consumePendingResult(schema)` ou `io.consumePendingBatchResults(schema)` (§6.3). La validation est **lazy** (§4.12, §16.5). Aucun champ obligatoire imposé par le runtime sur le contenu lui-même. Le runtime ne connaît pas la sémantique du skill/agent appelé. Un résultat présent mais non parseable en JSON est traité comme `DelegationSchemaError` au resume (§14.2 step 12), distinct de l'absence de fichier.

**Exception** : pour un `agent-batch`, chaque fichier de résultat (un par job) doit être présent et valide. Si un seul manque → `DelegationMissingResultError` (pas de tolérance partielle en v1 ; l'orchestrateur peut relancer).

### 7.4 Protocole `@@CC_ORCH@@`

Émis sur stdout par le runtime pour communiquer avec l'agent parent. Format strictement délimité, parseable par regex.

**Forme générique** :

```
@@CC_ORCH@@
version: 1
run_id: <ulid>
orchestrator: <name>
action: <ACTION>
<fields spécifiques à l'action>
@@END@@
```

**Règles normatives** :

- Le bloc commence par `@@CC_ORCH@@` sur une ligne seule (pas de préfixe/suffixe).
- Le bloc finit par `@@END@@` sur une ligne seule.
- Entre les deux : lignes `key: value` (YAML-subset très simplifié), une par ligne.
- Les valeurs autorisées sont : **strings**, **nombres** (entiers ou décimaux), **booléens** (`true`/`false` littéraux), ou `null`. Pas de structure complexe inline (utiliser un path vers un manifest pour les complexités).
- Les valeurs string qui contiennent des caractères spéciaux (`:`, retours ligne, guillemets) doivent être quotées `"..."` avec échappement JSON standard. Sans caractères spéciaux, les quotes sont optionnelles.
- Chaque bloc est précédé et suivi d'une ligne vide pour clarté de parsing.
- **Un seul bloc par invocation du process** : soit `DELEGATE`, soit `DONE`, soit `ERROR`, soit `ABORTED`. Un run complet peut émettre **plusieurs blocs** au total, un par invocation (typiquement N×DELEGATE + 1×DONE/ERROR/ABORTED).
- Les phases mécaniques (transitions internes) **n'émettent pas** de bloc — elles enchaînent dans le même process.

**Actions possibles** :

#### 7.4.1 `action: DELEGATE`

```
@@CC_ORCH@@
version: 1
run_id: 01HX...
orchestrator: senior-review
action: DELEGATE
manifest: /Users/.../.claude/run/cc-orch/senior-review/01HX.../delegations/review-batch-0.json
kind: agent-batch
resume_cmd: bun run /Users/.../senior-review/main.ts --run-id 01HX... --resume
@@END@@
```

**Champs** :

- `manifest` : chemin absolu du manifest JSON décrit en §7.2.
- `kind` : `"skill"`, `"agent"`, ou `"agent-batch"` (même valeur que dans le manifest).
- `resume_cmd` : commande bash complète que l'agent parent doit relancer après que les résultats soient écrits.

**Action attendue du parent agent** :

1. Parser le bloc.
2. Lire le manifest à `manifest`.
3. Selon `kind` :
   - `skill` : invoquer le skill via le tool `Skill` avec les args. Le skill est responsable d'écrire son résultat à `resultPath` du manifest.
   - `agent` : invoquer `Agent({subagent_type: manifest.agentType, prompt: manifest.prompt + "\n\nWrite your JSON result to: " + manifest.resultPath})`. Attendre la complétion.
   - `agent-batch` : invoquer N `Agent({subagent_type: manifest.agentType, prompt: job.prompt + "\n\nWrite your JSON result to: " + job.resultPath})` **dans un seul message** pour exécution parallèle. Attendre la complétion de tous.
4. Une fois les sub-tours terminés (résultats écrits ou pas), lancer `resume_cmd` via le tool `Bash`.

**Note sur le timeout** : le parent agent **ne gère aucun timeout**. Il invoque, attend la complétion naturelle du(des) sub-tour(s), puis relance `resume_cmd`. C'est le **runtime** au resume qui vérifie si le deadline (`deadlineAtEpochMs` du manifest) a été dépassé et décide du retry ou du fail. Voir §9.3 pour la sémantique complète.

#### 7.4.2 `action: DONE`

```
@@CC_ORCH@@
version: 1
run_id: 01HX...
orchestrator: senior-review
action: DONE
output: /Users/.../.claude/run/cc-orch/senior-review/01HX.../output.json
success: true
phases_executed: 5
duration_ms: 12345
@@END@@
```

**Champs** :

- `output` : chemin absolu du fichier JSON contenant le résultat final.
- `success` : `true` ou `false` (pour `DONE` c'est toujours `true` par définition — `false` → `ERROR`).
- `phases_executed` : nombre de phases traversées au total (incluant celles interrompues pour délégation).
- `duration_ms` : durée cumulée (monotonic).

**Action attendue du parent agent** :

1. Lire le fichier `output`.
2. Présenter le rapport à l'utilisateur ou le transmettre au parent appelant (cas de composition récursive).

#### 7.4.3 `action: ERROR`

```
@@CC_ORCH@@
version: 1
run_id: 01HX...
orchestrator: senior-review
action: ERROR
error_kind: delegation_schema
message: "Validation failed for delegation 'review-batch' after 3 retries"
phase: consolidate
phases_executed: 4
@@END@@
```

**Champs** :

- `error_kind` : un des `OrchestratorErrorKind` de §6.6.
- `message` : message human-readable (≤ 200 chars, pas de secrets).
- `phase` : phase où l'erreur s'est produite.

**Exemple bloc ERROR avec `error_kind: run_locked`** :

```
@@CC_ORCH@@
version: 1
run_id: 01HX...
orchestrator: senior-review
action: ERROR
error_kind: run_locked
message: "Run 01HX... is locked by PID 12345, lease expires at 2026-04-19T14:23:05Z"
phase: null
phases_executed: 0
@@END@@
```

**Exemple bloc ERROR preflight (config invalide, runId pas encore généré)** :

```
@@CC_ORCH@@
version: 1
run_id: null
orchestrator: senior-review
action: ERROR
error_kind: invalid_config
message: "OrchestratorConfig.resumeCommand is required"
phase: null
phases_executed: 0
@@END@@
```

Invariant : `run_id` vaut `null` uniquement dans les erreurs preflight (avant génération/adoption du runId). Pour toute erreur après l'acquire du lock, `run_id` est toujours présent.

**Action attendue du parent agent** :

1. Présenter l'erreur à l'utilisateur.
2. **Ne pas** relancer automatiquement — l'utilisateur décide s'il veut retry.

#### 7.4.4 `action: ABORTED`

```
@@CC_ORCH@@
version: 1
run_id: 01HX...
orchestrator: senior-review
action: ABORTED
signal: SIGINT
phase: dispatch-reviews
@@END@@
```

Émis quand le process reçoit un signal OS. L'état est sauvegardé à la dernière transition stable. L'utilisateur peut relancer avec `config.resumeCommand(state.runId)` (qui inclut `--run-id <runId> --resume`).

### 7.5 events.ndjson — audit trail append-only

Fichier persistant écrit par le logger à `$RUN_DIR/events.ndjson`. Ajouté v0.3 suite à la décision §4.12 (snapshot-authoritative).

**Format** :

- NDJSON (newline-delimited JSON), UTF-8, fin de ligne LF.
- Une ligne = un event complet, sérialisé par `JSON.stringify` sans espaces inutiles.
- Append-only uniquement. Aucune ligne n'est jamais modifiée ou supprimée pendant la durée du run.
- Chaque ligne est un `OrchestratorEvent` valide au sens de §6.7.
- Ordre d'écriture = ordre d'émission (séquentiel, pas de réorganisation).

**Règles normatives d'écriture** :

- **Owner-only** (v0.8 C14) : le fichier n'est **écrit que par le process qui possède le lock**. Un contender bloqué sur `RunLockedError` (avant acquire) n'écrit pas. Garantit que l'audit trail appartient toujours à un seul owner par période de temps.
- Écriture synchrone avec `fs.appendFileSync` (pas async) pour garantir que l'event est sur disque avant que le runtime ne continue sa logique. Acceptable parce que les events sont rares (~5-30 par run typique, ~100 max pour un long run).
- Le fichier est créé au premier event émis par l'owner (typiquement `orchestrator_start` immédiatement après acquire lock), pas au démarrage du process.
- Pas de flush explicite après chaque write — `appendFileSync` flushe sur le `fd` mais le commit disque dépend du kernel. Accepté : un crash avant flush perd au maximum les derniers events en vol.
- Pas de rotation. Un run = un fichier (append sur plusieurs invocations du même owner). Le cleanup se fait via la rétention du RUN_DIR (§5.5).

**Différence stderr vs events.ndjson** :

| Aspect | stderr | events.ndjson |
|---|---|---|
| Visibilité en session | oui (affiché par l'agent parent) | non (fichier disque) |
| Persistance après fin de session | non | oui (jusqu'à cleanup RUN_DIR) |
| Override par `LoggingPolicy.logger` custom | oui | non (toujours écrit sauf `persistEventLog: false`) |
| Cross-reentry | chaque process a son propre stderr | un seul fichier append-only pour tout le run |

**Invariant normatif de reconstruction du flux** (§4.12) :

La concaténation ordonnée des lignes de `events.ndjson` doit permettre de reconstruire :

- La séquence des phases traversées (via `phase_start` / `phase_end` / transitions de `currentPhase`)
- Toutes les délégations émises, leurs tentatives, leurs résultats lus et leurs validations
- Les retries scheduled avec leurs raisons et délais
- Les erreurs rencontrées
- La durée totale du run (via `orchestrator_start` et `orchestrator_end`)

Cet invariant **ne couvre pas** `state.data` — voir §4.12 pour rationale. Un test de conformité (§19.3) vérifie cette propriété sur un run jouet.

---

## 8. Taxonomie d'erreurs

### 8.1 Classification transient vs permanent

Voir §6.6 pour la liste canonique.

- **Permanent (non retriable)** : `invalid_config`, `state_corrupted`, `state_missing`, `state_version_mismatch`, `delegation_missing_result`, `protocol`, `aborted`. Un retry ne changera rien.
- **Transient (retriable sous policy)** : `delegation_timeout`, `delegation_schema`.
- **Conditionnel** : `phase_error` — classifié selon le `cause` de l'exception utilisateur. Si `cause instanceof AbortedError` → permanent. Sinon → permanent (le runtime ne sait pas comment retry une phase utilisateur arbitraire — voir §8.3).

### 8.2 Retry sur délégation

Quand une délégation échoue (timeout, schéma invalide), le runtime :

1. Émet `retry_scheduled` avec `attempt + 1`, `delayMs`, et `reason`.
2. Attend `delayMs` via `abortableSleep` (composable avec abort externe).
3. **Ré-émet la délégation avec une nouvelle tentative** : nouveau `manifestPath = $RUN_DIR/delegations/<label>-<attempt+1>.json`, nouveaux `resultPath` per-attempt (§7.2), nouveau `emittedAtEpochMs`, nouveau `deadlineAtEpochMs = emittedAtEpochMs + timeoutMs` (§9.3 deadline per-attempt). Le manifest de la tentative précédente reste sur disque (pour debug forensique), le runtime ne le lit plus — la nouvelle tentative est une émission entièrement fraîche.
4. Source de reconstruction : lire l'ancien manifest à `pd.manifestPath`, copier tous les champs métier (`skill`, `skillArgs`, `agentType`, `prompt`, `jobs` et leurs prompts individuels), bumper `attempt`, recalculer les champs temporels et les chemins per-attempt, réécrire le nouveau manifest. `pendingDelegation` est mis à jour avec les nouvelles valeurs (label/kind/resumeAt/jobIds restent inchangés).

**Table de décision (avec `attempt` 0-indexé, condition retry : `attempt + 1 < maxAttempts`)** :

| Erreur | attempt + 1 < maxAttempts | Décision |
| --- | --- | --- |
| `DelegationTimeoutError` | true | `{ retry: true, delayMs: backoff, reason: "delegation_timeout" }` |
| `DelegationSchemaError` | true | `{ retry: true, delayMs: backoff, reason: "delegation_schema" }` |
| Tous retriables | false (épuisé) | `{ retry: false, reason: "retry_exhausted" }` → throw l'erreur originale |
| Tout le reste | n'importe | `{ retry: false, reason: "fatal_<kind>" }` → throw immédiat |

`backoff(attempt, policy) = min(policy.backoffBaseMs * 2^attempt, policy.maxBackoffMs)`.

Pas de jitter en v1 (cohérent avec `llm-runtime`).

### 8.3 Phase errors

Si une phase utilisateur throw, le runtime :

1. Catch l'exception
2. Émet `phase_error` avec le type et message
3. Wrap dans `PhaseError(cause)` et termine le run avec `ERROR` protocol
4. **Ne retry pas** la phase automatiquement en v1

Rationale : une phase utilisateur qui throw signifie probablement un bug dans le code de l'orchestrateur, pas une condition transient. Retry risque de masquer le bug. L'utilisateur relance manuellement si besoin (le state est préservé à la dernière transition stable).

### 8.4 Règle de non-confusion

Le consommateur (code de l'orchestrateur) ne devrait jamais rencontrer ces erreurs dans son code de phase — elles sont gérées par le runtime avant même d'arriver à la phase. Un orchestrateur qui voudrait **inspecter** une erreur de délégation doit utiliser une `try/catch` autour de son `io.consumePendingResult(...)` / `io.consumePendingBatchResults(...)` et gérer lui-même (mais le pattern par défaut est de laisser le runtime retry avant).

---

## 9. Policies

### 9.1 Structure globale

Les policies sont définies au niveau orchestrateur (`OrchestratorConfig`) et peuvent être overridées par délégation (`DelegationRequest.retry` / `.timeout`).

```ts
interface OrchestratorConfig<State> {
  // ...
  readonly retry?: RetryPolicy;
  readonly timeout?: TimeoutPolicy;
  readonly logging?: LoggingPolicy;
}
```

### 9.2 RetryPolicy

```ts
interface RetryPolicy {
  readonly maxAttempts: number;           // défaut 3
  readonly backoffBaseMs: number;         // défaut 1000
  readonly maxBackoffMs: number;          // défaut 30000
}
```

**Définition normative de `maxAttempts`** : nombre total maximal de tentatives, **attempt initial inclus**. Condition de retry : `attempt + 1 < maxAttempts` (attempt 0-indexé dans la boucle).

Avec `maxAttempts = 3`, le runtime exécute au plus 3 délégations : 1 initiale + 2 retries.

Override par délégation : `SkillDelegationRequest.retry` remplace **entièrement** la policy globale (pas de merge partiel).

### 9.3 TimeoutPolicy

```ts
interface TimeoutPolicy {
  readonly perDelegationMs: number;       // défaut 600000 (10 minutes)
}
```

**Propriétaire unique du timeout** : le runtime. Le parent agent n'a **aucune** responsabilité de timeout (cf §15.1). Cette règle supprime toute zone grise.

**Sémantique** : durée max entre l'émission `@@CC_ORCH@@ action: DELEGATE` et la disponibilité du fichier résultat, **mesurée en wall clock epoch ms** (cross-process safe) via `deadlineAtEpochMs = emittedAtEpochMs + timeoutMs`.

**Aucune reconstruction monotonic cross-process**. Le monotonic (`performance.now()`) est utilisé uniquement pour les durées intra-process (phase durations, sleep de retry). Tout le timing cross-process — incluant le deadline d'une délégation — vit en wall clock epoch ms.

**Sémantique per-attempt (pas global)** : chaque nouvelle tentative après timeout **recalcule son propre `deadlineAtEpochMs`** = `nowEpochMs_de_l_émission + timeoutMs`. Le deadline n'est **pas** un budget global initial partagé entre tentatives.

- Tentative 0 : émise à T0 → `deadline_0 = T0 + timeoutMs`.
- Si timeout à T0' > deadline_0 → retry scheduled, sleep backoff, ré-émission à T1.
- Tentative 1 : émise à T1 → `deadline_1 = T1 + timeoutMs` (recalculé, pas résiduel de deadline_0).
- `attempt` incrémenté et persisté dans `state.pendingDelegation.attempt` et `manifest.attempt`.
- `maxAttempts` capturé à la première émission et persisté dans `state.pendingDelegation.maxAttempts`.

Cette règle garantit que chaque tentative a sa fenêtre complète, même si le retry vient tard. Alternative rejetée : deadline global = N × timeoutMs ou budget résiduel — complexifie le raisonnement sans bénéfice concret.

**Pourquoi 10 minutes par défaut** : un sub-agent `senior-reviewer-file` sur Opus peut prendre 2-5 minutes. Un batch parallèle peut prendre 5-8 minutes total (parallélisme limité par la session). 10 min laisse de la marge sans être infini.

**Override par délégation** : toute délégation peut fixer son propre `timeout` via `DelegationRequest.timeout`. Recommandé pour les batches lourds (>10 jobs) ou les skills dont le runtime attendu est connu supérieur à 10 min.

**Cas du skill qui bloque** : si un skill invoqué via `delegateSkill` hang le parent agent (bloque sur input utilisateur par exemple), la session est gelée. Le runtime ne peut rien détecter tant que le parent n'a pas relancé `resume_cmd`. Discipline : un skill consommé en délégation ne doit jamais bloquer sur interaction. Hors scope runtime.

### 9.4 LoggingPolicy

Définition canonique en §6.8. La forme inclut `persistEventLog?: boolean` (défaut `true`) pour contrôler le double-write disque `$RUN_DIR/events.ndjson` (cf §7.5).

**Précision sur `enabled: false`** : coupe toute émission, y compris vers un `logger` injecté et vers `events.ndjson`. Pour une désactivation partielle, le logger injecté gère son propre filtre.

---

## 10. Décisions matérialisées

### 10.1 RetryDecision

```ts
interface RetryDecision {
  readonly retry: boolean;
  readonly delayMs?: number;
  readonly reason: string;
}

function resolveRetryDecision(
  error: OrchestratorError | Error,
  attempt: number,
  policy: RetryPolicy
): RetryDecision
```

Table définie en §8.2. Fonction pure, testable exhaustivement.

### 10.2 PhaseTransitionDecision

Pas matérialisée comme objet séparé — c'est directement le `PhaseResult` retourné par la phase.

### 10.3 DelegationDispatchDecision

Pas matérialisée comme objet — c'est le contenu du `DelegationRequest` passé à `io.delegate*`. Le binding construit le manifest et l'émet.

---

## 11. Observabilité

### 11.1 Sortie

- **Canal par défaut** : `stderr`
- **Format** : un objet JSON par ligne (NDJSON / JSONL)
- **Encodage** : UTF-8, fin de ligne LF
- **Logger injectable** : v1 permet de passer un `OrchestratorLogger` custom via `LoggingPolicy.logger`
- **Désactivable** : `LoggingPolicy.enabled = false` → zéro émission

### 11.2 BaseEvent (champs communs obligatoires)

```ts
interface BaseEvent {
  readonly eventType: string;
  readonly runId: string;
  readonly timestamp: string;             // ISO 8601
}
```

### 11.3 Taxonomie fermée v1 (11 types d'événements)

| eventType | Quand | Champs spécifiques |
| --- | --- | --- |
| `orchestrator_start` | Au premier démarrage du run | `orchestratorName`, `initialPhase` |
| `phase_start` | Avant chaque exécution de phase | `phase`, `attemptCount` |
| `phase_end` | Après chaque phase (succès ou retour de délégation) | `phase`, `durationMs`, `resultKind` |
| `delegation_emit` | Avant exit pour délégation | `phase`, `label`, `kind`, `jobCount` |
| `delegation_result_read` | Au début de la re-entry, après lecture des fichiers résultat (pas encore validés) | `phase`, `label`, `jobCount`, `filesLoaded` |
| `delegation_validated` | Quand `io.consumePendingResult` ou `io.consumePendingBatchResults` réussit la validation (appelé par la phase) | `phase`, `label` |
| `delegation_validation_failed` | Quand `io.consumePending*` échoue la validation zod | `phase`, `label`, `zodErrorSummary` (≤ 200 chars) |
| `retry_scheduled` | Après résultat invalide ou timeout, avant nouvelle tentative | `phase`, `label`, `attempt`, `delayMs`, `reason` |
| `phase_error` | Exception dans une phase utilisateur | `phase`, `errorKind`, `message` |
| `lock_conflict` | Conflit détecté sur le lock file (override d'un lock expiré OU release d'un lock volé) | `reason` (`"expired_override"` \| `"stolen_at_release"`), `currentOwnerToken?` |
| `orchestrator_end` | Terminaison (DONE, ERROR, ABORTED) | `orchestratorName`, `success`, `durationMs`, `phasesExecuted` |

### 11.4 Discipline de `orchestrator_end`

**Règle critique** : `orchestrator_end` est le résumé terminal canonique. Ses champs sont figés. Aucun champ de détail intermédiaire ne migre vers `orchestrator_end` (cf. §11.4 de `llm-runtime`). L'agrégation est la responsabilité du consommateur via `runId`.

### 11.5 Pas de PII dans les logs

Les prompts de délégation **ne sont jamais** loggés en clair. Ni les contenus de résultats.

Seules métriques : tailles (`jobCount`), identifiants (`runId`, `phase`, `label`), types (`eventType`, `kind`, `errorKind`), durées, booléens de validation.

**Exception contrôlée** : `phase_error.message` peut contenir un extrait ≤ 200 chars du message d'exception pour diagnostic. Les implémenteurs de phases doivent respecter cette limite (ne pas inclure des données utilisateur sensibles dans les messages d'erreur).

### 11.6 Invariant de corrélation

Tout event d'un même run partage le même `runId`. Le consommateur peut regrouper par `runId` pour reconstruire la trace complète, y compris à travers les multiples invocations du process (re-entries).

### 11.7 Event log persistant (v0.3)

En plus de stderr, chaque event est écrit append-only dans `$RUN_DIR/events.ndjson` (cf §7.5). Rôle : audit trail forensique survivant à la fin de la session.

**Invariant v0.3 — reconstruction du flux** : les lignes de `events.ndjson` d'un run complet permettent de reconstruire la séquence de phases, les délégations émises et leurs résultats (présence / retry / erreur), et les erreurs finales. Pas `state.data` (voir §4.12).

**Cas d'usage** :
- Debug post-mortem d'un run échoué : quelle phase a failli, quel retry a été scheduled, quel était l'`errorKind` final.
- Analyse de variance : comparer deux runs sur le même input → ordres de phases identiques ? Retries divergents ?
- Reporting agrégé (optionnel, out of scope runtime) : un CLI tiers pourrait parser tous les `events.ndjson` sous `.claude/run/cc-orch/` et produire des statistiques.

**Règles de durabilité** :
- Le fichier persiste jusqu'au cleanup automatique du RUN_DIR (rétention `config.retentionDays ?? 7`, §5.5).
- Ne jamais modifier ni tronquer le fichier après écriture d'une ligne.
- Les outils externes peuvent lire le fichier pendant qu'un run est actif (pas de lock exclusif).

---

## 12. Modèle temporel

### 12.1 Trois horloges distinctes

**Horloge murale ISO** (`new Date().toISOString()`) — utilisée pour :

- `StateFile.startedAt`, `StateFile.lastTransitionAt`
- `DelegationManifest.emittedAt`
- Tous les `timestamp` des événements de log (NDJSON)

Usage : timestamps humains, archivage, corrélation visible dans les logs.

**Horloge murale epoch ms** (`Date.now()`) — utilisée pour :

- `StateFile.startedAtEpochMs`, `StateFile.lastTransitionAtEpochMs`
- `DelegationManifest.emittedAtEpochMs`, `DelegationManifest.deadlineAtEpochMs`
- `PendingDelegationRecord.emittedAtEpochMs`, `PendingDelegationRecord.deadlineAtEpochMs`
- **Toute arithmétique cross-process** : vérification de deadline au resume, comparaison de timestamps entre deux invocations du process.

Usage : math déterministe cross-process, deadline survivant à un exit.

**Horloge monotone** (`performance.now()`) — utilisée pour :

- `phase_end.durationMs` (durée intra-process d'une phase)
- `accumulatedDurationMs` — accumulé dans le state par addition de durées intra-process (immun aux clock jumps)
- Sleep de retry via `AbortSignal.timeout(delayMs)` (monotone implicite)
- Timeouts intra-phase côté utilisateur (`fetch` avec signal, etc.)

Usage : mesures de durée intra-process, immunes aux clock jumps / NTP / daylight saving. **Jamais utilisée cross-process** — `performance.now()` est relatif au démarrage du process courant.

### 12.2 Règles normatives

- `durationMs` intra-phase est **toujours ≥ 0**. Garanti par l'usage de l'horloge monotone.
- Les timestamps wall clock peuvent sembler incohérents si l'horloge système jumpe entre deux re-entries — accepté. Pour les durées **intra-process**, `durationMs` monotonic reste fiable.
- **Règle cross-process — wall clock uniquement** : tout calcul qui doit survivre à un exit/re-entry (deadline d'une délégation, timestamps de corrélation, `accumulatedDurationMs` cumulé) utilise **wall clock epoch ms**. Le runtime n'essaie **jamais** de reconstituer une horloge monotone cross-process — `performance.now()` est relatif au démarrage du process courant et n'a aucune validité cross-process.
- **Règle intra-process — monotonic** : les durées mesurées à l'intérieur d'une invocation du process (durée d'une phase, sleep de retry, timeout de fetch utilisateur) utilisent monotonic. Le résultat est immun aux clock jumps système.
- **Accumulation cumulative** : `state.accumulatedDurationMs` est incrémenté à la fin de chaque phase par sa durée monotonic intra-process. Cette somme est stable cross-process parce qu'elle n'implique que des deltas intra-process, eux-mêmes immuns aux jumps.

### 12.3 Abstraction via module `clock`

```ts
export const clock = {
  nowWall: () => new Date(),                   // wall clock Date
  nowWallIso: () => new Date().toISOString(),  // wall clock ISO 8601
  nowEpochMs: () => Date.now(),                // wall clock epoch ms — pour deadline cross-process
  nowMono: () => performance.now(),            // monotonic — pour durées intra-process
};
```

**Discipline d'usage** :
- `nowWallIso` : timestamps d'events de log, `StateFile.startedAt`, `StateFile.lastTransitionAt`, `DelegationManifest.emittedAt`.
- `nowEpochMs` : `StateFile.startedAtEpochMs`, `lastTransitionAtEpochMs`, `DelegationManifest.emittedAtEpochMs`, `deadlineAtEpochMs`. Toute arithmétique cross-process.
- `nowMono` : `phase_end.durationMs`, computation des durées de phase, sleeps internes (`await abortableSleep`).

Pour les tests, ce module est mocké pour permettre des tests déterministes sur les durées et les deadlines.

### 12.4 Tests critiques

- **Test cumul durée cross-reentry** : un run qui s'étale sur plusieurs re-entries (simulées par reset du mock `performance.now` entre deux invocations du dispatcher) produit un `state.accumulatedDurationMs` qui est exactement la somme des durées intra-process de toutes les phases, sans double-comptage.
- **Test deadline cross-reentry** : une délégation émise avec `timeoutMs: 1000` et un mock `nowEpochMs()` qui avance de 2000 entre l'émission et la re-entry (sans résultat présent) fait throw `DelegationTimeoutError` au resume. Aucune reconstruction monotonic tentée.
- **Test clock jump immunité** : un mock de `nowWall()` qui jumpe en arrière de 10s pendant une phase produit toujours un `phase_end.durationMs` positif correct (monotonic n'est pas affecté).

---

## 13. Gestion des signaux

### 13.1 Signaux OS gérés

- `SIGINT` (Ctrl+C) : exit code 130
- `SIGTERM` : exit code 143
- `SIGKILL` : non gérable par le process (comportement : process meurt, état à la dernière transition stable préservé, aucune émission `@@CC_ORCH@@`)

### 13.2 Handler normatif

Au démarrage, le runtime installe :

```ts
process.on("SIGINT",  () => abortRun("SIGINT",  130));
process.on("SIGTERM", () => abortRun("SIGTERM", 143));

async function abortRun(signal: string, code: number) {
  // 1. Flush logger
  logger.emit({ eventType: "phase_error", ..., message: `Received ${signal}` });
  logger.emit({ eventType: "orchestrator_end", success: false, ... });

  // 2. Emit ABORTED protocol block
  process.stdout.write(protocol.buildBlock("ABORTED", { signal, phase: currentPhase }));

  // 3. State: déjà à la dernière transition stable (atomic write à chaque transition)
  // Pas de write supplémentaire — état déjà safe.

  // 4. Release du lock (v0.4) : re-lire .lock, vérifier ownerToken, unlink si match.
  //    Si mismatch → emit lock_conflict "stolen_at_release", skip unlink.
  //    SIGKILL ne passe pas par ici : lock reste, expire via lease (§4.13).
  releaseLockIfOwner();

  process.exit(code);
}
```

### 13.3 Règles de priorité

| Situation | Comportement |
| --- | --- |
| SIGINT pendant une phase mécanique | Phase interrompue à la prochaine `await`, abort propre |
| SIGINT pendant le sleep de retry | Sleep interrompu immédiatement via `AbortSignal` |
| SIGINT pendant l'attente d'un résultat de délégation | N/A — le process a déjà exit, le sleep est côté agent parent |

### 13.4 Abort propagé dans le code utilisateur

Le runtime expose `io.signal: AbortSignal` qui abort sur réception de SIGINT/SIGTERM. Les phases peuvent l'utiliser dans leurs propres awaits longues (ex: `fetch`, `readFile` avec signal, etc.).

### 13.5 Timer ownership

Aucun `setTimeout` ne doit survivre à un exit du process. Le runtime n'a pas de `setTimeout` long-running en v1 (les sleeps de retry sont `await abortableSleep(delayMs, signal)` et finissent avant exit).

---

## 14. Flux d'exécution end-to-end

### 14.1 Invocation initiale (premier démarrage du run)

```
runOrchestrator(config: OrchestratorConfig<State>)

1. Valider config (cf §6.1). Si invalide → émettre bloc ERROR minimal preflight (§4.4 bis, `run_id: null` puisque pas encore généré, `orchestrator: config.name ?? "unknown"`, `error_kind: "invalid_config"`) puis exit(1). Pas de throw brut.
2. Parse argv :
   - --resume             : mode resume (§14.2, requiert `--run-id`)
   - --run-id <ulid>      : identifie le run (obligatoire en mode resume ; optionnel en mode initial, généré par le runtime sinon)
   Si `--resume` absent → mode initial.
3. **Générer ou adopter le `runId`** (avant toute résolution de chemin) :
   - Si argv contient `--run-id <ulid>` → adopter cette valeur (utile pour tests déterministes).
   - Sinon → générer via `ulid()`.
   **Invariant CWD** : le RUN_DIR est résolu relatif au cwd du process. Pour qu'une reprise retrouve son state, le parent agent doit relancer `resume_cmd` **depuis le même cwd** que la première invocation. Dans une session Claude Code, cette invariance est naturelle (le cwd ne change pas pendant la session).
4. Résoudre RUN_DIR = `<cwd>/.claude/run/cc-orch/<config.name>/<runId>/`.
5. Créer RUN_DIR et sous-dossiers (`delegations/`, `results/`) si absents. `events.ndjson` est créé au premier event émis (pas ici).
6. **Installer le stderr logger uniquement** (pas encore events.ndjson). Permet d'émettre les events d'erreur preflight / RunLockedError sans polluer le disque.
7. **Acquire du lock** (§4.13) :
    - Générer `ownerToken = ulid()` (distinct du `runId`, source de vérité de possession).
    - Tenter `openSync("$RUN_DIR/.lock", "wx")` (O_EXCL).
    - Si `EEXIST` : lire le lock existant, comparer `nowEpoch` à `leaseUntilEpochMs`.
      * Si `nowEpoch < leaseUntilEpochMs` (lock actif) → construire `RunLockedError` avec `ownerPid`, `acquiredAtEpochMs`, `leaseUntilEpochMs` existants. Log `phase_error` (errorKind: "run_locked"). Log `orchestrator_end` (success: false). Emit `@@CC_ORCH@@ action: ERROR error_kind: run_locked message: "Run {runId} is locked by PID {ownerPid}, lease expires at {leaseUntilIso}"`. exit(2).
      * Si `nowEpoch >= leaseUntilEpochMs` (lock expiré) → override : écrire le nouveau lock via tmp+rename, émettre event `lock_conflict` (reason: "expired_override", currentOwnerToken: ancien token).
    - Écrire initial `LockFile { ownerPid: process.pid, ownerToken, acquiredAtEpochMs: nowEpoch, leaseUntilEpochMs: nowEpoch + DEFAULT_IDLE_LEASE_MS }`.
    - Garder `ownerToken` en RAM pour les updates et release.
    - **Activer le events.ndjson logger** (v0.8 C14) : seul un owner process écrit dans `events.ndjson`. Un contender bloqué à l'étape 7 (RunLockedError) n'a pas franchi ce gate → pas de pollution du log disque du run actuel.
8. nowEpoch = clock.nowEpochMs() ; nowIso = clock.nowWallIso()
9. Log orchestrator_start.
10. initialPhase = config.initial  (valeur utilisée uniquement pour la construction du StateFile initial step 11 ; ensuite la source unique est state.currentPhase, relue à chaque itération de la boucle step 16.a)
11. state = StateFile initial (§7.1) :
    {
      schemaVersion: 1, runId, orchestratorName: config.name,
      startedAt: nowIso, startedAtEpochMs: nowEpoch,
      lastTransitionAt: nowIso, lastTransitionAtEpochMs: nowEpoch,
      currentPhase: initialPhase, phasesExecuted: 0, accumulatedDurationMs: 0,
      data: config.initialState,             // required v0.6, pas de fallback {}
      pendingDelegation: undefined,
      usedLabels: [],                        // registre des labels de délégation (§7.1)
    }
12. Valider state.data via config.stateSchema si présent.
13. Persister state.json initial (atomic, §4.3).
14. Installer handlers SIGINT/SIGTERM (§13.2).
15. Cleanup runs anciennes (run-dir.cleanupOldRuns, ne jamais toucher le RUN_DIR courant).

16. Entrée dans la boucle de dispatch :
    while (true) {
      a. **Source unique de la phase courante** : `currentPhase = state.currentPhase` (relire depuis le state à chaque itération, pas de variable locale cachée). phaseFn = config.phases[currentPhase].
         Si undefined → throw interne ProtocolError("unknown phase: " + currentPhase) — capté par le top-level handler de runOrchestrator (§4.4 C13), qui émet ERROR + exit.
      b. **Refresh lock phase-start** (§4.13) : recalcul `leaseUntilEpochMs = nowEpoch + DEFAULT_IDLE_LEASE_MS` (lease idle simple, v0.8 M25). Écriture atomique tmp+rename, vérification ownerToken.
      c. consumedCount = 0 — compteur per-phase des appels consumePending* (doit être exactement 1 en phase de reprise, 0 en phase non-reprise).
      d. committed = false — flag per-phase pour enforcer le single PhaseResult.
      e. frozenState = deepFreeze(structuredClone(state.data)) — state gelé en profondeur passé à la phase. Mutation → TypeError natif Node, y compris en production.
      f. io = construire PhaseIO avec :
         - transition/delegate*/done/fail qui : si committed → throw ProtocolError("PhaseResult already committed") ; sinon committed=true + retourne factory result.
         - logger, clock, runId, args, runDir
         - signal: abortController.signal
         - refreshLock() qui appelle la logique §4.13 (recalcul leaseUntilEpochMs + tmp+rename)
         - consumePendingResult(schema) (cf spec §6.3) : lit `$RUN_DIR/results/<label>-<attempt>.json` per-attempt, valide, marque consumedCount++.
         - consumePendingBatchResults(schema) (cf spec §6.3) : lit `$RUN_DIR/results/<label>-<attempt>/<jobId>.json` pour chaque jobId, valide, marque consumedCount++.
      g. Log phase_start (attemptCount = state.pendingDelegation?.attempt + 1 ?? 1).
      h. phaseStartMono = clock.nowMono()
      i. Try { result = await phaseFn(frozenState, io, input) }
         Catch (err) {
           Si err instanceof DelegationSchemaError ET state.pendingDelegation existe ET retry budget restant :
             * pd = state.pendingDelegation (source de vérité pour kind, label, resumeAt, jobIds, maxAttempts)
             * decision = resolveRetryDecision(err, pd.attempt, pd.effectiveRetryPolicy)  (policy capturée à l'émission initiale, cf §7.1 M26)
             * Si decision.retry === true :
               - Log retry_scheduled (attempt: pd.attempt + 1, delayMs, reason: "delegation_schema")
               - await abortableSleep(decision.delayMs, io.signal)
               - **Reconstruction du nouveau manifest** :
                 * oldManifest = JSON.parse(fs.readFileSync(pd.manifestPath))  — source de vérité pour `skill`, `skillArgs`, `agentType`, `prompt`, `jobs[].prompt`, `timeoutMs` initial.
                 * newAttempt = pd.attempt + 1
                 * newEmittedAtEpochMs = clock.nowEpochMs()
                 * newDeadlineAtEpochMs = newEmittedAtEpochMs + oldManifest.timeoutMs  — on réutilise le timeoutMs de l'émission initiale (policy capturée à emission initiale, pas recalculée)
                 * newManifestPath = `$RUN_DIR/delegations/<pd.label>-<newAttempt>.json`
                 * newResultPaths per-attempt (§7.2) :
                   - kind "skill" | "agent" : `$RUN_DIR/results/<pd.label>-<newAttempt>.json`
                   - kind "agent-batch" : pour chaque jobId, `$RUN_DIR/results/<pd.label>-<newAttempt>/<jobId>.json`
                 * newManifest = { ...oldManifest, attempt: newAttempt, emittedAt: clock.nowWallIso(), emittedAtEpochMs: newEmittedAtEpochMs, deadlineAtEpochMs: newDeadlineAtEpochMs, resultPath: (skill/agent) newResultPaths, jobs: (batch) oldManifest.jobs.map(j => ({ ...j, resultPath: `$RUN_DIR/results/<pd.label>-<newAttempt>/<j.id>.json` })) }
                 * Persister newManifest à newManifestPath (atomic)
                 * state.pendingDelegation = { ...pd, attempt: newAttempt, emittedAtEpochMs: newEmittedAtEpochMs, deadlineAtEpochMs: newDeadlineAtEpochMs, manifestPath: newManifestPath }  (effectiveRetryPolicy inchangé, capturé à l'émission initiale, cf §7.1)
                 * Persister state (atomic)
               - Log delegation_emit (avec nouveau attempt)
               - Emit @@CC_ORCH@@ action: DELEGATE (avec nouveau manifestPath et resume_cmd inchangé)
               - **Release lock** (§4.13) avant exit.
               - exit(0)  [lock libre, re-entry ré-acquiert via O_EXCL]
           Sinon (err non retriable, ou retry exhausted, ou autre exception) :
             * Log phase_error (errorKind: err instanceof OrchestratorError ? err.kind : "phase_error", message: err.message.slice(0, 200))
             * Log orchestrator_end (success: false, durationMs: accumulatedDurationMs)
             * Emit @@CC_ORCH@@ action: ERROR (error_kind, message)
             * **Release lock** (§4.13) : re-lecture .lock, vérification ownerToken, unlink si match (sinon emit lock_conflict)
             * exit(1)
         }
      j. phaseDurationMs = Math.round(clock.nowMono() - phaseStartMono)
      k. accumulatedDurationMs += phaseDurationMs
      l. **Consumption check** (uniquement en mode re-entry, c.-à-d. si state.pendingDelegation était défini à l'entrée de la phase) :
         Soit expectedLabel = state.pendingDelegation.label (capturé au début de la phase).
         Si consumedCount !== 1 :
           * Log phase_error (errorKind: "protocol", message: consumedCount === 0 ? "unconsumed delegation: " + expectedLabel : "multiple consume calls on same delegation: " + expectedLabel)
           * Log orchestrator_end (success: false)
           * Emit @@CC_ORCH@@ action: ERROR (error_kind: protocol)
           * Release lock
           * exit(1)
      m. Log phase_end (phase, durationMs, resultKind).
      n. Switch sur result.kind :

         - "transition":
           * Valider result.nextPhase existe dans config.phases (sinon throw interne ProtocolError → ERROR + exit).
           * state.data = result.nextState
           * state.currentPhase = result.nextPhase  (**source unique** ; l'itération suivante lira via step a)
           * state.phasesExecuted += 1
           * state.lastTransitionAt = clock.nowWallIso()
           * state.lastTransitionAtEpochMs = clock.nowEpochMs()
           * state.accumulatedDurationMs = accumulatedDurationMs
           * state.pendingDelegation = undefined
           * input = result.input  (in-process only, cf §6.2 — non persisté)
           * Persister state.json (atomic).
           * Continue boucle (retour step a, qui relira state.currentPhase).

         - "delegate":
           * **Binding explicite** :
             - const request = result.request
             - const label = request.label
             - const kind = request.kind
             - const resumeAt = result.resumeAt  (au niveau PhaseResult, pas dans request)
           * Valider resumeAt existe dans config.phases (sinon throw interne ProtocolError → ERROR + exit).
           * Valider label kebab-case non vide ET `label ∉ state.usedLabels` (unicité au run, §7.1 M19). Si collision → throw interne ProtocolError("duplicate label: " + label) → ERROR + exit.
           * const attempt = 0  (première émission ; retries gérés par le catch step i et §14.2).
           * **Capture de la RetryPolicy effective** (v0.8 M26) : `effectiveRetryPolicy = { maxAttempts: request.retry?.maxAttempts ?? config.retry?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS, backoffBaseMs: request.retry?.backoffBaseMs ?? config.retry?.backoffBaseMs ?? DEFAULT_BACKOFF_BASE, maxBackoffMs: request.retry?.maxBackoffMs ?? config.retry?.maxBackoffMs ?? DEFAULT_MAX_BACKOFF }`. Override partiel supporté : chaque champ résolu indépendamment. Persisté dans `pendingDelegation.effectiveRetryPolicy`.
           * const timeoutMs = request.timeout?.perDelegationMs ?? config.timeout?.perDelegationMs ?? défaut.
           * const emittedAtEpochMs = clock.nowEpochMs() ; const emittedAt = clock.nowWallIso()
           * const deadlineAtEpochMs = emittedAtEpochMs + timeoutMs
           * const manifest = binding.buildManifest(request, { runId, phase: state.currentPhase, resumeAt, attempt, maxAttempts, emittedAt, emittedAtEpochMs, timeoutMs, deadlineAtEpochMs })
             * **Chemins de résultat per-attempt** (§7.2) :
               - kind "skill" | "agent" : resultPath = `$RUN_DIR/results/<label>-<attempt>.json`
               - kind "agent-batch" : pour chaque job, job.resultPath = `$RUN_DIR/results/<label>-<attempt>/<jobId>.json`
           * const manifestPath = `$RUN_DIR/delegations/<label>-<attempt>.json`
           * Persister manifest (atomic).
           * state.data = result.nextState
           * state.pendingDelegation = { label, kind, resumeAt, manifestPath, emittedAtEpochMs, deadlineAtEpochMs, attempt, effectiveRetryPolicy, jobIds (si batch, sinon undefined) }
           * state.usedLabels = [...state.usedLabels, label]  (append-only, cf §7.1)
           * state.lastTransitionAt = emittedAt ; state.lastTransitionAtEpochMs = emittedAtEpochMs
           * state.phasesExecuted += 1 ; state.accumulatedDurationMs = accumulatedDurationMs
           * Persister state.json (atomic).
           * Log delegation_emit.
           * Construire `resume_cmd = config.resumeCommand(runId)` (§6.1 champ required).
           * Emit @@CC_ORCH@@ action: DELEGATE sur stdout (bloc §7.4.1, champ `resume_cmd`).
           * **Release lock** (§4.13) avant exit : re-lire `.lock`, vérifier ownerToken, unlink si match (sinon emit `lock_conflict` "stolen_at_release").
           * exit(0). [Lock libre. La re-entry suivante ré-acquiert via O_EXCL proprement.]

         - "done":
           * Écrire $RUN_DIR/output.json (atomic) avec result.output (JSON-sérialisé).
           * state.phasesExecuted += 1 ; state.accumulatedDurationMs = accumulatedDurationMs
           * state.pendingDelegation = undefined
           * Persister state.json final (atomic).
           * Log orchestrator_end (success: true, durationMs: accumulatedDurationMs).
           * Emit @@CC_ORCH@@ action: DONE.
           * **Release lock** (§4.13) : re-lecture, vérification ownerToken, unlink si match.
           * exit(0).

         - "fail":
           * state.phasesExecuted += 1 ; state.accumulatedDurationMs = accumulatedDurationMs
           * Persister state.json (atomic).
           * Log phase_error (errorKind, message: result.error.message).
           * Log orchestrator_end (success: false, durationMs).
           * Emit @@CC_ORCH@@ action: ERROR (error_kind: result.error.kind ?? "phase_error", message).
           * **Release lock** (§4.13).
           * exit(1).
      }
    }
```

### 14.2 Re-entry après délégation (--resume)

```
runOrchestrator invoqué avec argv contenant --resume et --run-id <ulid>

1. Valider config (comme §14.1 step 1). Si invalide → émettre bloc ERROR preflight (`run_id: null`, `error_kind: invalid_config`) + exit(1).
2. Parse argv : `--resume` + `--run-id <ulid>` obligatoires. Si `--run-id` absent → émettre bloc ERROR preflight (`run_id: null`, `error_kind: invalid_config`, message: `"--resume requires --run-id"`) + exit(1).
3. Adopter `runId = argv["run-id"]`.
4. Résoudre RUN_DIR = `<cwd>/.claude/run/cc-orch/<config.name>/<runId>/` (invariance CWD cf §14.1 step 3).
5. Vérifier RUN_DIR existe. Sinon → émettre bloc ERROR (`run_id: <runId>` maintenant disponible, `error_kind: state_missing`) + exit(1).
6. Lire state.json. Valider schemaVersion. Valider state.data via config.stateSchema si présent. En cas d'échec → émettre bloc ERROR (`error_kind: state_corrupted` ou `state_version_mismatch`) + exit(1).
7. Vérifier `state.runId === runId` et `state.orchestratorName === config.name`. Sinon → émettre bloc ERROR (`error_kind: protocol`, message: `"RUN_DIR mismatch with argv — likely wrong cwd or corrupted state"`) + exit(1).
8. Installer le stderr logger uniquement (C14, pas encore events.ndjson).
9. Installer handlers SIGINT/SIGTERM.
10. **Acquire du lock** (§4.13, identique à §14.1 step 7) : tentative O_EXCL, gestion du lock expiré ou actif (RunLockedError si actif). Génération ownerToken. Écriture initiale avec `leaseUntilEpochMs = nowEpoch + DEFAULT_IDLE_LEASE_MS` (idle simple v0.8 M25, plus de lease dynamique basé sur deadline). Après acquire réussi, activer le events.ndjson logger (owner-only, C14).

11. Identifier la délégation active :
   a. pd = state.pendingDelegation
   b. Si pd === undefined → throw ProtocolError("resume without pending delegation"). Ne devrait jamais arriver en flow nominal.

12. Vérifier deadline, présence ET parseabilité des résultats (wall-clock epoch, §9.3) :
    a. nowEpoch = clock.nowEpochMs()
    b. Pour chaque chemin de résultat attendu (per-attempt, §7.2) :
       - kind "skill" ou "agent" : `$RUN_DIR/results/<label>-<attempt>.json`
       - kind "agent-batch" : pour chaque id dans pd.jobIds, `$RUN_DIR/results/<label>-<attempt>/<id>.json`
       Classification :
       * Si fichier **absent** → marquer "missing".
       * Si fichier **présent mais JSON unparseable** → marquer "malformed". Logguer uniquement : `path` (chemin runtime sans PII), `fileSizeBytes` (pour distinguer vide/tronqué/gros blob). **Ne JAMAIS logger d'extrait du contenu ni du message d'erreur `JSON.parse`** — la PII policy (§11.5) est stricte sur le non-logging de contenus en clair.
       * Si fichier **présent et JSON parseable** → marquer "parseable" et charger en mémoire.
    c. resultsState = {
         allParseable: tous les fichiers attendus sont "parseable",
         anyMalformed: au moins un fichier est "malformed",
         allPresent: tous les fichiers attendus sont "parseable" ou "malformed" (aucun "missing"),
       }
       deadlinePassed = nowEpoch > pd.deadlineAtEpochMs
    d. Décision (table complète) :
       - Si `resultsState.allParseable === true` → continuer au step 13 (deadline ignorée, résultats présents et parseables).
       - Si `resultsState.anyMalformed === true` → **DelegationSchemaError immédiate** (JSON cassé, pas une absence). Décision retry :
         * decision = resolveRetryDecision(new DelegationSchemaError("malformed JSON in result file"), pd.attempt, pd.effectiveRetryPolicy)
         * Si decision.retry === true → ré-émettre (cf branche retry ci-dessous e).
         * Sinon → log phase_error + orchestrator_end + Emit ERROR (error_kind: delegation_schema) + Release lock + exit(1).
       - Si `resultsState.allPresent === false && deadlinePassed === true` → **DelegationTimeoutError**. Décision retry :
         * decision = resolveRetryDecision(new DelegationTimeoutError(), pd.attempt, pd.effectiveRetryPolicy)
         * Si decision.retry === true → ré-émettre (cf branche retry ci-dessous e).
         * Sinon → log phase_error + orchestrator_end + Emit ERROR (error_kind: delegation_timeout) + Release lock + exit(1).
       - Si `resultsState.allPresent === false && deadlinePassed === false` → bug (parent agent a relancé resume_cmd trop tôt). **DelegationMissingResultError**. Ce cas n'est pas retried automatiquement (différence volontaire avec timeout). Log phase_error + orchestrator_end + Emit ERROR + Release lock + exit(1).
    e. **Branche retry commune (DelegationSchemaError ou DelegationTimeoutError avec decision.retry === true)** :
       * Log retry_scheduled (attempt: pd.attempt + 1, delayMs: decision.delayMs, reason: "delegation_schema" ou "delegation_timeout").
       * await abortableSleep(decision.delayMs, io.signal).
       * **Reconstruction du nouveau manifest** (même logique que §14.1 step i catch) :
         - oldManifest = JSON.parse(fs.readFileSync(pd.manifestPath))
         - newAttempt = pd.attempt + 1
         - newEmittedAtEpochMs = clock.nowEpochMs() ; newDeadlineAtEpochMs = newEmittedAtEpochMs + oldManifest.timeoutMs
         - newManifestPath = `$RUN_DIR/delegations/<pd.label>-<newAttempt>.json`
         - newResultPath(s) per-attempt (§7.2)
         - newManifest = { ...oldManifest, attempt: newAttempt, emittedAt: clock.nowWallIso(), emittedAtEpochMs, deadlineAtEpochMs, resultPath(s) mis à jour }
         - Persister newManifest (atomic).
         - state.pendingDelegation = { ...pd, attempt: newAttempt, emittedAtEpochMs, deadlineAtEpochMs, manifestPath: newManifestPath }  (effectiveRetryPolicy inchangé, cf §7.1)
         - Persister state (atomic).
       * Log delegation_emit.
       * Emit @@CC_ORCH@@ action: DELEGATE (avec nouveau manifestPath, resume_cmd inchangé).
       * **Release lock** (§4.13) avant exit.
       * exit(0). [Lock libre, re-entry ré-acquiert.]

13. Les résultats parseables (step 12.b) sont maintenant en mémoire (loadedResults). Log delegation_result_read (jobCount: pd.jobIds?.length ?? 1, filesLoaded: nombre de JSON effectivement chargés). Pas de champ validation ici — la validation schema arrive lazy via `io.consumePending*()` et émet `delegation_validated` / `delegation_validation_failed`.

14. Transition vers resumeAt :
    a. state.currentPhase = pd.resumeAt (en mémoire, pas encore persisté).
    b. state.pendingDelegation **reste en place** jusqu'à consommation réussie ET traitement du PhaseResult (cleanup au §14.1 step 16.n, cohérent avec §7.1).

15. Entrée dans la boucle de dispatch (§14.1 step 16) avec :
    - Un PhaseIO qui capture loadedResults pour que consumePendingResult/consumePendingBatchResults puisse y piocher.
    - consumedCount initialisé à 0 au début de la phase de reprise (cohérent avec §14.1 step 16.c).

16. Consumption check exact-once (§14.1 step 16.l — référence canonique ici) :
    a. Après que la phase de reprise a retourné son PhaseResult (transition, delegate, done, fail) et AVANT de traiter ce résultat :
       Si consumedCount !== 1 :
         - Log phase_error (errorKind: "protocol", message: consumedCount === 0 ? "unconsumed delegation: " + pd.label : "multiple consume calls on same delegation").
         - Log orchestrator_end (success: false).
         - Emit @@CC_ORCH@@ action: ERROR (error_kind: protocol, message).
         - Release lock.
         - exit(1).
    b. La règle "double consommation" est aussi enforce in-line par consumePending*() (cf §14.1 step 16.f). Un second appel dans la même phase throw ProtocolError immédiatement, propage à la phase utilisateur puis au catch §14.1 step 16.i.
    c. Si consumption exactly-once et la phase a réussi, cleanup : state.pendingDelegation = undefined (persisté dans le state.json écrit au step 16.n de §14.1 selon le résultat).
```

**Invariants clés** :

- Le runtime **ne valide jamais** lui-même les JSON résultats. La validation est faite **uniquement** par `io.consumePendingResult(schema)` ou `io.consumePendingBatchResults(schema)` appelé par la phase. Le runtime lit les fichiers bruts en mémoire et les expose.
- Le runtime **enforce** `consumedCount === 1` **exactement** à la fin de la phase de reprise. Zéro ou deux appels → `ProtocolError`. Wrong-kind (consumePendingResult sur batch ou inverse) → `ProtocolError` immédiat.
- Le deadline est **cross-process via wall-clock epoch ms**. Aucune reconstruction monotonic.
- Le retry re-calcule son propre deadline à partir du now de la nouvelle émission (per-attempt, §9.3), jamais un deadline résiduel global.
- Les chemins de résultat sont **per-attempt** (§7.2) — un sub-agent orphelin d'une tentative précédente ne peut pas polluer la tentative courante.

### 14.3 Représentation de `pendingDelegation` dans state

Voir §7.1 pour la forme canonique unique (incluant `PendingDelegationRecord`). Cette section ne redéfinit plus le schéma — elle pointe vers §7.1.

**Règle d'écriture** : `pendingDelegation` est :
- Écrit juste avant l'exit pour délégation (§14.1 step 16.n "delegate").
- Mis à jour avec un nouveau `attempt`/`emittedAtEpochMs`/`deadlineAtEpochMs`/`manifestPath` lors d'un retry après timeout (§14.2 step 12.e) ou après DelegationSchemaError (§14.1 step 16.i catch).
- Effacé (set à `undefined`) au **traitement du PhaseResult** de la phase de reprise, persisté dans le state écrit au §14.1 step 16.n ("transition"/"done"/"fail"). **Pas au début** de la phase de reprise (cf §7.1 règle de durabilité cross-crash).

### 14.4 Phases parallèles ?

**Non en v1**. Une phase est exécutée à la fois. Les parallélismes sont :

- Dans une phase : l'auteur peut utiliser `Promise.all` pour paralléliser des IO externes (fetches, reads).
- Entre phases : **une seule délégation active** à la fois en v1. Pour paralléliser des délégations, l'auteur utilise `delegateAgentBatch` qui représente N jobs parallèles dans une seule délégation.

Rationale : permet un state simple (une seule `pendingDelegation` à la fois). Extension v2 possible pour parallélisme inter-phases si besoin.

### 14.5 Note de discipline du flow

Toutes les erreurs intermédiaires (phase user throw, validation schema échoue, timeout délégation) passent par **un seul point de throw** côté engine. Un auteur d'orchestrateur ne voit jamais ces erreurs dans son code normal — elles sont gérées en amont. Tentation à refuser : émettre un `@@CC_ORCH@@ action: ERROR` depuis le binding ou un service transverse. Un seul point d'émission protocol : l'engine (§14.1 step 16.n "fail" et step 16.i catch, §14.2 step 12.d).

---

## 15. Protocole d'interaction avec l'agent parent

Cette section est **normative pour l'agent parent**. Elle doit être reproduite intégralement dans le SKILL.md d'un orchestrateur consommateur. Sinon l'agent parent ne sait pas comment interagir avec le runtime.

### 15.1 Boucle de l'agent parent

**Invariance critique — CWD** : toutes les invocations successives d'un même run (initiale + toutes les re-entries via `resume_cmd`) doivent s'exécuter depuis **le même cwd**. Le RUN_DIR est résolu relatif à ce cwd (§14.1 step 3). Dans une session Claude Code standard, cette invariance est naturelle (le cwd ne change pas). Si le parent agent change explicitement de cwd entre deux Bash calls, il casse le run. À ne **jamais** faire.

```
POUR CHAQUE invocation de l'orchestrateur :

1. Lancer la commande Bash initiale depuis le cwd de référence (typiquement racine du repo cible) :
   bun run /chemin/vers/main.ts [args...]

   Note : la première invocation ne passe PAS --run-id ; le runtime en génère un et l'inclura dans `resume_cmd` à chaque délégation.

2. Lire STDOUT de la commande jusqu'à trouver un bloc @@CC_ORCH@@ ... @@END@@.

3. Parser le bloc :
   - Extraire 'action'
   - Extraire les autres champs (manifest, output, error_kind, etc.)

4. Selon 'action' :

   CAS DELEGATE :
     a. Lire le fichier manifest.json au chemin 'manifest'.
     b. Selon manifest.kind :

        SKILL :
          Invoquer via Skill tool :
            Skill({
              skill: manifest.skill,
              args: manifest.skillArgs
            })
          LE SKILL INVOQUÉ EST RESPONSABLE d'écrire son résultat à manifest.resultPath
          (qui est un chemin per-attempt de la forme <label>-<attempt>.json depuis v0.4).
          (Cette discipline est documentée dans chaque skill utilisé en délégation.)

        AGENT :
          Invoquer via Agent tool :
            Agent({
              subagent_type: manifest.agentType,
              description: "{label}",
              prompt: manifest.prompt + "\n\nWrite your JSON result to:\n" + manifest.resultPath
            })
          (manifest.resultPath est per-attempt : <label>-<attempt>.json depuis v0.4.)

        AGENT-BATCH :
          Invoquer N Agent tools DANS UN SEUL MESSAGE :
            pour chaque job dans manifest.jobs :
              Agent({
                subagent_type: manifest.agentType,
                description: "{label}-{job.id}",
                prompt: job.prompt + "\n\nWrite your JSON result to:\n" + job.resultPath
              })
          TOUS dans le même message = exécution parallèle.
          (job.resultPath est per-attempt : <label>-<attempt>/<jobId>.json depuis v0.4.)

     c. Attendre la complétion naturelle des sub-tours (skill terminé, ou tous les Agent batch rendus). L'agent parent NE gère AUCUN timeout — ni par skill, ni par agent, ni par batch. Il attend simplement la fin naturelle des invocations.
     d. Relancer la commande indiquée dans 'resume_cmd' via Bash tool. Si un sub-agent n'a pas écrit son résultat (échec de discipline côté sub-agent), relancer quand même — c'est le runtime qui détectera au resume si la deadline a été dépassée et décidera retry ou fail.
     e. Retour à l'étape 2.

   CAS DONE :
     a. Lire le fichier JSON au chemin 'output'.
     b. Présenter le contenu à l'utilisateur (ou transmettre au parent en composition récursive).
     c. Fin de la boucle.

   CAS ERROR :
     a. Afficher 'error_kind' et 'message' à l'utilisateur.
     b. Ne pas relancer automatiquement.
     c. Fin de la boucle.

   CAS ABORTED :
     a. Informer l'utilisateur que l'orchestrateur a été interrompu.
     b. Indiquer que le state est sauvé, relance possible avec --resume.
     c. Fin de la boucle.
```

### 15.2 Invariants pour l'agent parent

- L'agent parent **n'inspecte jamais** le contenu des manifests pour prendre des décisions métier. Il applique strictement la mécanique de §15.1.
- L'agent parent **ne modifie jamais** les fichiers dans `RUN_DIR` (ni state, ni results, ni manifests).
- L'agent parent **n'émet jamais** de bloc `@@CC_ORCH@@` lui-même. Ce protocole est unidirectionnel (runtime → parent).
- L'agent parent **n'a aucun ownership de timeout**. Il n'interrompt jamais un sub-tour, n'abandonne jamais une délégation prématurément. Le timeout est exclusivement owned par le runtime (§9.3) qui le détecte en wall-clock epoch au resume.
- Si le parent agent rencontre un résultat de délégation manquant après que tous les sub-agents ont fini leur tour, c'est un bug (sub-agent n'a pas écrit) : logguer l'anomalie et relancer `resume_cmd` quand même. Le runtime gèrera : soit la deadline n'est pas encore dépassée et il throw `DelegationMissingResultError` (bug signalé), soit elle est dépassée et il retry ou fail selon la policy.

### 15.3 Composition récursive

Si un orchestrateur A invoque un skill qui lui-même est un orchestrateur B (via `delegateSkill`), la boucle de l'agent parent s'imbrique :

```
Agent parent démarre A :
  bash run A → @@CC_ORCH@@ DELEGATE skill: B
  Agent parent invoque skill B → ce qui déclenche :
    bash run B → @@CC_ORCH@@ DELEGATE agent-batch: ...
    Agent parent invoque N sub-agents
    Agent parent relance B → @@CC_ORCH@@ DONE
    Skill B écrit son output à manifest_A.resultPath
  Skill B terminé.
  Agent parent relance A (resume_cmd) → A lit le résultat de B → continue.
```

Le runtime **ne connaît pas** cette composition — il voit juste une délégation standard. C'est le protocole uniforme qui permet la composition naturelle.

---

## 16. Conséquences assumées du design

### 16.1 Coût du state JSON-sérialisable

L'auteur d'orchestrateur ne peut pas stocker dans le state :
- Des closures, fonctions, `Map`/`Set` non-sérialisés
- Des références à des streams, sockets, handles de fichier
- Des instances de classes non-plain (Date est OK si sérialisé ISO)

Impact : certaines API naturelles (tenir un cache, un EventEmitter) doivent être reconstruites à chaque re-entry depuis le state sérialisé.

Cette conséquence est **volontaire**. Elle garantit la propriété de re-entry sur un process transitoire.

### 16.2 Coût du re-entry

Chaque délégation = exit process + re-entry process. Bun startup ~50-80ms + re-chargement du state. Pour un orchestrateur avec 5 délégations, coût cumulé ~300-400ms invisibles mais réels.

Accepté v1. Pour un orchestrateur qui fait 50+ délégations, c'est à reconsidérer — peut-être accumuler plusieurs délégations en une seule pour amortir.

### 16.3 Coût du protocole stdout

Le parent agent doit parser stdout. Si une phase user print sur stdout par erreur (au lieu de stderr ou via logger), le parser peut être confus.

**Règle discipline** : les phases ne doivent jamais utiliser `console.log` (écrit sur stdout). Utiliser `io.logger.emit` ou `console.error` (stderr) pour tout debug.

Enforcement : ajouter un test de discipline qui vérifie que `console.log` n'est pas utilisé dans le code utilisateur via lint rule.

### 16.4 Coût de la session-only constraint

Le runtime ne peut pas tourner en standalone (CI, cron sans session Claude Code). Pour un orchestrateur qui doit aussi tourner en CI, il faudra soit :
- Ne pas utiliser ce runtime, écrire en direct avec `llm-runtime` + API key
- Ou forker le runtime pour un mode "headless" (hors scope v1)

### 16.5 Coût de la délégation lazy-validated avec enforcement

La validation est lazy (schéma vivant dans le code de la phase, pas de sérialisation zod). Le runtime rétablit le fail-closed via un enforcement **exact-once** : la phase de reprise doit appeler `io.consumePendingResult(schema)` OU `io.consumePendingBatchResults(schema)` (selon le kind du pending) **exactement une fois**. Zéro, deux, ou wrong-kind → `ProtocolError`.

**Coût résiduel** : l'auteur doit comprendre la règle exact-once. Un auteur qui écrit une phase multi-branch (if/else) où certaines branches consomment et d'autres non se retrouvera avec un `ProtocolError` à l'exécution. C'est voulu : ça rend la négligence visible.

**Coût évité** : plus aucun résultat silencieusement ignoré. Plus aucune branche de code qui passe sans consommer la délégation qu'elle a émise.

**Alternative future v2** : registry de schémas adressés par clé (pas zod serialisé directement) pour validation eager optionnelle — si un besoin concret émerge.

### 16.6 Coût et limites de l'event log v1

`events.ndjson` (§7.5, §11.7) apporte un audit trail du flux à coût négligeable (quelques Ko par run, double-write synchrone de quelques dizaines de bytes par event).

**Ce que l'event log donne en v1** :
- Reconstruction forensique du flux (quelles phases, quelles délégations, quels retries, quelles erreurs)
- Corrélation cross-run via `runId`
- Survivance après fin de session, jusqu'à cleanup RUN_DIR

**Ce qu'il ne donne PAS en v1** :
- Reconstruction de `state.data` par replay d'events. Pour ça → `state.json` reste la source de vérité (§4.12).
- Time-travel debugging : impossible de rejouer un run passé "à partir d'un point donné".
- Event sourcing strict à la Temporal : incompatible avec le modèle snapshot-authoritative (§4.12).

**Migration hypothétique vers event sourcing pur** : exigerait un refactor majeur (phases contraintes au pattern command/event, déterminisme enforcé). Pas envisagé v1 ni v2. Le choix snapshot-authoritative est stable.

---

## 17. Limitations v1 explicites

Chaque limitation est documentée pour que les consommateurs sachent ce qu'ils peuvent attendre.

- **Pas de headless mode** : impossible de tourner hors session Claude Code.
- **Pas de multi-process parallèle** : un seul process actif par `run_id` à la fois.
- **Pas de phases parallèles inter-phases** : une seule délégation active à la fois (batch parallèle OK dans une délégation).
- **Pas de resume après SIGKILL** : le process doit pouvoir faire son cleanup pour que la reprise soit fiable.
- **Pas de visibility UI** : inspection via fichiers disque et events NDJSON uniquement.
- **Pas de workflow versioning** : migrer du code d'orchestrateur pendant qu'un run est actif = comportement indéfini.
- **Pas de compensation automatique** : si une phase a des effets de bord externes (write sur le repo, etc.), l'auteur gère le rollback.
- **Pas de replay determinism enforcement** : le runtime suppose idempotence des phases sans la vérifier.
- **Pas de jitter sur backoff** : backoff déterministe. Si plusieurs orchestrateurs retry en même temps, ils convergent. Accepté car v1 n'a pas de pattern de retry concurrent.
- **Pas de circuit breaker** : chaque run fait ses N retries indépendamment.
- **Pas de cross-run state** : chaque run a son propre RUN_DIR isolé. Pas de partage entre runs.
- **Pas de streaming de résultat** : une délégation retourne un résultat complet, pas de stream intermédiaire.
- **Pas de priorités de phase** : la boucle est strictement séquentielle selon les transitions.
- **Validation schémas lazy avec enforcement exact-once** : le runtime ne valide qu'à l'appel `consumePendingResult` / `consumePendingBatchResults`. La règle exact-once (§6.3, §14.2) enforce qu'une phase de reprise consomme exactement une fois la délégation pendante. Un oubli = `ProtocolError`, pas un silence.
- **Pas d'event sourcing pur (à la Temporal)** : le runtime est snapshot-authoritative (§4.12). `events.ndjson` (§7.5) sert d'audit trail du flux, pas de source reconstructible de `state.data`. Le passage à event sourcing pur exigerait de contraindre les phases au pattern command/event — refusé par design.
- **Pas de signals applicatifs runtime** : impossible d'injecter une commande externe dans un run en cours (extension v2 documentée en §3.2.bis).
- **Pas de continue-as-new** : un run long accumule son historique jusqu'au cleanup. Acceptable à l'échelle v1 (10-100 runs/jour). Extension v2 documentée en §3.2.bis.
- **`state.json` est un SPOF assumé du run** : source de vérité autoritative unique (§4.12). Corruption ou perte → run cassé. Le runtime émet `@@CC_ORCH@@ action: ERROR error_kind: state_corrupted` ou `state_missing` et exit bruyamment. **Aucun fallback, aucun rollback silencieux**. Mitigation hors scope runtime : rétention RUN_DIR 7 jours permet de relancer manuellement à zéro si besoin ; backup filesystem externe pour les runs critiques. Le choix snapshot-authoritative (§4.12) est cohérent avec ce SPOF explicite : une seule source de vérité, qui peut être perdue et qui fait bruit fort si corrompue — préférable à des rollbacks silencieux qui mentiraient sur la réalité des effets de bord externes déjà commis par les phases.
- **Phases mécaniques longues > 30 min exigent `io.refreshLock()`** : sans refresh manuel, le lock expire et un second process peut usurper le run. Invariant documentaire (cf §4.13, §6.2). Splitter la phase en sous-phases (refresh auto à chaque phase-start) est la stratégie recommandée ; `refreshLock()` manuel est le fallback.

---

## 18. Plan d'éclatement et de migration

### 18.1 Ordre recommandé de build

**Phase 1 — Construction du package `cc-orchestrator-runtime`** (2-3 sessions)

- Éclater le NX en NIBs normatives
- Implémenter Layer 4 (services transversaux) : state-io, retry-resolver, timeout, validator, error-classifier, logger, protocol, clock, run-id, run-dir
- Implémenter la taxonomie d'erreurs (§6.6) : classe abstraite `OrchestratorError`, sous-classes concrètes
- Implémenter Layer 3 (bindings) : SkillBinding, AgentBinding, AgentBatchBinding
- Implémenter Layer 2 (engine) : runOrchestrator, dispatch-phase, handle-result, handle-delegation, handle-resume
- Implémenter Layer 1 (public API) : exports + types
- Tests unitaires exhaustifs (coverage ≥ 90%)
- Tests d'intégration : un orchestrateur jouet `ping-pong` qui délègue 2 fois

**Phase 2 — Premier consommateur : `senior-review`** (~1 session)

- Réécrire `senior-review` comme consommateur de `cc-orchestrator-runtime`
- Réduire `senior-review/SKILL.md` à un router minimal (10 lignes) qui lance le programme + inclut la section §15.1 (boucle parent agent)
- Implémenter `~/.claude/scripts/senior-review/main.ts` avec les phases : determine-mode, enumerate-files, filter-files, dispatch-reviews, consolidate, finalize
- Adapter `senior-reviewer-file.md` pour recevoir un `resultPath` dans le prompt
- Tests bout en bout : `/senior-review` sur un repo modifié → rapport cohérent

**Phase 3 — Validation en conditions réelles** (1 semaine d'usage)

- Utiliser `/senior-review` quotidiennement après implémentations
- Observer les logs NDJSON, mesurer la fiabilité (taux de success, latence)
- Comparer avec la version LLM-orchestrée précédente : variance, faux positifs/négatifs
- Release v1.0 de `cc-orchestrator-runtime` + `senior-review` v2

**Phase 4 — Migration des autres orchestrateurs complexes**

- `dedup-codebase` : profil similaire à senior-review (N sub-agents parallèles, consolidation)
- `fix-or-backlog` : plus linéaire, migration plus simple
- `loop-clean` : reste en bash pour l'instant (marche bien). Migration si un jour la complexité bash devient insupportable.
- `backlog-crush` : reste en bash tant que le cycle externe est linéaire

### 18.2 Rollback possible

Pendant la phase 2, `senior-review` garde sa version LLM-orchestrée en branche séparée. Si une régression grave est détectée, rollback immédiat.

---

## 19. Critères de succès v1.0

### 19.1 Critères fonctionnels

- [ ] `cc-orchestrator-runtime` publié en local (link/pnpm workspace ou copie dans `~/.claude/scripts/`)
- [ ] Premier orchestrateur `senior-review` v2 fonctionnel en mode diff ET en mode audit
- [ ] Délégation `agent-batch` parallèle testée avec N ≥ 5 jobs
- [ ] Composition récursive testée (un orchestrateur invoque un skill qui est un orchestrateur)
- [ ] Resume après délégation testé avec 3+ délégations successives dans un même run
- [ ] SIGINT pendant une phase → exit propre, state préservé, resume fonctionnel

### 19.2 Critères de qualité

- [ ] Coverage tests ≥ 90% branches, ≥ 95% lines (runtime seul, hors consommateurs)
- [ ] Chaque service transverse est une fonction pure ou un composant isolé testable sans LLM
- [ ] Surface publique stable : aucune breaking change entre v1.0-beta et v1.0 release
- [ ] Toutes les décisions matérialisées sont testables en isolation
- [ ] Tests passent sans Claude Code session (mocks du protocole)
- [ ] Le code du runtime fait ≤ 2500 lignes TS (hors tests)

### 19.3 Critères d'observabilité

- [ ] Un consommateur peut reconstruire la trace complète d'un run via les events avec le même `runId`, à travers re-entries
- [ ] Aucun event ne contient de PII (prompts, résultats en clair, chemins contenant des secrets)
- [ ] Le logger injectable fonctionne (test avec sink custom)
- [ ] `orchestrator_end` est émis pour tout run ayant émis `orchestrator_start` (DONE, ERROR, ou ABORTED). Les preflight errors (avant acquire lock) émettent uniquement le bloc protocole ERROR, pas d'events.
- [ ] `$RUN_DIR/events.ndjson` est créé au premier event émis et contient toutes les lignes émises, dans l'ordre
- [ ] Chaque ligne de `events.ndjson` est un `OrchestratorEvent` valide parseable par `JSON.parse`
- [ ] **Test reconstruction flux** : sur un run jouet qui traverse 5 phases avec 2 délégations (une réussie, une retried), les lignes d'`events.ndjson` permettent de reconstruire : l'ordre des phases, les labels des délégations, les tentatives et leurs résultats, les retries, le verdict final. Ne reconstitue PAS `state.data` (invariant faible explicite §4.12).
- [ ] `persistEventLog: false` désactive bien l'écriture disque sans casser stderr
- [ ] `enabled: false` désactive stderr ET disque (double-porte unique)

### 19.4 Critères de matérialisation des décisions

- [ ] Retry decisions matérialisées et observables via `retry_scheduled`
- [ ] Toutes les transitions de phase observables via `phase_start` / `phase_end`
- [ ] Fail-closed : tests de chaque cas d'erreur vérifient qu'un bloc `@@CC_ORCH@@ action: ERROR` est émis sur stdout (avec `error_kind` correct) ET que l'exit code est ≠ 0. Jamais de silence. Pas de throw qui remonte à l'appelant (le runtime catch tout au top-level, cf §4.4 C13).
- [ ] Protocole `@@CC_ORCH@@` : parser de test qui valide que chaque bloc émis est conforme au format §7.4
- [ ] **Consumption check exact-once** : tests vérifient que (a) zéro appel à `consumePending*` → `ProtocolError`, (b) deux appels dans la même phase → `ProtocolError`, (c) wrong-kind (consumePendingResult sur batch ou inverse) → `ProtocolError` immédiat.
- [ ] **Deadline wall-clock cross-process** : test avec mock `nowEpochMs` qui simule le passage du temps entre processes confirme que le timeout est détecté correctement au resume.
- [ ] **Deadline per-attempt** : test vérifie qu'un retry après timeout utilise une nouvelle deadline = `now + timeoutMs`, pas un résiduel.
- [ ] **Mapping kind ↔ action unique** : test de shape sur chaque bloc protocole émis selon le `PhaseResult.kind` retourné.
- [ ] **Lock acquire O_EXCL** : test vérifie que deux instances concurrentes avec même `runId` — la seconde throw `RunLockedError`, émet `@@CC_ORCH@@ action: ERROR error_kind: run_locked`, exit code 2.
- [ ] **Lock override expired** : test avec mock `nowEpochMs` qui simule un lease expiré — le nouveau process override, émet event `lock_conflict` (reason: `expired_override`).
- [ ] **Lock release avec ownerToken** : test vérifie qu'un release ne unlink que si le token matche. Si un autre process a overridé (token différent), emit `lock_conflict` (reason: `stolen_at_release`), skip unlink.
- [ ] **Lock lease dynamique** : test vérifie qu'une délégation avec `timeoutMs = 60 min` produit `leaseUntilEpochMs >= deadlineAtEpochMs + 5 min`, supérieur à `DEFAULT_IDLE_LEASE_MS`.
- [ ] **Lock refresh at phase-start** : test vérifie qu'à chaque itération de la boucle de dispatch, le lock file est ré-écrit avec un nouveau `leaseUntilEpochMs`.
- [ ] **Per-attempt result paths** : test de retry post-timeout vérifie que les chemins diffèrent entre tentatives (`<label>-0.json` vs `<label>-1.json`), et que le runtime ne lit que l'attempt courant.
- [ ] **Per-attempt isolation** : test simule un sub-agent orphelin qui écrit dans le path de la tentative 0 pendant la tentative 1 — la tentative 1 ne voit pas ce fichier (chemins disjoints).
- [ ] **Deep-freeze runtime** : test vérifie qu'une mutation de `state` dans une phase throw `TypeError` en production (pas seulement en mode strict TS).
- [ ] **Single PhaseResult enforced** : test vérifie qu'un double appel à `io.transition` / `io.done` / etc. dans une phase throw `ProtocolError` au second appel.

### 19.5 Critères d'intégration

- [ ] SKILL.md de `senior-review` v2 contient intégralement la section §15.1
- [ ] Un agent Claude Code lance `/senior-review` et reçoit un rapport cohérent en ≤ 3 minutes sur un diff de 10 fichiers
- [ ] La variance entre deux invocations successives sur le même diff est réduite vs version v1 LLM-orchestrée (mesure via `findings_hash` stable)

---

## 20. Section fermée

Les décisions de triangulation initiale :

- Langage = TypeScript : §5.7 (cohérence `llm-runtime`, manipulation JSON native, types pour schemas)
- Package manager = pnpm : §5.7 (cohérence `llm-runtime`)
- Node >= 22 LTS : §5.7 (stabilité APIs natives `AbortSignal.timeout`, `fs/promises`)
- Runtime deps = `zod` + `ulid` uniquement : §5.6 (minimalisme, alignement `llm-runtime`)
- State format = JSON : §4.10 (transparence, debugabilité)
- State dir = `.claude/run/cc-orch/<name>/<run-id>/` : §5.5 (pattern aligné `loop-clean`)
- Run ID = ULID : §5.5 (tri chronologique, même choix que `llm-runtime`)
- Signal format = `@@CC_ORCH@@ ... @@END@@` : §7.4 (visible in-band, parseable, versionné)
- Validation = lazy via zod : §14.2 (évite sérialisation schemas, acceptable v1)
- Delegation kinds = 3 (skill, agent, agent-batch) : §6.5 (couvre tous les patterns senior-review)
- Retry/timeout = par délégation, override possible : §9.1
- Pas de headless mode v1 : §3.2, §16.4
- Pas de phases parallèles inter-phases v1 : §14.4
- Pas de resume après SIGKILL v1 : §13.1

Décisions post-revue v0.2 (2026-04-19) :

- Validation lazy avec enforcement exact-once : §3.1, §5.3, §6.3, §14.2, §16.5 (must-fix M1)
- Mapping canonique unique `PhaseResult.kind ↔ action protocole` : §5.3 (must-fix M2)
- `io.signal: AbortSignal` ajouté à `PhaseIO` : §6.3 (must-fix M2)
- Forme canonique unique de `StateFile` (incluant `PendingDelegationRecord`) : §7.1 (must-fix M3)
- Suppression de toute reconstruction monotonic cross-process : §12.2 (must-fix M3)
- Timeout owné exclusivement par le runtime, wall-clock epoch deadline : §9.3, §14.2, §15.1, §15.2 (must-fix M4)
- Deadline recalculé per-attempt, pas global : §9.3 (micro-ajustement AM2)
- Consommation exact-once (pas "au moins une") : §6.3, §14.2 (micro-ajustement AM1)

Décisions post-revue Temporal v0.3 (2026-04-19) :

- Ajout `events.ndjson` append-only comme audit trail du flux (A.1 minimal) : §3.1, §5.5, §7.5, §11.7, §16.6
- Flag `LoggingPolicy.persistEventLog` pour opt-out (tests, stress) : §9.4
- **Décision architecturale snapshot-authoritative, pas event-sourced** : §1.6 (équivalence Temporal), §4.12 (invariant normatif). Rejet explicite des options A.2/A.3 qui ouvrent des guerres de cohérence snapshot vs events replayed.
- Invariant faible "events reconstruisent le flux, pas state.data" explicité : §4.12, §7.5, §11.7, §16.6, §19.3
- Extensions v2 scoped : signals applicatifs (B), continue-as-new (C) : §3.2.bis
- Event sourcing pur listé comme limitation v1 assumée : §17

Décisions post-revue durcissement v0.4 (2026-04-19) :

- **M5 — Lock d'exécution par run** : §4.13. Transforme "single process per run" d'un souhait documentaire en garantie mécanique. LockFile avec `{ownerPid, ownerToken, acquiredAtEpochMs, leaseUntilEpochMs}`. Acquire atomique via O_EXCL, update via tmp+rename, release avec vérification ownerToken. Lease dynamique `max(now + 30 min, deadlineAtEpochMs + 5 min)` qui couvre les délégations longues. 4 points de refresh : acquire / phase-start / pre-DELEGATE / pre-retry. Event `lock_conflict` dédié pour les conflits (override/steal).
- **M6 — Per-attempt result paths** : §7.2, §14.1, §14.2. Chemins `<label>-<attempt>.json` disjoints entre tentatives. Résout la race "sub-agent orphelin de tentative N-1 pollue la tentative N" structurellement, sans envelope payload.
- **M7 — `consumePendingResult` + `consumePendingBatchResults`** `[BREAKING]` : §6.3, §14.1, §14.2. Remplace `readResult(label, schema)`. Deux méthodes typées distinctes selon le kind du pending, suppriment le label redondant et le casting `Array.isArray`. Règle exact-once simplifiée : exactement un appel parmi les deux par phase de reprise.
- **M8 — Deep-freeze + garde linéaire enforced en prod** : §6.2, §14.1. `state` gelé en profondeur (TypeError natif à la mutation, prod inclus). Flag `committed` empêche un second PhaseResult (ProtocolError immédiat).
- **M9 — `io.refreshLock()`** `[BREAKING]` ajout à `PhaseIO` : §4.13, §6.3. Pour les phases mécaniques longues qui dépassent 30 min sans délégation.
- **C1 — SPOF state.json documenté** : §17. state.json source de vérité autoritative unique, corruption = bruit fort et relance manuelle. Pas de shadow snapshot ni de rollback silencieux (ambiguïté sur les effets de bord externes).
- **C2 — Gouvernance pré-1.0 + convention `[BREAKING]`** : §4.9. Changements breaking autorisés en 0.x mais taggés explicitement dans le changelog pour reconstruire l'historique d'API post-1.0.
- **C3 — Invariant phase max duration** : §6.2, §17. Phase sans délégation ne doit pas dépasser `DEFAULT_IDLE_LEASE_MS` (30 min) sans `refreshLock()` manuel.
- **Taxonomie events élargie 10 → 11 types** : §11.3 + §6.7. Ajout `lock_conflict` avec `reason` discriminant.
- **RunLockedError via protocole** (pas exit silencieux) : §6.6, §14.1 step 7. Respecte le contrat fail-closed unifié — toute erreur passe par `@@CC_ORCH@@ action: ERROR`.

Décisions post-revue verrouillage v0.5 (2026-04-19) :

- **M10 — Identité run** : §14.1 step 3, §14.2 step 2, §15.1. `--run-id <ulid>` est le contrat canonique. Généré avant résolution RUN_DIR en flow initial. Obligatoire en mode `--resume`. Invariance CWD documentée : toutes les invocations d'un même run depuis le même cwd. `resume_cmd = "bun run <main> --run-id <runId> --resume"`.
- **M11 — `result.resumeAt` pas `result.request.resumeAt`** : §14.1 step 16.n "delegate". Cohérent avec le type canonique §6.4 où `resumeAt` est au niveau `PhaseResult.delegate`, pas dans `DelegationRequest`.
- **M12 — Surface publique cohérente** : §5.2. Retiré `ValidationPolicy` (n'existait pas, validation via schémas zod passés à `consumePending*`). Ajouté `InvalidConfigError` et `RunLockedError` aux exports. §9.4 pointe vers §6.8 pour la définition unique de `LoggingPolicy` (avec `persistEventLog`).
- **M13 — Retry post-schema-error reconstruction** : §14.1 step 16.i catch, §14.2 step 12.e. Source de vérité = ancien manifest sur disque à `pd.manifestPath`. Le runtime lit, copie les champs métier, bumpe `attempt` + recalcule temporels et chemins per-attempt, écrit le nouveau manifest. `timeoutMs` initial préservé (policy capturée à l'émission initiale).
- **M14 — Timing d'effacement de `pendingDelegation`** : §7.1, §14.2 step 14, §14.3. Effacement **au traitement du PhaseResult** (§14.1 step 16.n), **pas au début** de la phase de reprise. Garantit qu'un crash mid-phase préserve le pending pour retry correct.
- **M15 — Retrait obsolescence "same manifest/same resultPath"** : §8.2. Remplacé par description explicite de la ré-émission per-attempt (§7.2), cohérent avec v0.4.
- **C5 — Booléens autorisés dans `@@CC_ORCH@@`** : §7.4. Règles génériques étendues à `strings | numbers | booleans | null`. Cohérent avec `success: true/false` dans DONE.
- **C6 — JSON résultat malformé** : §14.2 step 12.d. Classé comme `DelegationSchemaError` explicite (retriable), distinct de `DelegationMissingResultError` (fichier absent, non retriable). Trois classifications au resume : `missing` / `malformed` / `parseable`.
- **C7 — Frontière multi-process corrigée** : §3.2. Retrait de "pas de locks multi-process" (contredit §4.13). Remplacé par clarification sur le scope (lock per run_id, runs parallèles libres sur runIds différents ou repos différents).
- **C8 — `clock.nowEpochMs()` dans l'API canonique** : §5.5. Listé explicitement avec les autres méthodes du module `clock`.

Bonus v0.5 :
- §4.13 : clarification du scope du lock (couple cwd × runId), répond à la question "senior-review parallèles sur différents repos".
- §14.2 step 7 : vérification `state.runId === runId && state.orchestratorName === config.name` au resume pour détecter un mismatch RUN_DIR ↔ argv (bug parent agent ou cwd incorrect).

Décisions post-revue verrouillage v0.6 (2026-04-19) :

- **M16 — Préflight errors via protocole** : §4.4, §14.1, §14.2, §7.4.3. Toute erreur preflight (config invalide, state manquant, corrompu, mismatch runId) émet un bloc `@@CC_ORCH@@ action: ERROR` plutôt qu'un throw brut. `run_id: null` dans les cas où le runId n'a pas encore été généré/adopté. Fail-closed uniforme : le parent agent a un seul chemin de traitement d'erreur.
- **M17 — Validation unique via consumePending*** `[BREAKING]` : §6.5, §7.3. Suppression de `outputSchema` des variants de `DelegationRequest`. La validation des résultats passe exclusivement par les schémas zod fournis à `io.consumePendingResult(schema)` / `io.consumePendingBatchResults(schema)` (§6.3). Cohérent avec la décision M1 (v0.2, lazy validation) et avec la non-sérialisabilité de zod.
- **M18 — `resumeCommand` required dans OrchestratorConfig** `[BREAKING]` : §6.1, §14.1. Nouveau champ required `resumeCommand: (runId: string) => string` qui construit la commande de relance. Le runtime l'appelle à chaque émission DELEGATE. Absent → `InvalidConfigError` preflight. Résout l'impossibilité précédente de construire `resume_cmd` de façon normative.
- **M19 — `usedLabels` dans state pour unicité des labels** : §7.1, §14.1. Nouveau champ `usedLabels: readonly string[]` append-only dans `StateFile`. Chaque émission de délégation vérifie `label ∉ usedLabels` (sinon `ProtocolError`) puis ajoute. Rend enforceable la règle d'unicité "label unique au run" (§6.5).
- **M20 — `initialState` required** `[BREAKING]` : §6.1, §14.1. Champ required dans `OrchestratorConfig`. Pas de fallback `{} as State` — un type State avec champs requis doit avoir un initialState correspondant. Absence → `InvalidConfigError` preflight.
- **C9 — Retrait `readRawResult` du binding** : §5.4. La lecture des résultats est exclusivement côté engine (§14.2 step 12). Le binding s'occupe uniquement de `buildManifest` et `buildProtocolBlock` (write-side). Suppression de la duplication d'architecture.
- **C10 — PII strict sur malformed JSON** : §14.2 step 12. Suppression du log d'un extrait du contenu malformé. Logger uniquement `path` (runtime, sans PII) et `fileSizeBytes`. Cohérent avec §11.5 (pas de contenus en clair dans les logs).
- **C11 — `input` in-process only** : §6.2. Documenté explicitement : le champ `input` entre phases est **non-persisté**, utilisable uniquement pour transitions intra-process. Toute donnée franchissant une délégation doit être dans `state.data`.

Décisions post-revue verrouillage v0.7 (2026-04-19) :

- **M21 — `delegate*` sans generic `<Output>`** `[BREAKING]` : §6.3. Retiré `<Output>` de `delegateSkill`, `delegateAgent`, `delegateAgentBatch` dans `PhaseIO`. Cohérent avec M17 (Request types sans generic). Le typage de sortie se fait uniquement via le schéma passé à `consumePending*(schema)`.
- **M22 — Source unique `state.currentPhase`** : §14.1. Suppression de la variable locale `currentPhase`. La boucle de dispatch relit `state.currentPhase` au début de chaque itération. Les branches transition écrivent dans `state.currentPhase`. Une seule source de vérité, pas de risque de divergence.
- **M23 — Binding explicite dans branche delegate** : §14.1 step 16.n. Ajout de `const request = result.request; const label = request.label; const kind = request.kind; const resumeAt = result.resumeAt;` en tête de branche. L'implémenteur peut copier-coller le pseudo-code sans interpréter.
- **M24 — Exemples cohérents** : §7.2 implicite, §7.4.1 resume_cmd avec `--run-id`, §7.4.4 ABORTED mentionne `--run-id` explicit, §7.4.1 manifest path avec `-<attempt>` suffix. Corrections purement visuelles.
- **C12 — Sémantique "run" clarifiée** : §4.6, §19.3. Un run = de `orchestrator_start` à `orchestrator_end`. Préflight errors ne sont **pas** un run complet (émettent uniquement le bloc protocole ERROR, pas d'events). Garantie v0.7 : `orchestrator_end` émis pour tout run ayant émis `orchestrator_start`.
- **C13 — "throw" dans flows = interne catché** : §4.4. Les mentions `throw X` dans §14.1/§14.2 désignent un throw interne capturé par le top-level handler de `runOrchestrator`. La Promise retournée ne rejette jamais — tout throw devient bloc ERROR + exit. Critères de test §19 reformulés : "vérifier qu'un bloc ERROR est émis" au lieu de "vérifier qu'on throw".

Décisions post-revue verrouillage v0.8 (2026-04-19) :

- **M25 — Lock = process-alive, release systématique** (CRITICAL bug-fix) : §4.13, §14.1 branches delegate/done/fail/catch, §14.2 branches retry. Le lock représente "un process vivant dans ce run", pas une réservation longue-durée. Release systématique avant tout exit(0/1). Re-acquire à chaque entrée de process. Suppression du lease dynamique basé sur deadline (SAFETY_BUFFER_MS obsolète). Lease idle simple 30 min pour crash recovery uniquement. Refresh points 4 → 2 (acquire + phase-start). Élimine le deadlock DELEGATE/resume qui cassait tout le workflow normal.
- **M26 — RetryPolicy effective persistée** : §7.1, §14.1. Ajout `effectiveRetryPolicy: { maxAttempts, backoffBaseMs, maxBackoffMs }` dans `PendingDelegationRecord`. Capturée à l'émission initiale (résolution request.retry ?? config.retry ?? défaut, champ par champ). Réutilisée à chaque retry (catch §14.1, retry §14.2). Plus de perte d'override cross-process.
- **C14 — events.ndjson owner-only** : §5.5, §7.5, §11.7, §14.1, §14.2. Stderr logger init tout de suite (avant preflight). events.ndjson logger activé uniquement **après acquire lock réussi**. Garantit qu'un contender bloqué sur RunLockedError ne pollue pas le audit trail du run actif. Règle : seul un owner process écrit dans `events.ndjson`.
- **C15 — Retrait "Jamais plusieurs par run"** : §7.4. Un run complet émet typiquement plusieurs blocs (N × DELEGATE + 1 × DONE/ERROR). La règle "un seul bloc par invocation du process" reste correcte.

Toutes tranchées le 2026-04-19.

---

## Changelog

- **v0.8** (2026-04-19) : correction blocker lock/resume + 3 verrous additionnels (2 must-fix M25-M26 + 2 clarifications C14-C15, post-revue ChatGPT). **MUST-FIX** : (M25) §4.13, §14.1 branches delegate/done/fail/catch-retry, §14.2 branche retry : **correction critique du bug lock/resume**. Le lock représente "un process vivant dans ce run", pas une réservation longue-durée sur la délégation. **Release systématique** avant tout `exit(0/1)` (DELEGATE, DONE, ERROR, ABORTED, catch-retry, retry-timeout). La re-entry ré-acquiert via O_EXCL proprement. Suppression du lease dynamique basé sur `deadlineAtEpochMs + SAFETY_BUFFER_MS` (cette formule créait un deadlock où la re-entry normale était refusée par le lock de son propre run). Lease idle simple `nowEpoch + DEFAULT_IDLE_LEASE_MS` (30 min) pour crash recovery SIGKILL uniquement. Refresh points réduits de 4 à 2 (acquire + phase-start). `SAFETY_BUFFER_MS` obsolète, retiré. (M26) §7.1 `PendingDelegationRecord`, §14.1 branche delegate, §14.1 catch + §14.2 retry : ajout du champ `effectiveRetryPolicy: { maxAttempts, backoffBaseMs, maxBackoffMs }` capturé à l'émission initiale (résolution champ-par-champ via `request.retry?.X ?? config.retry?.X ?? defaultX`). Support des overrides partiels. Réutilisé par `resolveRetryDecision` au retry — plus de perte d'override cross-process. Remplace la référence précédente floue à "effectivePolicy" sans source de vérité. **CLARIFICATIONS** : (C14) §5.5, §7.5, §11.7, §14.1 step 6/7, §14.2 step 8/10 : events.ndjson **owner-only**. Stderr logger installé tout de suite (avant preflight), peut émettre les erreurs preflight et RunLockedError. events.ndjson logger activé **uniquement après acquire lock réussi**. Garantit qu'un contender bloqué sur `RunLockedError` ne pollue pas l'audit trail du run actif (seul un owner process écrit dans le fichier). (C15) §7.4 règles génériques du protocole : retrait de la phrase incorrecte "Jamais plusieurs par run". Un run complet émet typiquement plusieurs blocs (N × DELEGATE + 1 × DONE/ERROR/ABORTED, un par invocation de process). La règle "un seul bloc par invocation du process" reste correcte et suffisante.
- **v0.7** (2026-04-19) : verrouillage final #3 (4 must-fix M21-M24 + 2 clarifications C12-C13, post-revue ChatGPT). **MUST-FIX** : (M21) `[BREAKING]` §6.3 : retiré `<Output>` des signatures `delegateSkill`, `delegateAgent`, `delegateAgentBatch` dans `PhaseIO`. Cohérent avec M17 (v0.6) qui a retiré `<Output>` des Request types. Le type de sortie est porté uniquement par le schéma zod passé à `consumePending*(schema)`. (M22) §14.1 step 10-11, step 16.a, branche transition : source unique `state.currentPhase`. Suppression de la variable locale `currentPhase`. La boucle de dispatch relit `state.currentPhase` au début de chaque itération (`state.currentPhase` est l'unique source de vérité). Les branches transition écrivent dans `state.currentPhase`. Variable `initialPhase` utilisée uniquement à la construction du StateFile initial. (M23) §14.1 step 16.n branche delegate : binding explicite en tête via `const request = result.request; const label = request.label; const kind = request.kind; const resumeAt = result.resumeAt;`. Toutes les références subséquentes utilisent ces noms bindés. Permet à l'implémenteur de copier-coller sans interpréter. (M24) §7.4.1 / §7.4.4 : corrections d'exemples — `resume_cmd` inclut maintenant `--run-id <runId> --resume` (cohérent avec §6.1 resumeCommand), path manifest inclut `-<attempt>` suffix (cohérent avec §7.2), ABORTED exemple mentionne le `--run-id` à la relance. **CLARIFICATIONS** : (C12) §4.6, §19.3 : sémantique "run" définie. Un run = de `orchestrator_start` à `orchestrator_end`. Préflight errors (avant acquire lock, avant RUN_DIR résolu) émettent uniquement le bloc protocole `@@CC_ORCH@@ action: ERROR` sur stdout — elles **ne sont pas** un run complet (pas de `orchestrator_start`, pas de `orchestrator_end`, pas d'events dans `events.ndjson` qui n'existe pas encore à ce stade). Garantie observabilité affaiblie proprement : "orchestrator_end émis pour tout run ayant émis orchestrator_start". (C13) §4.4 : clarification sémantique des mentions `throw X` dans les flows §14. Désigne un throw **interne** capturé par le top-level `try/catch` de `runOrchestrator`, qui émet un bloc ERROR + `exit()`. La Promise retournée par `runOrchestrator()` ne rejette **jamais** à l'appelant. Critères de test §19 reformulés : "vérifier qu'un bloc ERROR est émis sur stdout + exit code ≠ 0" au lieu de "vérifier qu'on throw".
- **v0.6** (2026-04-19) : verrouillage final #2 (5 must-fix M16-M20 + 3 clarifications C9-C11, tous post-revue ChatGPT). **MUST-FIX** : (M16) §4.4, §14.1, §14.2 : fail-closed étendu aux erreurs preflight. Toute erreur (`invalid_config`, `state_missing`, `state_corrupted`, `state_version_mismatch`, mismatch runId/orchestratorName) émet `@@CC_ORCH@@ action: ERROR` au lieu d'un throw brut. `run_id: null` quand le runId n'est pas encore disponible. §7.4.3 : exemple preflight ajouté. (M17) `[BREAKING]` §6.5, §7.3 : suppression de `outputSchema` des `SkillDelegationRequest`, `AgentDelegationRequest`, `AgentBatchDelegationRequest`. Validation exclusivement via le schéma zod passé à `io.consumePendingResult(schema)` / `io.consumePendingBatchResults(schema)`. Cohérent avec M1 (v0.2 lazy validation) et avec la non-sérialisabilité de zod. Les variants Request perdent leur type paramètre `<Output>`. (M18) `[BREAKING]` §6.1, §14.1 step 16.n : ajout de `resumeCommand: (runId: string) => string` required dans `OrchestratorConfig`. Le runtime l'appelle pour construire `resume_cmd` à chaque émission DELEGATE. Absent → `InvalidConfigError` preflight. Résout l'impossibilité normative antérieure (le runtime ne connaît ni le chemin main.ts ni l'interpréteur). (M19) §7.1, §14.1 step 16.n : nouveau champ `usedLabels: readonly string[]` append-only dans `StateFile`. Chaque émission de délégation vérifie `label ∉ state.usedLabels` (sinon `ProtocolError("duplicate label: " + label)`) puis append. Rend enforceable la règle d'unicité des labels au run (§6.5). (M20) `[BREAKING]` §6.1, §14.1 step 11 : `initialState` rendu required. Pas de fallback `{} as State`. Un type `State` avec champs requis doit avoir un `initialState` correspondant, sinon `InvalidConfigError` preflight. **CLARIFICATIONS** : (C9) §5.4 : suppression de `readRawResult` de `DelegationBinding`. La lecture des résultats est exclusivement côté engine (§14.2 step 12). Le binding s'occupe uniquement des write-side operations (`buildManifest`, `buildProtocolBlock`). Élimine la duplication d'architecture "double owner". (C10) §14.2 step 12 : PII strict sur `malformed` JSON. Logger uniquement `path` (runtime, sans PII) et `fileSizeBytes`. Aucun extrait du contenu ni du message `JSON.parse()`. Cohérent avec §11.5. (C11) §6.2 : clarification "`input` in-process only". Le second argument `input?: Input` de `Phase` et `PhaseResult.transition.input` sont non-persistés. Toute donnée qui doit survivre à une délégation va dans `state.data`. Discipline auteur : utiliser `input` uniquement pour transitions intra-process.
- **v0.5** (2026-04-19) : verrouillage final pour implémentation (6 must-fix M10-M15 + 4 clarifications C5-C8, tous post-revue ChatGPT). **MUST-FIX** : (M10) §14.1 step 3, §14.2 step 2, §15.1 : contrat `--run-id <ulid>` canonique, généré avant résolution RUN_DIR, obligatoire en mode `--resume`, intégré dans `resume_cmd`. Invariance CWD documentée comme précondition du parent agent. §14.2 step 7 : vérification `state.runId === runId && state.orchestratorName === config.name` au resume. (M11) §14.1 step 16.n "delegate" : `result.resumeAt` (pas `result.request.resumeAt`) — aligné sur le type canonique §6.4 où `resumeAt` est au niveau `PhaseResult.delegate`. (M12) §5.2 : surface publique cohérente. `ValidationPolicy` retiré des exports (n'existait pas ; validation via schémas zod passés à `consumePending*`). `InvalidConfigError` et `RunLockedError` ajoutés à la liste des classes exportées. §9.4 pointe vers §6.8 pour la définition unique de `LoggingPolicy` (avec `persistEventLog`). (M13) §14.1 step 16.i catch, §14.2 step 12.e : reconstruction explicite du manifest post-retry. Source de vérité = ancien manifest sur disque à `pd.manifestPath`. Le runtime lit, copie les champs métier (skill, skillArgs, agentType, prompt, jobs, timeoutMs), bumpe attempt, recalcule temporels et chemins per-attempt (§7.2), écrit le nouveau manifest. `pendingDelegation` mis à jour avec les nouvelles valeurs. (M14) §7.1, §14.2 step 14, §14.3 : timing d'effacement de `pendingDelegation` — au **traitement du PhaseResult** (§14.1 step 16.n), pas au début de la phase de reprise. Garantie cross-crash : un crash mid-phase préserve le pending pour retry correct. (M15) §8.2 : retrait de la phrase obsolète "relance la même délégation (même manifest, même resultPath — le skill/agent réécrase)". Remplacée par description explicite de la ré-émission per-attempt cohérente avec §7.2 (nouveau manifest, nouveaux resultPath per-attempt, reconstruction via lecture de l'ancien manifest). **CLARIFICATIONS** : (C5) §7.4 : règles génériques du protocole `@@CC_ORCH@@` étendues à `strings | numbers | booleans | null`. Cohérent avec `success: true/false` dans les exemples DONE. Quoting optionnel pour strings sans caractères spéciaux, obligatoire sinon (échappement JSON standard). (C6) §14.2 step 12 : JSON résultat malformé classé explicitement comme `DelegationSchemaError` immédiat (retriable), distinct de `DelegationMissingResultError` (fichier absent, non retriable). Trois classifications au resume : `missing` / `malformed` / `parseable`. (C7) §3.2 : retrait de "pas de locks multi-process" (contredit §4.13). Remplacé par clarification scope lock (per run_id, runs parallèles libres sur runIds ou repos différents). (C8) §5.5 : `clock.nowEpochMs()` listé explicitement avec les autres méthodes du module `clock`. **BONUS** : §4.13 clarification scope (cwd × runId) — répond à la question "senior-review parallèles sur différents repos".
- **v0.4** (2026-04-19) : post-revue durcissement (9 points, Fanilo + ChatGPT). 5 must-fix + 4 clarifications. **MUST-FIX** : (M5) §4.13 nouvelle section — lock file `$RUN_DIR/.lock` avec `{ownerPid, ownerToken, acquiredAtEpochMs, leaseUntilEpochMs}`, acquire O_EXCL, update tmp+rename, release avec vérification token, lease dynamique `max(now + 30 min, deadlineAtEpochMs + 5 min)` couvrant les délégations longues, 4 points de refresh (acquire / phase-start / pre-DELEGATE / pre-retry). Nouvel event `lock_conflict` (§11.3, 10 → 11 types) pour les cas `expired_override` et `stolen_at_release`. Nouvelle `RunLockedError` (§6.6) émise via `@@CC_ORCH@@ action: ERROR error_kind: run_locked` (pas exit silencieux — respecte fail-closed unifié). (M6) §7.2, §14.1, §14.2 : chemins de résultat per-attempt `$RUN_DIR/results/<label>-<attempt>.json` (skill/agent) ou `$RUN_DIR/results/<label>-<attempt>/<jobId>.json` (batch). Résout la race "sub-agent orphelin d'une tentative précédente pollue la tentative courante" par isolation structurelle des chemins, sans requérir d'envelope payload. (M7) `[BREAKING]` §6.3, §14.1, §14.2 : remplacement `readResult(label, schema)` par deux méthodes typées distinctes `consumePendingResult(schema): T` (skill/agent) et `consumePendingBatchResults(schema): readonly T[]` (agent-batch). Suppression du label redondant (state connaît déjà le pending), typage clean sans `Array.isArray` au call site, règle exact-once simplifiée. Wrong-kind détecté à l'appel avec ProtocolError immédiat. (M8) §6.2, §14.1 : deep-freeze récursif du state passé à la phase (TypeError natif à la mutation, production inclus — invariant runtime, pas dev-only). Flag `committed` enforce le single PhaseResult avec `ProtocolError("PhaseResult already committed")` au second appel. (M9) `[BREAKING]` §4.13, §6.3 : ajout `io.refreshLock()` à `PhaseIO` pour les phases mécaniques longues qui dépassent `DEFAULT_IDLE_LEASE_MS` sans délégation. **CLARIFICATIONS** : (C1) §17, §4.12 : `state.json` est un SPOF assumé du run, documenté explicitement. Corruption = bruit fort (`state_corrupted` via protocole) et relance manuelle. Rejet explicite d'un shadow snapshot / state.prev.json qui créerait une ambiguïté sur les effets de bord externes déjà commis par les phases. (C2) §4.9 : gouvernance pré-1.0 explicitée — breaking changes autorisés en 0.x mais taggés `[BREAKING]` dans le changelog pour reconstruire l'historique d'API à partir de v1.0. (C3) §6.2, §17 : invariant documentaire phase max duration 30 min sans `refreshLock()`. Au-delà, splitter la phase en sous-phases (refresh auto phase-start) ou appeler `refreshLock()` manuellement. (C4) §13.2 : handler SIGINT/SIGTERM relâche le lock avant exit (via `releaseLockIfOwner` avec vérification ownerToken). **CRITÈRES V1.0 ÉLARGIS** (§19.3) : 8 nouveaux tests dédiés (lock O_EXCL concurrency, lease dynamique, refresh phase-start, release avec token match, per-attempt paths disjoints, deep-freeze mutation throw, single PhaseResult guard).
- **v0.3** (2026-04-19) : post-revue comparative Temporal — ajout event log append-only (A.1) + clarification architecturale snapshot vs event sourcing. **AJOUT FONCTIONNEL** : §3.1, §5.5, §7.5, §11.7 : introduction de `$RUN_DIR/events.ndjson` comme audit trail persistant, double-write avec stderr, écriture synchrone via `appendFileSync`, rotation par run, cleanup aligné sur rétention RUN_DIR. Nouveau flag `LoggingPolicy.persistEventLog?: boolean` (défaut `true`) pour opt-out (§9.4). **CLARIFICATION ARCHITECTURALE** : §1.6 enrichi avec la divergence essentielle snapshot-based vs event-sourced, table d'équivalence conceptuelle avec Temporal (workflow ≈ runOrchestrator, activity ≈ DelegationRequest, event history ≈ events.ndjson, sticky cache ≈ state.json autoritative, continue-as-new ≈ extension v2, heartbeats/versioning/replay-determinism inapplicables). §4.12 nouvelle section "Snapshot-authoritative, pas event-sourced" qui pose la règle normative : `state.json` source de vérité unique, `events.ndjson` audit trail du flux uniquement. Invariant normatif faible explicité : "events suffisent à reconstruire le flux (phases, délégations, retries, erreurs) mais PAS `state.data` — pour ça, `state.json` final est nécessaire". Rejet explicite d'A.2 (state snapshot dans events = anti-pattern Temporal, viole l'invariant `state = f(events) purs`) et A.3 (snapshots séparés = redondants avec state.json autoritatif). **EXTENSIONS V2 SCOPED** : §3.2.bis nouvelle section listant (B) Signals applicatifs inbox pattern (trigger : premier orchestrateur qui a un cas concret d'injection runtime) et (C) Continue-as-new (trigger : premier orchestrateur qui dépasse ~20 cycles). Les deux cohérentes avec la philosophie snapshot-based, ne cassent pas la surface publique. **LIMITATION V1 EXPLICITE** : §17 : "Pas d'event sourcing pur à la Temporal" ajouté comme limitation assumée (exigerait contrainte command/event sur les phases, refusée par design). Critères de succès v1.0 enrichis (§19.3) avec 4 nouveaux tests : création events.ndjson, format JSON parseable, reconstruction flux (pas state.data), opt-out via `persistEventLog`/`enabled`.
- **v0.2** (2026-04-19) : post-revue Fanilo — 4 must-fix + 2 micro-ajustements. **MUST-FIX** : (M1) **validation lazy sans silence** — §3.1, §5.3, §6.3, §14.2, §16.5 : la validation reste lazy (schéma vivant en code, pas de sérialisation zod), mais le runtime enforce la consommation **exactly once** de `state.pendingDelegation.label` via `io.readResult`. Zéro ou deux appels → `ProtocolError`. Résultat : fail-closed rétabli sans dépendance `zod-to-json-schema`. (M2) **unification du contrat public** — §5.3 : table canonique unique du mapping `PhaseResult.kind ↔ action protocole` (`transition` / `delegate` / `done` / `fail` côté TS ; aucun / `DELEGATE` / `DONE` / `ERROR` côté stdout). §6.3 : ajout explicite de `io.signal: AbortSignal` dans l'interface `PhaseIO` (aligné §13.4). (M3) **forme canonique unique de StateFile** — §7.1 : fusion de §7.1 + §12.2 + §14.3 en un seul schéma, incluant `PendingDelegationRecord` avec `emittedAtEpochMs`, `deadlineAtEpochMs`, `maxAttempts`, `jobIds`. Suppression de toute tentative de reconstruction monotonic cross-process (`monotonicBase`/`monotonicOffset` retirés). Ajout de `nowEpochMs()` au module `clock` (§12.3). Discipline explicite intra-process=monotonic / cross-process=wall-clock epoch (§12.2). (M4) **ownership runtime des timeouts** — §9.3, §14.2, §15.1, §15.2 : propriétaire unique = runtime. Le parent agent n'a aucune responsabilité de timeout. Deadline en wall-clock epoch (`deadlineAtEpochMs`). Plus de phrase ambigüe "timeout géré par le parent". **MICRO-AJUSTEMENTS** : (AM1) §6.3, §14.2 : la règle est **exact-once** (pas "au moins une"). Deux appels à `readResult` sur le même label dans la même phase de reprise → `ProtocolError` immédiat levé depuis `readResult`. (AM2) §9.3 : deadline **per-attempt** recalculé à chaque émission (`deadlineAtEpochMs = emittedAtEpochMs + timeoutMs`), pas un budget résiduel global. Manifest versionné par tentative (`$RUN_DIR/delegations/<label>-<attempt>.json`, §7.2). §14.2 step 10 ré-écrit avec la logique retry-post-timeout complète. Critères de succès v1.0 enrichis avec 4 nouveaux tests (§19.4).
- **v0.1** (2026-04-19) : conception initiale consolidée. Triangulation avec Fanilo sur le contexte (passage archétype A → B pour orchestrateurs complexes), contrainte session-only (coût tokens / UX / max subscription), inspiration architecture `llm-runtime` (engine/bindings/services/types), distinction claire avec Temporal (in-process, pas de serveur), feuille de route : runtime → senior-review → validation → autres orchestrateurs.
