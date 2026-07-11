# Consumer-layer documentation

Ce dossier contient la documentation des **consommateurs** du runtime, séparée de la documentation du runtime lui-même.

## Pourquoi cette séparation

Le runtime (code dans `src/`, specs dans `specs/NIB-*`) orchestre une FSM TypeScript dont les phases sont **soit mécaniques (in-process)**, **soit déléguées** (cf. README.md racine + NIB-S §1.2). Seules les phases déléguées requièrent un host/consumer capable d'exécuter le travail demandé — pour les phases mécaniques, le runtime n'a besoin de personne. Le runtime est **host-agnostique au niveau protocole** : il émet deux shapes neutres (`kind: "prompt" | "batch"`) via `@@TURNLOCK@@` sur stdout, mais il n'interprète **jamais** comment ces prompts sont exécutés concrètement.

Un **consommateur** est l'intégration entre le runtime et un **host agent-capable** précis (Claude Code, Codex, Cursor, opencode, Aider, …). Il fournit :

1. Le **mapping** des deux `kind` vers les primitives concrètes du host ou du consumer.
2. La **glue** qui lit les blocs `@@TURNLOCK@@`, exécute les primitives demandées, écrit les résultats dans `runDir/`, et relance le binaire avec `--resume`.
3. Les **conventions UX et tooling** spécifiques (binaires CLI, meta-skills, hooks, templates).

Garder la documentation consommateur séparée évite :

- que les docs runtime ne s'encombrent de références à un host particulier
- que les évolutions rapides côté consommateur (UX, meta-skills, hooks) ne polluent le rythme de stabilisation du runtime
- que le runtime soit perçu, par erreur, comme couplé à son premier consommateur

## Sous-dossiers

| Dossier | Consommateur (host) | Statut |
|---|---|---|
| [`claude-code/`](claude-code/) | Claude Code (binaire `cc-orch`, meta-skills, hook `UserPromptSubmit`, templates) | En design — voir `claude-code/UX-VISION-AND-GAPS.md` |

Hosts agent-capables potentiels (hors scope actuel, intégrations à écrire) : Codex, Cursor, opencode, Aider, scripts custom orchestrant des sessions LLM.

## Mapping `kind` → primitive consumer

Les deux `kind` du protocole `@@TURNLOCK@@` désignent des **shapes de travail**. Cette table ne concerne **que les phases déléguées** — les phases mécaniques s'exécutent in-process sans aller-retour avec le consumer. Chaque consommateur fournit son propre mapping concret :

| `kind` | Catégorie générique | Claude Code | Codex (futur) | Cursor (futur) | opencode (futur) | Aider (futur) |
|---|---|---|---|---|---|---|
| `prompt` | Prompt single, avec `worker?` optionnel | Task tool, appel API direct, ou skill locale selon le consumer | TBD | TBD | TBD | TBD |
| `batch` | N prompts indépendants parallélisables, avec `worker?` optionnel | N Task tools, appels API parallèles, ou autre stratégie | TBD | TBD | TBD | TBD |

**Pourquoi ces deux shapes** : le runtime n'a besoin de connaître que la cardinalité et les chemins de résultats. Le choix "sub-agent, skill, appel API direct, outil local" appartient au consumer. Voir `docs/DELEGATION-SIMPLIFICATION.md` pour la décision qui remplace L2-6.
