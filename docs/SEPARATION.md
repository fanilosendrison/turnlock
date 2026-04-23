# Runtime / Consumer Separation — Work Log

**Date d'ouverture** : 2026-04-22
**Statut** : Level 1 terminé (éditorial), Level 2 — L2-1 / L2-2 / L2-3 / L2-4 / L2-6 clos au 2026-04-23 (avec passe positionnement README + NIB-S §1 sur frame 4-exigences). Reste : L2-5 extraction repo B.

## Contexte

Une analyse de la codebase a révélé que ce repo contient **deux produits distincts** qui cohabitaient sans distinction claire :

- **Produit A — le runtime** (implémenté, quasi stable, aujourd'hui nommé **turnlock**) : un runtime générique d'exécution de machines à états durable. Le core ne connaît ni Claude Code, ni skills, ni agents — il émet des strings opaques sur stdout et fait confiance à un parent process pour interpréter et relancer.

- **Produit B — l'intégration Claude Code** (à l'état de spec) : l'ensemble des meta-skills, binaire CLI, hook, templates, conventions filesystem qui font de A un outil utile dans une session Claude Code. Consomme A comme dépendance.

Garder les deux fusionnés :
- empêche A d'être découvert par des consommateurs non-Claude,
- attache A au rythme d'évolution rapide de B (churns Claude Code),
- polluait le mental model des lecteurs qui voyaient "cc-orchestrator" et croyaient à un outil Claude-only (résolu par le rename `turnlock`, 2026-04-23).

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

### L2-1 · Renommer le tag protocole `@@CC_ORCH@@` → `@@TURNLOCK@@` + identifiants onomastiques associés — ✅ EXÉCUTÉ 2026-04-23

**Scope exécuté** :
- [x] `src/services/protocol.ts` (writer + parser, 5 occurrences) → `@@TURNLOCK@@`
- [x] Env var `CC_ORCH_TEST` → `TURNLOCK_TEST` dans `src/engine/context.ts`
- [x] `tests/services/protocol.test.ts`, `tests/helpers/protocol-asserts.ts`, `tests/helpers/mock-stdio.ts`
- [x] Fixtures de tests `tests/fixtures/protocol/*.txt`
- [x] Mentions dans les NIBs (`NIB-S-CCOR`, `NIB-M-PROTOCOL`, `NIB-M-BINDINGS`, `NIB-T-CCOR`)
- [x] Doc NX consolidé (renommé `NX-TURNLOCK.md`)
- [x] `constants.ts` : aucun identifiant encodant "CC_ORCH" confirmé.

**Impact** : changement de protocole (breaking). Pas d'impact externe (aucun consommateur publié). `PROTOCOL_VERSION` reste à `1` (dé-ornementation du tag, pas changement de sémantique). Bump package version `0.1.0` → `0.2.0`.

### L2-2 · Généraliser le chemin `RUN_DIR` — ✅ EXÉCUTÉ 2026-04-23

**Décisions prises** :
- **Nouveau défaut** : `<cwd>/.turnlock/runs/<orchestratorName>/<runId>/` (préfixe neutre propre au runtime, relatif à `cwd`).
- **Précédence d'override** (plus prioritaire → plus faible) :
  1. Env var `TURNLOCK_RUN_DIR_ROOT` — override externe (tests, wrappers consommateurs, dont le futur Claude Code).
  2. Champ `OrchestratorConfig.runDirRoot?: string` — contrôle programmatique dans le script TS.
  3. Défaut `.turnlock/runs` (relatif à `cwd`).
- Si `runDirRoot` est **relatif**, il est joint à `cwd`. Si **absolu**, utilisé tel quel. Path final = `<root>/<name>/<runId>`.
- Env var string vide → traité comme non défini (fallback sur config/défaut).

**Scope exécuté** :
- [x] `src/types/config.ts` : ajout `runDirRoot?: string` à `OrchestratorConfig`.
- [x] `src/services/run-dir.ts` réécrit : helper interne `resolveRunDirRoot(cwd, configRoot?)` qui applique la précédence env > config > défaut. Signatures `resolveRunDir` et `cleanupOldRuns` étendues avec `runDirRoot?: string` optionnel.
- [x] `src/engine/run-orchestrator.ts` : threading de `config.runDirRoot` aux 3 call sites (initial `resolveRunDir`, `cleanupOldRuns`, resume `resolveRunDir`).
- [x] `specs/NIB-M-RUN-DIR.md` mis à jour : §1 précédence, §2 signature + règles + tests T-RD-09..12, §3 signature, §5 snippets consommation, §6 DoD.
- [x] `specs/NIB-S-TURNLOCK.md` §10.1 step 4 reformulé avec la précédence.
- [x] `specs/NIB-T-TURNLOCK.md` §7.1 : tableau T-RD-01 output refresh (`.turnlock/runs/`) + ajout T-RD-09..12 pour override. §12.1 : fixture `runDir` refresh. Notes de provenance refresh.
- [x] `specs/NIB-M-PROTOCOL.md` §5 : exemples `manifest:` refresh vers `/tmp/.turnlock/runs/...` + note intro reformulée.
- [x] `docs/NX-TURNLOCK.md` : 7 mentions refresh (§4.3, §5, §6, §12.1, §14.1, §14.2, §25).
- [x] `tests/services/run-dir.test.ts` : migré vers nouveau défaut + 5 nouveaux tests (T-RD-09..12, T-RD-13 cleanup honors custom root). Env var nettoyée avant/après chaque test.
- [x] `tests/bindings/{skill,agent,agent-batch}-binding.test.ts` : constante `RUN_DIR` refresh vers `/tmp/.turnlock/runs/...`.
- [x] `tests/helpers/temp-run-dir.ts` : helper refresh vers `.turnlock/runs/`.
- [x] `.gitignore` : ajout `.turnlock/` (ligne dédiée au nouveau défaut) + conservation `.claude/run/` (override legacy toujours possible via env var pour le futur wrapper Claude Code).

**Compat wrapper Claude Code (L2-5, à venir)** : le futur binaire `cc-orch` setera `TURNLOCK_RUN_DIR_ROOT=.claude/run/cc-orch` avant de lancer le runtime — zéro code à toucher côté runtime.

**Impact** : breaking sur le chemin des RUN_DIRs (aucun consommateur publié aujourd'hui). Les scripts existants en dev local qui référencent `.claude/run/cc-orch/…` doivent soit migrer vers `.turnlock/runs/…`, soit setter `TURNLOCK_RUN_DIR_ROOT=.claude/run/cc-orch` pour conserver l'ancien chemin.

### L2-3 · Renommer le package npm + métadonnées associées — ✅ CLOS 2026-04-23 (réservation seule)

**Scope exécuté** :
- [x] `package.json` field `name` : `cc-orchestrator-runtime` → `turnlock`
- [x] `package.json` field `description` reformulée (neutre, sans mention Claude Code)
- [x] Nom du repo GitHub : repositionné sur `github.com/fanilosendrison/turnlock` (remote origin mis à jour)
- [x] Package npm `turnlock` (nom nu) réservé

**Décision 2026-04-23** : on **n'aligne pas** la description du repo GitHub et on **garde** `license: "UNLICENSED"` + `private: true` tels quels. Objectif L2-3 = **réserver le nom** (npm + GH handle), rien de plus. Tant qu'aucune publication n'est planifiée, ces deux items sont volontairement laissés en l'état :

- **Description GH vide** : volontaire — pas de signal public tant que le projet n'est pas publish-ready.
- **`UNLICENSED` + `private: true`** : empêche un `npm publish` accidentel et reflète la réalité (pas de licence open-source décidée). À rouvrir le jour où une publication est planifiée — le choix MIT vs Apache-2 vs autre se fera à ce moment-là, pas maintenant.

**Impact** :
- Pré-publication npm : noms réservés, métadonnées internes au package cohérentes (`turnlock`, description neutre).
- Post-publication : N/A — pas de publication prévue dans l'horizon court terme.

### L2-4 · Mettre à jour les specs et docs de conception pour neutraliser "Claude Code" — ✅ EXÉCUTÉ 2026-04-23

**Scope exécuté — phase 1 (rename identifiants, 2026-04-23 matin)** :
- [x] `NIB-S-CCOR.md` → `NIB-S-TURNLOCK.md`
- [x] `NIB-T-CCOR.md` → `NIB-T-TURNLOCK.md`
- [x] `docs/NX-CC-ORCHESTRATOR-RUNTIME.md` → `docs/NX-TURNLOCK.md` (fichier local gitignored, renommé pour cohérence)
- [x] Mentions `cc-orchestrator-runtime` remplacées dans les 15 `NIB-M-*.md` et autres docs
- [x] Cross-refs `NIB-S-CCOR §X` et `NIB-T-CCOR §X` mises à jour → `NIB-S-TURNLOCK §X` / `NIB-T-TURNLOCK §X`

**Scope exécuté — phase 2 (dé-claudification éditoriale, 2026-04-23 PM)** :
- [x] `NIB-S-TURNLOCK.md` §1.1, §1.2, §1.3 reformulés : runtime générique, premier consommateur Claude Code (au lieu de "strictement Claude-Code-dépendant"). §2.2 ligne "Hors scope" reformulée en "Exécution sans parent process".
- [x] `NIB-T-TURNLOCK.md` §0.3, §29.3, §31 reformulés : "vrai parent process" remplace "vraie session Claude Code", note sur les consommateurs en usage quotidien.
- [x] `NIB-M-PROTOCOL.md` §5 : note d'intro précisant que les exemples (`senior-review`, `/tmp/.claude/run/...`) viennent du premier consommateur Claude Code et sont des labels opaques pour le runtime.
- [x] `NIB-M-RUN-DIR.md` §1 : note L2-2 sur la convention `<cwd>/.claude/run/cc-orch/...` héritée du premier consommateur.
- [x] Exemples illustratifs gardés avec note de provenance (pas renommés en `phase-foo` — reste plus parlant et n'engage pas l'archi du runtime).
- [x] `STACK_EVAL.yaml` (`spec_constraints`, `runtime`, `linter`) annotés : `~/.claude/scripts` = premier cas d'usage Claude Code, pas prérequis.
- [x] `PROJECT_INDEX.md` régénéré (Git ref 5639ab0, runtime-positioning + structure réelle src/engine/services/bindings).
- [x] `SPEC_MANIFEST.md` régénéré via `bun ~/.claude/scripts/index-repo/src/cli.ts --force`.
- [x] `bun test` 490/490 passe — aucune régression introduite par la passe éditoriale.

**Frontmatter `consumers: [claude-code]`** : volontairement gardé tel quel dans tous les NIBs. C'est une déclaration sémantiquement correcte (Claude Code est un consommateur connu) qui pourra être étendue à mesure que d'autres consommateurs émergent. Pas une contradiction avec la position "runtime générique".

**Scope exécuté — phase 3 (résidus + relocalisation, 2026-04-23 PM)** :
- [x] `docs/EXECUTION-FLOW-WALKTHROUGH.md` déplacé vers `docs/consumers/claude-code/EXECUTION-FLOW-WALKTHROUGH.md` (cohérent avec L1 — c'est un doc consommateur). `.gitignore` mis à jour.
- [x] Walkthrough : refresh `@@CC_ORCH@@` → `@@TURNLOCK@@` (toutes occurrences), `cc-orchestrator-runtime` → `turnlock`, `NX-CC-ORCHESTRATOR-RUNTIME.md` → `NX-TURNLOCK.md`, `prefix CC_ORCH` → `prefix TURNLOCK`.
- [x] `NIB-T-TURNLOCK.md` : résidus `/tmp/ccor-test-*` → `/tmp/turnlock-test-*` (§1.4, §28.1).
- [x] `tests/helpers/temp-run-dir.ts` (default arg) et `tests/helpers/mock-fs.ts` (2 occurrences) : préfixe temp dir `ccor-test-` → `turnlock-test-` pour aligner code et NIB-T (résolution divergence spec↔code détectée passe 3).
- [x] `NIB-T-TURNLOCK.md` §7.1 (T-RD) et §12.1 (T-SK) : notes d'intro précisant que les noms et chemins des fixtures viennent du premier consommateur Claude Code.
- [x] `NIB-M-RUN-DIR.md` §2.3 : note explicite que le préfixe `.claude/run/cc-orch/` est en dur tant que L2-2 n'est pas exécuté (renvoi vers `docs/SEPARATION.md` L2-2).
- [x] `docs/consumers/claude-code/UX-VISION-AND-GAPS.md` : titre passé à "Turnlock x Claude Code", toutes mentions `CCOR` / `cc-orchestrator-runtime` / `@@CC_ORCH@@` / `NX-CC-ORCHESTRATOR-RUNTIME` / `NIB-S-CCOR` / `NIB-T-CCOR` / phrases de déclencheurs ("en ccor", etc.) refresh vers `turnlock` / `@@TURNLOCK@@` / `NX-TURNLOCK` / `NIB-S-TURNLOCK` / `NIB-T-TURNLOCK` / "en turnlock".
- [x] `bun test` 490/490 toujours passe.

**Hors scope L2-4** (déférés) :
- Enrichissement des `validates: []` des NIBs vers des globs explicites pointant vers `src/`/`tests/` — chantier transverse via repo-indexer step 1.5, à faire avant L2-5.
- Renommage des `kind: "skill" | "agent" | "agent-batch"` → c'est L2-6 (vocabulaire bindings).
- Généralisation effective du chemin `RUN_DIR` → c'est L2-2.

**Vérification résidus finale** : `grep -rn -iE "@@CC_ORCH@@|cc-orchestrator-runtime|CC_ORCH\\b|CCOR\\b|ccor-test|NX-CC-ORCHESTRATOR" specs/ docs/` retourne **uniquement** `docs/SEPARATION.md` (work log historique — mentions légitimes décrivant les renames eux-mêmes). Tout le reste est neutralisé.

**Impact** : la dé-claudification éditoriale est complète. Les passages qui présupposaient strictement Claude Code (vision, scope, statut, intro tests) sont reformulés en termes de "parent process arbitraire". Les exemples conservent leurs noms parlants (`senior-review`, etc.) avec note de provenance — ils n'engagent pas l'archi. Le doc `EXECUTION-FLOW-WALKTHROUGH` (intrinsèquement Claude Code) est désormais sous `docs/consumers/claude-code/`.

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

### L2-6 · Vocabulaire des bindings (`skill` / `agent` / `agent-batch`) — ✅ CLOS 2026-04-23 par décision Option A

**Décision** : garder `kind: "skill" | "agent" | "agent-batch"` tel quel, sans renommage. Pas de breaking change. La passe éditoriale ré-encadre ce vocabulaire dans le cadrage correct (positionnement turnlock, voir ci-dessous).

**Justification (acquise par délibération 2026-04-23 sur le frame public correct)** :

L'analyse initiale (Option A vs B) reposait sur le présupposé "le vocabulaire est onomastiquement Claude → c'est une dette". Cette analyse était **fausse**.

Le frame public correct de turnlock (formalisé dans README.md et NIB-S §1.1-§1.3 le 2026-04-23) est : **"a deterministic, reliable, auditable, host-agnostic runtime for orchestrating agent-host primitives from a TypeScript script"**. turnlock n'est **pas** un runtime FSM durable générique — c'est un **protocole de passerelle** entre un script TS déterministe et les **primitives agentiques internes à la session d'un host** (Claude Code, Codex, Aider, …) que le script ne peut pas invoquer directement.

Dans ce frame, `skill / agent / agent-batch` n'encodent **pas** une hypothèse Claude-specific. Ce sont les **trois catégories canoniques de primitives agent-host** que le runtime sait demander :

- `skill` = capacité nommée invokable du host avec args structurés (Claude Code SKILL.md, Codex command, etc.)
- `agent` = délégation freeform à un sub-agent du host (Claude Code Task tool, Codex sub-agent, etc.)
- `agent-batch` = N délégations parallèles à des sub-agents

Renommer (`skill → tool`, `kind: sync/async/parallel`, ou réduction à cardinalité pure `single/batch`) **dénaturerait** le propos : turnlock ne traite ni avec des "tools" génériques (au sens OpenAI/MCP — qui sont des appels que le script peut faire lui-même via SDK), ni avec de la cardinalité abstraite. Il traite **spécifiquement** avec ces trois shapes de primitives, et chaque host fournit son propre mapping concret (table dans `docs/consumers/README.md`).

**Le présupposé rejeté** : "un consommateur non-Claude n'aurait pas de skills/agents". Faux — tout host agent-capable (Codex, Aider, agent shell custom) expose les mêmes 3 catégories de primitives, sous des noms différents. Le runtime parle de **catégories**, le mapping vers les noms locaux du host vit chez le consommateur.

**Cas où le vocabulaire deviendrait inadéquat** : si un consommateur émerge dont les primitives ne tombent dans **aucune** de ces 3 catégories (ex. un host purement async avec des callbacks, ou un host à granularité fine type "1 message LLM = 1 délégation"). Dans ce cas, ce serait probablement le signe que ce consommateur n'est pas dans le scope cible de turnlock (cf. README "What turnlock is not"). On rouvrirait alors la décision.

**Action éditoriale faite en parallèle (passe positionnement 2026-04-23)** :
- [x] README.md réécrit : préambule passe de "durable FSM runtime" à "deterministic, reliable, auditable, host-agnostic runtime for orchestrating agent-host primitives". 4 exigences non-négociables explicitées (déterminisme + fiabilité + auditabilité + host-agnosticisme). Section "What turnlock is not" élargie (4 contre-positionnements : Temporal, AI SDK, in-process FSM, agent framework).
- [x] NIB-S §1.1 / §1.2 / §1.3 reformulés sur le même frame 4-exigences. §1.1 explicite l'origine concrète (boucles review-fix-verify dans Claude Code) et liste les approches plus simples qui violent au moins une exigence. §1.2 montre le mapping mécanisme→exigences. §1.3 contraste turnlock avec Temporal, SDK LLM, FSM libs, agent frameworks, bash+jq.
- [x] `docs/consumers/README.md` augmenté d'une table mapping `kind` → primitive host (Claude Code remplie, Codex / Aider en TBD).

---

## Pourquoi Level 1 avant Level 2

Level 1 est **sans risque** : pas de changement de protocole, pas de rupture de specs, pas de migration externe. Il **clarifie la pensée** (A vs B bien identifiés dans l'arborescence docs) et **prépare le terrain** pour les décisions Level 2.

Level 2 bouge des contrats (protocole, chemins, noms de package). Chaque item mérite une délibération ciblée, car les décisions sont **difficiles à revenir** une fois publiées externement.

## Référence — synthèse du repositionnement

Ce chantier a été ouvert (2026-04-22) suite à une conversation où il est devenu clair que le nom "cc-orchestrator-runtime" et le cadrage "lib d'infrastructure pour Claude Code" sous-décrivaient la nature réelle de l'artefact. Une première formulation intermédiaire ("runtime générique de FSM durable, dont Claude Code est le premier consommateur") a guidé les passes L2-1 à L2-4 (rename + dé-claudification éditoriale).

**Frame public final (acquis 2026-04-23)** : turnlock = **a deterministic, reliable, auditable, host-agnostic runtime for orchestrating agent-host primitives from a TypeScript script**. La durabilité n'est ni accidentelle ni générique — c'est une **conséquence obligée** de quatre exigences non-négociables conjointes (déterminisme + fiabilité + auditabilité + host-agnosticisme) qu'aucun outil existant ne satisfait simultanément sur le créneau "single-machine, single-user, zero-infra, host-bound". L'origine concrète : discipliner les boucles review-fix-verify dans des sessions Claude Code sans que l'agent réordonne, saute, ou improvise.

**Rename** exécuté le 2026-04-23 : le runtime s'appelle désormais **turnlock** — les trois lectures (tour agentique, transition atomique, O_EXCL lock single-writer) convergent toutes sur ce que fait le produit.

**Vocabulaire `skill / agent / agent-batch`** : conservé (L2-6 clos par décision Option A). Ce sont les trois catégories canoniques de primitives agent-host, pas une dette Claude-specific.
