# Consumer: Claude Code integration

Ce dossier contient la documentation de l'**intégration Claude Code** comme consommateur du runtime. L'intégration est un **produit distinct** du runtime lui-même (voir [`../README.md`](../README.md)).

## Ce que couvre cette intégration

- Meta-skill `cc-orch` — commandes opérationnelles (`bootstrap`, `list`, `resume`, `inspect`, `promote`, `prune`)
- Meta-skill `orchestrator-author` — génération d'orchestrateurs à partir de plans mode approuvés
- Binaire CLI `cc-orch` — point d'entrée utilisateur
- Hook `UserPromptSubmit` — détection optionnelle d'approbation plan mode
- Conventions filesystem : `~/.cc-orch/adhoc/<ulid>/`, `~/.claude/scripts/<name>/`
- Templates : `main.ts.hbs`, `skill.md.hbs`

Rien de ce qui est listé ci-dessus n'existe encore sous forme de code — cette intégration est à l'état de spec.

## Documents

- [`UX-VISION-AND-GAPS.md`](UX-VISION-AND-GAPS.md) — vision UX cible, gap analysis, roadmap priorisée, prérequis cognitifs

## Hors scope de ce dossier

Tout ce qui concerne le runtime lui-même (API `runOrchestrator`, `PhaseIO`, `PhaseResult`, protocole stdout, état durable, invariants I-1 à I-13) vit dans `specs/briefs/` et `docs/NX-TURNLOCK.md`. Ce dossier ne re-spécifie pas le runtime — il décrit comment l'intégration Claude Code s'y branche.
