# Runtime / Consumer Separation — Work Log

**Date d'ouverture** : 2026-04-22
**Statut** : Level 1 terminé (éditorial), Level 2 en attente de validation

## Contexte

Une analyse de la codebase a révélé que ce repo contient **deux produits distincts** qui cohabitaient sans distinction claire :

- **Produit A — le runtime** (implémenté, quasi stable) : un runtime générique d'exécution de machines à états durable. Le core ne connaît ni Claude Code, ni skills, ni agents — il émet des strings opaques sur stdout et fait confiance à un parent process pour interpréter et relancer.

- **Produit B — l'intégration Claude Code** (à l'état de spec) : l'ensemble des meta-skills, binaire CLI, hook, templates, conventions filesystem qui font de A un outil utile dans une session Claude Code. Consomme A comme dépendance.

Garder les deux fusionnés :
- empêche A d'être découvert par des consommateurs non-Claude,
- attache A au rythme d'évolution rapide de B (churns Claude Code),
- pollue le mental model des lecteurs qui voient "cc-orchestrator" et croient à un outil Claude-only.

## Level 1 — Éditorial (terminé 2026-04-22)

Ajustements **locaux, réversibles, sans toucher au protocole ni aux specs** :

- [x] `docs/UX-VISION-AND-GAPS.md` → `docs/consumers/claude-code/UX-VISION-AND-GAPS.md` (c'est de la doc consommateur B, pas runtime A)
- [x] `.gitignore` mis à jour avec le nouveau chemin
- [x] `docs/consumers/README.md` créé — explique la séparation conceptuelle
- [x] `docs/consumers/claude-code/README.md` créé — cadre le scope de l'intégration Claude
- [x] `CLAUDE.md` projet repositionné : "runtime" (pas "lib d'infrastructure"), neutralité du cœur explicitée
- [x] `README.md` racine repositionné : durable FSM runtime avec Claude Code comme premier consommateur

## Level 2 — Dé-claudification en profondeur (à planifier)

Changements qui touchent le **contrat du runtime** et/ou les **specs autoritatives**. Chacun mérite une délibération dédiée avant exécution.

### L2-1 · Renommer le tag protocole `@@CC_ORCH@@` → `@@ORCH@@` (ou autre) + identifiants onomastiques associés

**Scope** :
- `src/services/protocol.ts` (writer + parser, 5 occurrences)
- **Env var `CC_ORCH_TEST`** dans `src/engine/context.ts:39` — même préfixe onomastique, à renommer (`ORCH_TEST` ?).
- `tests/services/protocol.test.ts`, `tests/helpers/protocol-asserts.ts`, `tests/helpers/mock-stdio.ts`
- **Fixtures de tests** : `tests/fixtures/protocol/*.txt` (7 fichiers) contiennent le tag en dur.
- ~40 mentions dans les NIBs (`NIB-S-CCOR`, `NIB-M-PROTOCOL`, `NIB-M-BINDINGS`, `NIB-T-CCOR`)
- Doc NX consolidé (88 occurrences — cf L2-4 pour le chantier NX global)
- `constants.ts` — vérifier si `PROTOCOL_VERSION` ou autres identifiants encodent "CC_ORCH" (a priori non mais à confirmer).

**Impact** : changement de protocole (breaking). Pas d'impact externe aujourd'hui car aucun consommateur publié. Le `PROTOCOL_VERSION` reste à `1` (c'est une dé-ornementation du tag, pas un changement de sémantique).

**Nom à trancher** : `@@ORCH@@` (court, générique) vs `@@DFSM@@` (durable finite-state-machine, plus descriptif mais jargonneux) vs `@@PHASE@@` (centré sur le concept phase) vs autre.

**Condition d'exécution** : décision explicite du mainteneur sur le nom.

### L2-2 · Généraliser le chemin `RUN_DIR`

**Scope** :
- `src/services/run-dir.ts` — aujourd'hui hardcodé à `<cwd>/.claude/run/cc-orch/<orchestratorName>/<runId>/` (2 endroits).
- **Tests qui hardcodent le chemin** (à migrer en cohérence, sinon les tests cassent) :
  - `tests/bindings/skill-binding.test.ts:7`
  - `tests/bindings/agent-binding.test.ts:7`
  - `tests/bindings/agent-batch-binding.test.ts:8`
  - `tests/services/run-dir.test.ts` (10+ occurrences)
  - `tests/helpers/temp-run-dir.ts:25-27` (le helper qui fabrique les chemins temp)
- `.gitignore` contient `.claude/run/` (ligne 91) — à ajuster selon la nouvelle convention.
- NIBs qui décrivent la convention `RUN_DIR` (cf L2-4).

**Impact** : changement breaking pour quiconque se base sur ce chemin (aucun consommateur public aujourd'hui). Le chemin par défaut pourrait devenir `<cwd>/.orch-runs/<orchestratorName>/<runId>/` ou paramétrable via env var / config.

**Condition d'exécution** : réflexion sur la convention par défaut et le mécanisme de surcharge (env var `ORCH_RUN_DIR` ? Champ `OrchestratorConfig.runDirRoot` ?).

### L2-3 · Renommer le package npm + métadonnées associées

**Scope** :
- `package.json` field `name` : `cc-orchestrator-runtime` → nom neutre (`durable-fsm-runtime` ? `phase-runtime` ? autre).
- `package.json` field `description` : actuellement *"Normalized execution engine for phase-structured orchestrators **inside Claude Code sessions**. Snapshot-authoritative state, in-band stdout protocol, POSIX-grade I/O discipline."* — la mention Claude Code doit disparaître. Formulation cible proche du README racine refondu.
- `package.json` `license: "UNLICENSED"` + `private: true` — quand le package devient publiable, nécessite un **LICENSE** réel (MIT ? Apache-2 ? à trancher) et `private: false`.
- **Description du repo GitHub** (`fanilosendrison/cc-orchestrator-runtime`) probablement aussi Claude-couplée — à éditer via GitHub UI ou `gh repo edit`.
- **Nom du repo GitHub** lui-même : si rename (cohérent avec L2-5), bouge l'URL du remote. Les redirections GitHub tiennent l'ancien nom mais c'est un changement visible.

**Impact** :
- Pré-publication npm : trivial côté package.
- Post-publication : nécessite deprecation de l'ancien nom + republication sous nouveau nom.
- Changement de nom de repo GitHub : tolérable (redirections auto) mais perturbe les forks, issues, PRs.

**Condition d'exécution** : décision produit + dispo du nom sur npm + choix de licence.

### L2-4 · Mettre à jour les specs et docs de conception pour neutraliser "Claude Code"

**Scope** :
- Les 4 NIBs qui mentionnent Claude / skills / agents comme si c'était partie intégrante du runtime : `NIB-S-CCOR.md`, `NIB-M-PROTOCOL.md`, `NIB-M-BINDINGS.md`, `NIB-T-CCOR.md`. ~30+ passages à reformuler.
- **Renommage des fichiers NIB portant le suffixe `CCOR`** dans leur nom :
  - `NIB-S-CCOR.md` → `NIB-S-<NEW>.md` (System Brief)
  - `NIB-T-CCOR.md` → `NIB-T-<NEW>.md` (Tests Brief)
  - Les 15 `NIB-M-*.md` n'ont **pas** `CCOR` dans leur nom (ils portent leur nom de module : `BINDINGS`, `PROTOCOL`, etc.) — **pas de rename côté NIB-M**.
  - Nouveau suffixe à trancher en cohérence avec L2-3 (nom du package) : si package devient `durable-fsm-runtime`, alors `NIB-S-DFSM.md` / `NIB-T-DFSM.md`, etc.
  - Impact : chaque rename de fichier met à jour les cross-références internes (les NIBs se citent entre elles via `NIB-S-CCOR §X`), les frontmatter YAML (champ `name` ou `id` si présent), et la régénération de `SPEC_MANIFEST.md`.
- **`docs/NX-CC-ORCHESTRATOR-RUNTIME.md`** — le concept consolidé v0.8. Son **nom de fichier** est Claude-onomastique ET il contient **88 occurrences** de `CC_ORCH` / `cc-orch` / `claude`. Renommer le fichier (`NX-RUNTIME.md` ? `NX-DURABLE-FSM.md` ?) + passer son contenu au tamis.
- **Examples dans les specs** : noms récurrents `senior-review`, `loop-clean`, `backlog-crush` = skills Claude. Neutraliser en `phase-foo`, `consumer-skill-x`, ou garder avec note "exemple illustratif issu du consommateur Claude Code".
- `PROJECT_INDEX.md` et `SPEC_MANIFEST.md` — régénérés par le scanner (`/repo-indexer`), suivront automatiquement une fois les sources à jour.
- `STACK_EVAL.yaml` : la justification du choix Bun mentionne `~/.claude/scripts` — ajouter une note précisant que c'était le premier cas d'usage, sans faire de Claude un prérequis.
- **Cross-refs dans le code** : les commentaires `// NIB-M-LOGGER`, `// NIB-M-PROTOCOL` etc. dans `src/` pointent vers les NIBs — pas affectés par le rename (les NIB-M gardent leurs noms). Mais les refs à `NIB-S-CCOR` / `NIB-T-CCOR` (s'il y en a dans le code ou les tests) doivent suivre.

**Impact** : travail éditorial significatif (~1j solide). Les specs deviennent **vraiment** neutres, la couche consommateur est mentionnée comme une illustration, pas comme une hypothèse. Impact sur `specs-serializer` et `/repo-indexer` : aucun (ce sont des conventions frontmatter, pas de contenu).

**Condition d'exécution** : slot dédié, à faire en un chantier bloc (éviter les passes partielles qui créent des incohérences entre fichiers).

### L2-5 · Extraction du produit B dans un repo séparé

**Scope** : créer `cc-orch-claude` (ou équivalent) comme repo git distinct qui dépend de A via npm. Y migrer :
- `docs/consumers/claude-code/` (toute la vision UX actuelle)
- **Tout le code B futur qui n'existe pas encore** :
  - Binaire CLI `cc-orch` (gap CRITICAL de [`consumers/claude-code/UX-VISION-AND-GAPS.md`](consumers/claude-code/UX-VISION-AND-GAPS.md) §9.3)
  - Meta-skills `cc-orch` et `orchestrator-author`
  - Hook `detect-approval.ts` (optionnel, §9.2)
  - Templates (`main.ts.hbs`, `skill.md.hbs`)
  - Convention filesystem `~/.cc-orch/adhoc/`, `~/.claude/scripts/`

**Important** : aucun code B n'existe aujourd'hui. L'extraction consiste essentiellement à **créer un repo vide avec la structure cible** + y déposer `docs/consumers/claude-code/`. Le timing est donc **optimal** — plus on attend, plus du code s'accumule dans A qui devrait être dans B.

**Impact** : sépare physiquement les deux produits. A devient publishable seul. Les deux ont des lifecycles indépendants. C'est **le vrai objectif** de la séparation — L2-1 à L2-4 préparent le terrain, L2-5 le matérialise.

**Condition d'exécution** :
- Décision sur le nom du repo B (`cc-orch-claude` ? `cc-orch` ? autre ?)
- Décision sur l'org GitHub / owner
- Décision sur la stratégie de publication npm pour B (publier ? garder privé ? publier seulement le runtime A ?)
- Décision sur la licence de B (peut différer de A)

### L2-6 · Décision sur le vocabulaire des bindings (`skill` / `agent` / `agent-batch`)

**Constat** : l'API publique du runtime utilise un vocabulaire **onomastiquement Claude** pour classifier les délégations :

- **Types** : `SkillDelegationRequest`, `AgentDelegationRequest`, `AgentBatchDelegationRequest` (`src/types/delegation.ts`)
- **Tags** : `kind: "skill" | "agent" | "agent-batch"` (7+ endroits : `types/delegation`, `types/events`, `bindings/types`, `state-io`, `protocol`, `engine/context`, `engine/shared`)
- **Bindings** : `skillBinding`, `agentBinding`, `agentBatchBinding` (`src/bindings/`)
- **Méthodes de `PhaseIO`** : `delegateSkill`, `delegateAgent`, `delegateAgentBatch` (`src/types/phase.ts`)

Ce vocabulaire est **plus qu'un nommage cosmétique** — il encode dans la sémantique publique l'hypothèse que le consommateur parle en "skills" et "agents", ce qui est **vrai pour Claude Code**, **faux pour un autre consommateur** (un runner CI n'a pas de "skills", un REPL n'a pas d'"agents").

**Décision à trancher** :

| Option | ✅ Avantage | ❌ Inconvénient |
|---|---|---|
| **A : Garder le vocabulaire** avec note "convention portable" | Aucun breaking change API/protocole/specs. Un parent non-Claude peut simplement mapper `skill → commande shell`, `agent → worker`, `agent-batch → pool`. | Onomastique Claude dans la surface publique — perception "c'est pour Claude". |
| **B : Neutraliser** en `kind: "sync" \| "async" \| "parallel"` (ou `"task" \| "subtask" \| "batch"`) | API et specs vraiment neutres. Cohérent avec la position "runtime générique". | Breaking change majeur : protocole, types publics, méthodes de `PhaseIO`, bindings, tests, NIBs. ~1-2j de travail. |

**Recommandation softe** : Option A avec documentation explicite ("`skill` est un label générique — toute tâche synchrone à résultat unique" etc.). Option B deviendra intéressante si/quand un second consommateur émerge et qu'on découvre qu'un mapping 1-1 vers son vocabulaire est tordu.

**Condition d'exécution** : décision explicite à prendre avant L2-5 (l'extraction). Si l'option B est retenue, la faire **avant** ou **pendant** L2-4 pour éviter deux chantiers éditoriaux.

---

## Pourquoi Level 1 avant Level 2

Level 1 est **sans risque** : pas de changement de protocole, pas de rupture de specs, pas de migration externe. Il **clarifie la pensée** (A vs B bien identifiés dans l'arborescence docs) et **prépare le terrain** pour les décisions Level 2.

Level 2 bouge des contrats (protocole, chemins, noms de package). Chaque item mérite une délibération ciblée, car les décisions sont **difficiles à revenir** une fois publiées externement.

## Référence — message de synthèse original

Ce chantier a été ouvert suite à une conversation où il est devenu clair que le nom "cc-orchestrator-runtime" et le cadrage "lib d'infrastructure pour Claude Code" sous-décrivaient la nature réelle de l'artefact : **un runtime générique de FSM durable, dont Claude Code est le premier consommateur parmi d'autres possibles**.
