# Turnlock — Adoption Criteria (dérivés du cas `/senior-review`)

> Quand faut-il remplacer une orchestration existante (skill + agents) par une orchestration turnlock ? Ce document formalise les critères de décision, illustre la transformation sur un cas concret (`/senior-review` de Claude Code), et consolide la checklist opérationnelle à cocher avant d'adopter turnlock pour une couche d'orchestration donnée.

## 0. Terminologie

Le mot "skill" recouvre trois réalités distinctes selon le contexte. Le document utilise systématiquement les termes qualifiés ci-dessous.

| Terme | Rôle | Exécution |
|---|---|---|
| **skill pré-turnlock** | Skill classique : son prompt contient du jugement et, souvent, de la logique d'orchestration (boucles, dispatch en langage naturel). C'est l'état avant adoption de turnlock. | Dans le contexte du caller (typiquement la main session) |
| **skill-consumer** | Skill post-turnlock servant de **point d'entrée utilisateur ET de pont protocole**. Son prompt instruit Claude sur le protocole `@@TURNLOCK@@` : lancer le binaire, lire les blocs `DELEGATE`, mapper `kind: "prompt" \| "batch"` et `worker?` vers le bon outil Claude, écrire les résultats dans le RUN_DIR, relancer `turnlock --resume`, boucler jusqu'à `DONE`. | Dans le contexte du caller |
| **skill-judgment** | Skill post-turnlock ciblé par `delegate(...)` depuis une FSM. Contient uniquement du jugement, zéro logique de protocole. Existe typiquement pour réutiliser un skill déjà écrit sans le transformer en agent. | Dans le contexte du caller |

**Pourquoi le skill-consumer est obligatoire (argument de self-containment)** : une FSM turnlock doit être livrable comme un artefact autonome — tout ce dont elle a besoin voyage avec elle. Le skill-consumer est la **seule unité d'emballage** qui combine les trois capacités indispensables :

1. **Entry point utilisateur** invocable (slash command `/X`)
2. **Protocole handler** : prompt qui instruit Claude sur le mapping `@@TURNLOCK@@` DELEGATE → tools Claude ou worker choisi, écriture des résultats, relance `--resume`, boucle jusqu'à `DONE`
3. **Self-contained** : ship dans `.claude/skills/` versionné avec le code de la FSM

Les alternatives échouent toutes au moins une de ces conditions :

- **Script bash pur** : ne tourne pas dans un contexte Claude, ne peut donc pas invoquer `Agent()` ni `Skill()`. Échoue sur (2).
- **Instructions dans le CLAUDE.md du projet consommateur** : hors périmètre de la FSM, pas sous contrôle de la FSM, ne ship pas avec le code. Dépendance implicite sur l'environnement du tiers qui clone. Échoue sur (3).
- **Agent Claude dédié (`turnlock-consumer`)** : même s'il ship dans `.claude/agents/`, il ne fournit pas d'entry point utilisateur (pas de slash command). Nécessiterait un skill en amont pour l'invoquer. Échoue sur (1).

Conclusion : chaque FSM turnlock ship **avec son skill-consumer**. Le skill-consumer est l'atome de packaging d'une FSM turnlock consommable.

De la même manière, **agent** désigne toujours une unité Claude à contexte frais invocable via le tool `Agent`. **Agent feuille** = agent dont le rôle est purement du jugement atomique (pas d'orchestration interne).

---

## 1. Analyse du pattern de départ (skill pré-turnlock + agents)

### Cas concret étudié

```
/senior-review (skill pré-turnlock)
  ├── Orchestre : identifie les fichiers modifiés
  ├── Dispatche : spawn N sub-agents en parallèle
  └── Consolide : agrège les verdicts en un rapport global
      │
      └── senior-review-file (agent, ×N)
          ├── Phase 0 : Récolte (file, diff, exports, imports, I/O ops, inputs, tests)
          ├── Phases 1-4 : audit de 12 axes
          └── Phase 5 : Consolidation (dedup + format + verdict)
```

### Structure des responsabilités

| Niveau | Jugement ? | Mécanique ? |
|---|---|---|
| Skill pré-turnlock `senior-review` | Non | Oui (lister, dispatcher, agréger) |
| Agent `senior-review-file` | Oui (12 axes + classifications sémantiques) | Oui (read, diff, regex, glob, dedup, format) |
| Chaque axe d'audit | Oui (cœur du jugement hostile) | Un peu (grep patterns, compter sévérités) |

**Constat :** les deux niveaux d'orchestration contenaient des étapes mécaniques noyées dans du prompt LLM — fragile à chaque invocation.

---

## 2. Critère de décision turnlock — deux axes orthogonaux

**Scope de l'évaluation — récursif sur la pile d'orchestration.** "La couche" évaluée n'est pas seulement le skill pré-turnlock d'entrée : c'est **l'ensemble des niveaux d'orchestration** visibles depuis le point d'entrée utilisateur (skill + tout sub-agent qui contient de l'orchestration interne). Pour `/senior-review`, cela inclut le skill (fan-out par fichier) ET `senior-review-file` (enchaînement récolte → 12 axes → consolidation). C0/C0' s'appliquent à l'union des couches — une seule couche qui déclenche C0 suffit à justifier turnlock pour l'ensemble, et §5.3 explique pourquoi : les orchestrations imbriquées fusionnent en une FSM unique, pas une FSM par niveau.

La question *« y a-t-il une étape mécanique ? »* est nécessaire mais **pas suffisante**. Turnlock se justifie quand cette mécanique forme la colonne déterministe du workflow : elle doit porter l'état, décider le flux, valider les sorties, agréger les résultats, ou contrôler les boucles entre plusieurs moments de jugement.

Formulation pratique : **la phase Turnlock avance mécaniquement jusqu'au prochain point stable ; la délégation est le yield explicite vers du jugement agentique**. On ne crée donc pas une phase parce qu'il y a un agent, et on ne crée pas un agent parce qu'il y a une phase. On découpe d'abord le workflow entre mécanique déterministe et jugement non déterministe, puis on place les délégations là où la mécanique ne doit plus décider seule.

Deux axes indépendants justifient turnlock.

### Axe 1 — Nécessité structurelle (C0)

> *« L'orchestration fait-elle traverser de l'état mécanique à travers une frontière de process ? »*

Trois patterns structurellement incompatibles avec un skill pré-turnlock ou un agent seul :

**B1. Fan-out / fan-in**
```
mécanique: list N items → délégation batch (N frontières) → mécanique: agréger
```
L'état traverse N+1 contextes distincts, aucune conversation unique ne le porte.

**B2. Boucle avec condition mécanique de sortie**
```
loop:
  délégation: work
  mécanique: hash, compare, counter, plafond, décider transition
```
Entre itérations, le LLM ne porte pas la mémoire fiable du compteur/hash.

**B3. Branche conditionnelle entre délégations**
```
délégation 1 → mécanique: décider (if N>0 fix else done) → délégation 2 | done
```
L'état de la 1ère délégation doit survivre à la décision déterministe.

**Réponse à C0 :**
- **OUI** → turnlock **obligatoire** (pas d'alternative viable sans perdre la propriété de déterminisme mécanique)
- **NON** → passer à C0'

### Axe 2 — Optimisation économique (C0')

> *« Les étapes de jugement ont-elles des complexités hétérogènes qui bénéficieraient de models et/ou d'efforts différents ? »*

Une couche skill pré-turnlock + agents délègue déjà à des sub-agents — chacun a déjà son propre model/effort. Le gain de C0' ne vient donc pas de "sortir du main", mais de la **décomposition plus fine** : un agent monolithique (ex : `senior-review-file` qui fait récolte + 12 axes + consolidation en interne) peut être éclaté en N agents feuilles, chacun avec model/effort alignés sur la complexité de SON jugement atomique. Les étapes purement mécaniques (récolte de fichiers, dedup, format) descendent en Phase TS — zéro coût LLM sur ce segment :

```
étape triviale (classification) → haiku, effort:low
étape moyenne (analyse)         → sonnet, effort:medium
étape dure (deep reasoning)     → opus, effort:high
étape mécanique                 → TS pur, zéro LLM
```

Gain potentiel 5-20× sur le coût total, selon la répartition. L'hétérogénéité exploitable peut être sur **le model** (haiku/sonnet/opus), sur **l'effort** (low/medium/high d'un même model), ou simplement sur **l'isolation de contexte** (un sub-agent frais paye le prompt de 2k tokens au lieu de traîner 50k tokens d'historique de la main session).

**Bonus non-monétaire :** contexte frais par sub-agent = pas de pollution par l'historique main, pas de re-cache sur l'intégralité de la conversation.

**Conditions pour que le gain dépasse l'overhead de spawn — les trois doivent être satisfaites (chacune neutralise un coût distinct) :**
- Au moins une étape trivialement déléguable à un agent feuille bon marché — *sinon rien à gagner en premier lieu*
- Volume de tokens par étape ≥ 2-5k environ — *sinon l'overhead de spawn mange le gain*
- Skill invoqué fréquemment — *sinon la dette de complexité (FSM, skill-consumer, protocole) n'est jamais remboursée*

**Réponse à C0' :**
- **OUI** → turnlock **opportuniste** (choix de cost engineering, pas une obligation)
- **NON** → passer au fallback

### Fallback — skill pré-turnlock, éventuellement avec script

Si ni C0 ni C0' n'est satisfait, la couche est linéaire et homogène. Formes valides :

```
Skill pré-turnlock pur :
  Claude fait N étapes de jugement dans son contexte courant
  (aucun post-traitement mécanique)

Skill pré-turnlock + script terminal :
  Claude fait N étapes de jugement
  Bash: `bun run finalize < /tmp/output.json`
  (mécanique auto-contenue en sortie)

Skill pré-turnlock + script initial :
  Bash: `bun run prepare > /tmp/input.json`
  Claude lit input.json et fait son jugement
  (mécanique auto-contenue en entrée)
```

Turnlock serait un over-engineering : tu payes la complexité du protocole pour zéro bénéfice.

---

## 3. Arbre de décision

```
C0 (nécessité structurelle) ?
  ├── OUI → turnlock obligatoire
  └── NON → C0' (hétérogénéité économique exploitable) ?
             ├── OUI (volume ≥ 2-5k tokens/étape, agent feuille bon marché viable) → turnlock opportuniste
             └── NON → skill pré-turnlock (+ script terminal/initial si mécanique auto-contenue)
```

### Application au cas `/senior-review`

`/senior-review` est un **B1 fan-out/fan-in** : mécanique amont (lister les fichiers modifiés) → N délégations parallèles (un sub-agent par fichier) → mécanique aval (agréger les verdicts, compter par sévérité, formater). L'état traverse N+1 contextes, aucun LLM ne peut porter l'agrégation mécaniquement sans re-vérifier à chaque invocation. **C0 coché → turnlock obligatoire.**

Bonus C0' : la récolte par fichier mélange du mécanique (read, diff, glob) et du jugement (classifier I/O ops, inputs externes), et les 12 axes d'audit ont des complexités hétérogènes — décomposer permet d'allouer model/effort par étape et de descendre le mécanique en Phase TS. Le cas cumule donc nécessité structurelle ET opportunité économique.

---

## 4. Conditions de turnlockisabilité

Si §2 conclut "turnlock" (obligatoire ou opportuniste), vérifier ensuite que la couche est **effectivement turnlockisable** — les 4 conditions ci-dessous doivent toutes tenir, sinon l'adoption est bloquée même avec C0 coché :

### C1 — Décomposabilité fine des étapes

Chaque étape peut être étiquetée dans **une** des 4 catégories, pas d'hybride :

| Catégorie | Exécution | Cible |
|---|---|---|
| Phase TS pure | Dans le process turnlock, zéro Claude | — |
| `delegate` (`kind: "prompt"`) | Worker choisi par le consumer, souvent caller ou sub-agent frais | skill-judgment ou agent feuille |
| `delegateBatch` (`kind: "batch"`) | N jobs indépendants, parallélisables par le consumer | agents feuilles ou workers équivalents |

Une phase Turnlock peut contenir plusieurs étapes mécaniques de même intention avant de retourner un `transition`, un `delegate`, un `delegateBatch`, un `done` ou un `fail`. Inversement, une étape de jugement déléguée doit toujours être suivie par une phase de reprise qui consomme, valide et projette le résultat dans le state.

### C2 — Autonomie des délégations

Chaque délégation doit être **stateless vis-à-vis des autres**. Le contexte conversationnel qui existait dans un agent monolithique devient un `State` typé, injecté dans chaque prompt de job.

Test : *« Si je ne passe que ce prompt à un Claude vierge, peut-il faire le travail ? »*

### C3 — Agrégation mécanisable ou déléguable

Le fan-in (réconciliation de N résultats) a un traitement explicite :
- Pur TS (groupBy, count, format, fingerprint dedup), OU
- Un agent feuille dédié de synthèse si jugement sémantique nécessaire

Pas de *« je synthétise de mémoire »*.

### C4 — Schémas de résultat stables

Chaque délégation retourne un **JSON validable par Zod**. Imposer un format JSON côté agent feuille est une précondition (sinon `consumePendingResult` ne peut pas typer).

---

## 5. Transformations effectuées lors du passage

### 5.1 Remontée du dispatching

| Avant | Après |
|---|---|
| Prompt du skill pré-turnlock : *« spawn un agent par fichier »* | Phase TS : `jobs = files.map(...)` puis `io.delegateBatch({jobs})` |
| Prompt de l'agent : *« phase 0 puis phase 1 puis... »* | `transition(nextPhase)` entre phases typées |

### 5.2 Décomposition mécanique/jugement intra-phase

Une phase initialement présentée comme monolithique (ex: Récolte de `senior-review-file`) se splitte :

| Étape | Nature | Destination |
|---|---|---|
| Read file, git diff | Mécanique | Phase TS `recolteMechanique` |
| Parse exports/imports, glob tests | Mécanique | Phase TS `recolteMechanique` |
| Classifier I/O ops, inputs externes | Jugement | `delegate({ worker: "recolte-semantic", ... })` (agent feuille côté consumer) |

Le split n'est pas "une phase par délégation". Le split correct est : une phase TS pour stabiliser et persister le segment mécanique, une délégation pour le jugement, puis une phase TS de reprise pour consommer et valider le résultat. Si deux segments TS consécutifs représentent le même point stable et la même intention, ils se fusionnent ; s'ils représentent deux états métier distincts, ils restent deux phases même sans délégation entre eux.

### 5.3 Dissolution des agents orchestrateurs (en deux temps)

Cas général : un agent existant contient à la fois **du jugement** (plusieurs analyses sémantiques) **et de l'orchestration** (enchaîner ces analyses, agréger). Il n'est donc pas un pur orchestrateur au départ. La dissolution est alors **en deux temps** :

**Temps 1 — Extraction du jugement vers des agents feuilles.** Chaque analyse sémantique distincte est sortie en agent feuille spécialisé (contexte frais dédié, prompt focalisé, model/effort choisis). Pour `senior-review-file` : les 12 axes deviennent l'agent feuille `axe-auditor` (paramétré par l'axe), les classifications sémantiques de la récolte deviennent l'agent feuille `recolte-semantic`.

**Temps 2 — Dissolution de l'agent résiduel.** Après extraction, l'agent d'origine ne contient plus que de l'orchestration (récolte mécanique, dispatch des axes, consolidation). Il n'a plus de raison d'être comme agent — son orchestration est **absorbée dans la FSM turnlock de la couche englobante** : les orchestrations jadis imbriquées (skill pré-turnlock → sub-agent orchestrateur) fusionnent en une FSM unique. Turnlock ne nested pas les FSMs. L'agent disparaît complètement (ni skill-consumer, ni skill-judgment, ni agent).

Cas particulier : un agent déjà pur orchestrateur (zéro jugement propre, dispatch+consolidate uniquement) saute le Temps 1 et dissout directement.

### 5.4 Shared state → input explicite

Le contexte conversationnel implicite devient un `State` typé :

```ts
type State = {
  files: string[];
  recolteMechanique: Record<string, MechanicalRecolte>;
  recolteJudgment: Record<string, JudgmentRecolte>;
  findings: Array<{file: string; axe: string; items: Finding[]}>;
};
```

Chaque délégation reçoit le slice dont elle a besoin dans son prompt.

### 5.5 Extraction des prompts hors du markdown d'agent

Les protocoles par-invocation (ex : protocoles d'axes noyés dans `senior-review-file.md`) sont extraits en modules TS versionnés — un fichier prompt par axe (`src/axes/cheat-detection.prompt.ts`, etc.) — puis injectés dans le **même** agent feuille `axe-auditor` à chaque délégation (paramétrage par le prompt injecté, pas par N agents distincts). Les règles communes stables (conduite, sévérités, calibration) restent dans le frontmatter de l'agent feuille — évite la duplication × N spawns.

---

## 6. Architecture d'arrivée canonique

### Types d'unités dans l'architecture post-turnlock

| Unité | Rôle | Contient |
|---|---|---|
| **Phase turnlock (TS)** | Mécanique déterministe, orchestration, state transitions, validation | Code TS typé, testable, persisté atomiquement |
| **skill-consumer** | Point d'entrée utilisateur + bridge protocole `@@TURNLOCK@@` ↔ tools Claude (Agent, Skill) | Prompt décrivant : lancer turnlock, mapper les blocs DELEGATE, écrire résultats, relancer avec --resume, boucler jusqu'à DONE |
| **skill-judgment** *(optionnel)* | Jugement invocable via `delegate(...)` depuis une FSM | Prompt de jugement pur, zéro logique de protocole. Typiquement un skill pré-turnlock réutilisé sans refonte. |
| **Agent feuille** | Un jugement atomique, contexte frais, model/effort choisis | Config stable dans `.md`, zéro logique orchestrale |

### Ce qui disparaît

- Agents orchestrateurs (dissous en Phase turnlock + agents feuilles)
- Skills pré-turnlock contenant de la logique d'orchestration mécanique (boucle/compteur/plafond, fan-out/fan-in, branchements conditionnels) — refondus en FSM turnlock + skill-consumer
- Tools hybrides (`Agent` ajouté à un agent juste pour qu'il puisse orchestrer — plus nécessaire, l'orchestration est en TS)
- Context conversationnel implicite traversant plusieurs étapes

### Forme visuelle

```
[Main session]
  └── invoke skill-consumer (/senior-review)
      │
      ├── skill-consumer instruit Claude : lance `bun run turnlock-X`
      │
      └── process turnlock (frère UNIX, pas un agent)
          │  runOrchestrator(config) avec FSM typée
          │
          ├── phase mécanique → TS pur, zéro spawn
          ├── phase de délégation → émet @@TURNLOCK@@ DELEGATE, exit 0
          │      ↓
          │   skill-consumer lit le bloc, route prompt/batch vers le worker
          │   approprié, écrit résultats, relance turnlock --resume
          │      ↓
          │   (N jobs indépendants en parallèle pour batch)
          │
          ├── phase mécanique de consolidation → TS pur
          └── done → skill-consumer affiche output à l'utilisateur
```

**Profondeur de nesting Claude** = uniquement ce que le choix de worker du consumer impose. Turnlock n'ajoute aucun niveau. Le skill-consumer s'exécute dans le contexte du caller (zéro niveau ajouté).

---

## 7. Checklist opérationnelle

### Étape 1 — Décision d'adoption (obligatoire avant toute chose)

Évaluer les deux axes indépendamment :

- [ ] **C0 — Nécessité structurelle** : fan-out/fan-in, boucle, ou branche conditionnelle avec état mécanique entre délégations ?
- [ ] **C0' — Hétérogénéité économique** : étapes de jugement de complexité hétérogène (models/efforts exploitables, isolation de contexte utile), volume ≥ 2-5k tokens par étape, skill invoqué fréquemment ?

Verdict :
- **C0 coché** → turnlock **obligatoire** (les alternatives ne préservent pas le déterminisme mécanique)
- **C0 non coché, C0' coché** → turnlock **opportuniste** (arbitrage perf/cost vs complexité ; évaluer overhead de spawn)
- **Aucun des deux** → skill pré-turnlock + éventuel script terminal/initial ; turnlock serait de l'over-engineering

### Étape 2 — Vérification de turnlockisabilité

Si l'adoption est décidée :

- [ ] **C1 — Décomposabilité** : chaque étape étiquetée clairement (TS-pur / `delegate` prompt single / `delegateBatch` jobs parallèles), pas d'hybride ?
- [ ] **C2 — Autonomie** : state partagé explicitable dans un `State` typé, délégations stateless entre elles ?
- [ ] **C3 — Agrégation** : fan-in mécanisable (pur TS) ou déléguable à un agent feuille dédié ?
- [ ] **C4 — Schémas** : chaque délégation retourne un JSON validable par Zod ?

### Étape 3 — Hygiène d'implémentation

- [ ] Prompts par-invocation extraits en modules TS versionnés (pas noyés dans le `.md` d'agent feuille)
- [ ] Règles communes stables dans le `.md` de l'agent feuille (évite duplication × N spawns)
- [ ] Choix de model/effort par agent feuille documenté (lié à C0')
- [ ] skill-consumer écrit : instructions claires de mapping `DELEGATE.kind` + `worker?` → worker Claude/consumer, gestion des résultats, boucle de `--resume`

Si toutes cochées → gain net : déterminisme, testabilité, inspectabilité du `state.json`, séparation code/jugement, granularité cost.

Si C2 échoue → couplage conversationnel caché à élucider avant turnlockisation.

Si uniquement C0' (pas C0) et overhead estimé > gain → renoncer, skill pré-turnlock + script reste supérieur.
