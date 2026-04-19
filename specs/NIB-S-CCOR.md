---
id: NIB-S-CCOR
type: nib-system
version: "1.0.0"
scope: cc-orchestrator-runtime
status: approved
consumers: [claude-code]
superseded_by: []
---

# NIB-S-CCOR — System Brief

**Package** : `cc-orchestrator-runtime`
**Statut** : v1.0 — éclatement NIB actif, consommable par Claude Code
**Source NX** : `docs/NX-CC-ORCHESTRATOR-RUNTIME.md` v0.8 (2026-04-19)
**NIB-T associé** : `specs/NIB-T-CCOR.md` v1.0

---

## 0. Préambule

Ce document est le **System Brief** de `cc-orchestrator-runtime`. Il établit le frame dans lequel tous les NIB-M et le NIB-T opèrent. Il définit :

- L'objectif système et la frontière v1 (§1-§2)
- Les invariants globaux transversaux à tous les modules (§3)
- L'architecture en 4 couches et la liste exhaustive des modules (§4)
- Les cross-cutting policies (§5)
- Le contrat public stable (types exportés, factories, helpers) (§6)
- Les formes canoniques intermédiaires circulant entre layers (§7)
- La taxonomie fermée de 11 events observables (§8)
- Le modèle temporel à trois horloges distinctes (§9)
- L'orchestration de haut niveau (§10)

Il ne décrit **pas** les algorithmes internes des modules — ceux-là sont décrits dans les NIB-M dédiés.

---

## 1. Objectif système

### 1.1 Problème résolu

L'écosystème `~/.claude/skills/` de Fanilo contient plusieurs skills dont l'exécution est **orchestrale** : enchaînement de sous-étapes combinant travail mécanique (énumération, filtrage, consolidation JSON) et travail sémantique (review hostile, dedup, classification). Deux archétypes coexistent : LLM-orchestré (variance stochastique, drift) et script-bash-orchestré (déterministe mais douloureux dès que le volume de manipulation JSON dépasse ce qu'un `jq` lit confortablement).

Sans package mutualisé, chaque nouvel orchestrateur réimplémente ~500 lignes de plomberie (state durable, retry, timeout, émission protocole, validation schema, logs) avec des divergences subtiles qui produisent des bugs composés.

### 1.2 Réponse `cc-orchestrator-runtime`

Un package infrastructure TypeScript qui fournit un moteur d'exécution normalisée pour orchestrateurs structurés en phases, piloté par un protocole in-band sur stdout (`@@CC_ORCH@@`) consommable par un agent Claude Code parent.

Chaque run traverse un moteur déterministe où les décisions mécaniques (retry, timeout, classification d'erreurs) sont matérialisées en objets explicites — pas une séquence impérative qui cache ses branches.

### 1.3 Positionnement dans l'écosystème

- Package **infrastructure transversale** pour le tooling personnel Claude Code de Fanilo. Consommé par les orchestrateurs qui vivent dans `~/.claude/scripts/<name>/` et qui sont déclenchés par un skill dans `~/.claude/skills/<name>/`.
- **Strictement Claude-Code-dépendant** : la primitive de délégation (émission de signal + exit + re-entry après invocation Skill/Agent par l'agent parent) n'a de sens qu'à l'intérieur d'une session Claude Code.
- Distinct de `@vegacorp/llm-runtime` : runtime provider-agnostique pour appels LLM directs HTTP. Les deux runtimes peuvent coexister ; un orchestrateur `cc-orchestrator-runtime` peut, en théorie, utiliser `llm-runtime` pour un call LLM direct dans une phase — cas non ciblé v1 mais pas interdit.
- Distinct de Temporal / Inngest / Trigger.dev : reprend les concepts (state durable, retry policies, materialized decisions) mais pas la forme (pas de serveur, pas de coordination distribuée, pas de déterminisme de workflow imposé).

### 1.4 Divergence architecturale : snapshot-authoritative, pas event-sourced

Décision structurante : `state.json` est la **source de vérité autoritative unique**. Écrasé à chaque transition, toujours cohérent avec le dernier commit applicatif des phases. `events.ndjson` est un **audit trail du flux** (append-only, mirror de stderr), jamais la source reconstructible de `state.data`.

Temporal impose le pur event sourcing (`state = f(events)`) en contraignant les workflows à émettre des commandes déterministes. `cc-orchestrator-runtime` refuse cette contrainte : les phases sont du TS arbitraire qui retourne `nextState` via calcul libre. Le pur event sourcing Temporal n'est donc pas applicable — sans déterminisme des phases, le replay d'events ne peut reproduire un state.

Conséquence : pas de "guerre snapshot vs events rejoués". `state.json` gagne toujours. `events.ndjson` sert au debug forensique, à la corrélation cross-run via `runId`, et à la reconstruction du **flux** (phases traversées, délégations émises, retries, erreurs) — jamais de `state.data`.

---

## 2. Frontière v1

### 2.1 Dans le scope (ce que le package fait)

- Exécution d'un orchestrateur structuré en **phases** nommées avec transitions explicites
- Persistence **atomique** (tmp + rename) de `state.json` à chaque transition stable
- Chargement du state au démarrage pour reprise à la phase courante
- **Délégation** vers un skill (`delegateSkill`), un sub-agent (`delegateAgent`), ou un batch parallèle de sub-agents (`delegateAgentBatch`)
- Émission d'un **protocole de signal** standardisé sur stdout (bloc `@@CC_ORCH@@ ... @@END@@`)
- **Validation lazy avec enforcement exact-once** des résultats via `io.consumePendingResult(schema)` / `io.consumePendingBatchResults(schema)` côté phase de reprise
- **Retry** automatique avec backoff exponentiel sur résultat invalide, timeout de délégation, ou JSON malformé
- **Timeout** par délégation (durée max entre émission signal et disponibilité résultat), mesuré en wall-clock epoch ms
- **Classification** des erreurs (transient retriable / permanent fatal / abort)
- **Observabilité** structurée via events NDJSON sur stderr, corrélés par `runId`
- **Event log append-only persistant** (`$RUN_DIR/events.ndjson`) — audit trail du **flux** du run (phases, délégations, retries, erreurs)
- **Lock file** par run (`$RUN_DIR/.lock`) — enforcement mécanique de "un seul process actif par `runId`" via `O_EXCL` + lease idle 30 min pour crash recovery
- **Cleanup** automatique des anciennes runs (rétention configurable)
- **Abort** propagé (SIGINT/SIGTERM → exit propre, state sauvé à la dernière transition stable, émission `ABORTED`)
- **Composition récursive** : un orchestrateur peut déléguer vers un skill qui lui-même est un orchestrateur (skill boundary)

### 2.2 Hors scope v1 (frontière dure)

| Zone | Statut v1 | Justification |
| --- | --- | --- |
| Exécution hors session Claude Code | Hors scope | Le runtime suppose un agent parent qui lit stdout et invoque `Skill`/`Agent` tools. Pas de mode headless. |
| Call LLM direct | Hors scope | Consommer `llm-runtime` à l'intérieur d'une phase si besoin. |
| Scheduling / cron | Hors scope | Le runtime est déclenché par une invocation externe. |
| IPC distribué | Hors scope | Strictement process-local et session-local. |
| Multi-process parallèle sur un même `runId` | Hors scope | Enforced via lock O_EXCL (§3, I-11). |
| Streaming de phase | Hors scope | Une phase retourne un résultat complet ou délègue. |
| Resume après SIGKILL | Hors scope | Le lock orphelin expire via lease idle (30 min), run reprenable manuellement. |
| Circuit breaker | Hors scope | Chaque run fait ses N retries indépendamment. |
| Visibility UI | Hors scope | Inspection via `events.ndjson` et fichiers disque. |
| Versioning de workflow | Hors scope | Orchestrateurs évoluent par rewrite, pas par migration en vol. |
| Compensation / saga pattern | Hors scope | Si phase a effets de bord irréversibles, l'auteur gère. |
| Replay determinism enforcement | Hors scope | Discipline de l'auteur, non vérifiée. |
| Event sourcing pur à la Temporal | Hors scope | Incompatible snapshot-authoritative (§1.4). |
| Signals applicatifs (inbox pattern) | Extension v2 scoped | Trigger d'activation v2 : premier orchestrateur qui a un cas concret d'injection runtime. |
| Continue-as-new | Extension v2 scoped | Trigger v2 : premier orchestrateur qui dépasse ~20 cycles. |
| Jitter sur backoff | Hors scope | Backoff déterministe pur v1. |
| Phases parallèles inter-phases | Hors scope | Une seule délégation active à la fois ; batch parallèle OK dans une délégation. |

Toute future demande d'ajout de feature listée ci-dessus doit : (1) ouvrir un NX séparé justifiant le besoin, (2) définir l'impact sur la surface publique (breaking ou non), (3) être validée avant implémentation.

---

## 3. Invariants globaux (transversaux)

Ces invariants s'appliquent à tous les modules. Les NIB-M n'ont pas à les répéter — ils y renvoient.

### I-1 — Séparation décision mécanique / sémantique

Le runtime n'incarne **jamais** de décision sémantique. Toute décision sémantique (quoi reviewer, comment classifier un finding) est déléguée à un skill/agent. Le runtime gère uniquement : flux, état, validation schema, résilience.

### I-2 — Re-entry comme primitive de délégation

Le runtime tourne dans un **process transitoire**. Une invocation = un run partiel jusqu'à une demande de délégation ou terminaison. Le process exit dès `@@CC_ORCH@@` émis. L'agent parent relance après chaque délégation terminée. Conséquence normative : tout state orchestrateur est **JSON-sérialisable**. Pas de closures, pas de `Map`/`Set` non-sérialisés, pas de handles.

### I-3 — Atomicité de l'écriture d'état

Toute écriture de fichier d'état (`state.json`, manifests, résultats, lock updates) passe par `write("X.tmp", content); rename("X.tmp", "X")`. `rename` est atomique sur un même filesystem POSIX. Un lecteur concurrent observe toujours soit l'ancien soit le nouveau, jamais partiel.

### I-4 — Fail-closed universel

Toute erreur → exit code ≠ 0 + émission `@@CC_ORCH@@ action: ERROR`. Le runtime ne retourne jamais de résultat dégradé. Les **préflight errors** (config invalide, state manquant/corrompu au resume, mismatch runId/orchestratorName) émettent également un bloc ERROR, avec `run_id: null` si le runId n'a pas encore été généré/adopté. **Aucun throw brut** ne remonte depuis `runOrchestrator()` — tout throw interne est capté par le top-level `try/catch` et converti en bloc ERROR + exit.

### I-5 — Déterminisme mécanique

`resolveRetryDecision`, `classify`, `parseProtocolBlock`, `writeProtocolBlock`, `validateResult`, `readState`, `generateRunId`, `resolveRunDir`, sanitization, signal composition sont des **fonctions pures** ou composants isolés. Étant données les mêmes entrées, mêmes sorties. Les effets de bord (fs, clock, logger) sont isolés dans des composants dédiés et mockables.

**Formulation canonique** : le runtime est une composition déterministe de décisions pures et d'effets isolés.

### I-6 — Observabilité obligatoire

Chaque run qui émet `orchestrator_start` émet `orchestrator_end`. Entre les deux : N × `phase_start`/`phase_end`, 0..N × `delegation_emit`/`delegation_result_read`/`delegation_validated`/`delegation_validation_failed`/`retry_scheduled`/`phase_error`/`lock_conflict`. Tous corrélables par `runId` à travers les multiples invocations du process.

**Préflight errors ne sont PAS un run** (bypass taxonomie events). Elles émettent uniquement le bloc protocole ERROR sur stdout.

### I-7 — Abort propagé

Tout `SIGINT`/`SIGTERM` reçu par le process interrompt la phase courante proprement : `io.signal` abort, sleeps de retry interrompus, flush logger, release lock, émission `@@CC_ORCH@@ action: ABORTED`, exit 130 (SIGINT) ou 143 (SIGTERM). `SIGKILL` non gérable — lock orphelin expire via lease idle.

### I-8 — Configuration figée au run-init

L'orchestrateur déclare ses `phases`, `initialState`, `resumeCommand`, policies au moment du `runOrchestrator(config)`. Une fois le run démarré, ces valeurs sont figées. Les phases peuvent override par délégation individuelle via `DelegationRequest.retry` / `.timeout`, pas globalement.

### I-9 — Surface publique petite et stable

Le contrat public (types, erreurs, policies, factories, constantes listées en §6) est minimal et versionné en SemVer strict. Pré-1.0, changements breaking autorisés mais taggés `[BREAKING]` dans le changelog. Post-1.0, toute modification breaking = major bump.

### I-10 — JSON-only state

Tout state persisté est du JSON. Pas de format binaire, pas de SQLite, pas de Protobuf. Conséquence : `Map`/`Set` natifs produisent `{}` à `JSON.stringify`, fonctions sont omises silencieusement, `Date` natif devient ISO string au reload. Discipline de l'auteur, non enforced mécaniquement.

### I-11 — Single process per run — enforced via lock

Un `runId` correspond à **un seul process actif à la fois**. Enforced mécaniquement via lock file `$RUN_DIR/.lock` créé en `O_EXCL`. Deux processes concurrents sur le même `runId` sont impossibles par design : le second throw `RunLockedError` ou override si le lease est expiré. Le lock représente "un process actuellement vivant dans ce run", **pas** une réservation longue-durée — il est release avant tout exit (DELEGATE, DONE, ERROR, ABORTED) et ré-acquis à la re-entry suivante.

### I-12 — Snapshot-authoritative, pas event-sourced

`state.json` source de vérité autoritative unique. `events.ndjson` audit trail du flux, jamais reconstructible de `state.data`. Invariant faible maintenu : "events suffisent à reconstruire le **flux** du run". Invariant fort **non maintenu** : "events suffisent à reconstruire l'état complet" — explicitement refusé par design (§1.4).

### I-13 — Pas de PII dans les logs

Les **prompts de délégation** et **contenus de résultats** ne sont jamais loggés. Seules métriques : tailles (`jobCount`, `fileSizeBytes`), identifiants (`runId`, `phase`, `label`), types (`eventType`, `kind`, `errorKind`), durées, booléens de validation.

**Exception contrôlée** : `phase_error.message` tronqué à 200 chars pour diagnostic. `delegation_validation_failed.zodErrorSummary` tronqué à 200 chars. Les implémenteurs de phases doivent respecter cette discipline dans les messages d'erreur.

### I-14 — Phase deep-freeze + single PhaseResult

Invariant **runtime production** (pas dev-only) : `state` passé à une phase est gelé en profondeur via `Object.freeze` récursif. Toute tentative de mutation déclenche un `TypeError` natif Node. Auteurs composent un nouveau state à retourner via `io.transition(...)`, jamais muter celui reçu.

Chaque phase ne peut retourner qu'**un seul** `PhaseResult`. Flag interne tracke la première émission (`io.transition/delegate*/done/fail`) ; un second appel throw `ProtocolError("PhaseResult already committed")` immédiatement.

### I-15 — Per-attempt result paths

Les chemins de résultat sont **versionnés par tentative** pour éviter qu'un sub-agent lent d'une tentative précédente ne pollue la tentative courante :

- `kind: "skill" | "agent"` : `$RUN_DIR/results/<label>-<attempt>.json`
- `kind: "agent-batch"` : `$RUN_DIR/results/<label>-<attempt>/<jobId>.json`

Les tentatives antérieures conservent leurs fichiers — le runtime ne les lit plus (il ne consulte que `state.pendingDelegation.attempt`). Race "sub-agent orphelin" résolue structurellement.

---

## 4. Architecture en 4 couches

### 4.1 Vue d'ensemble

```
┌─────────────────────────────────────────────────────────┐
│ Layer 1 — Public API                                    │
│ runOrchestrator, definePhase, Phase, PhaseIO,           │
│ PhaseResult, DelegationRequest variants,                │
│ OrchestratorConfig, Policies, Errors (11 classes),      │
│ Logger, Event union, constantes                         │
├─────────────────────────────────────────────────────────┤
│ Layer 2 — Execution Engine                              │
│ run-orchestrator.ts — entry point + mode dispatch       │
│ dispatch-loop.ts — boucle de dispatch des phases        │
│ handle-resume.ts — préflight resume + classification    │
├─────────────────────────────────────────────────────────┤
│ Layer 3 — Delegation Bindings                           │
│ bindings/skill.ts, agent.ts, agent-batch.ts             │
│   → buildManifest + buildProtocolBlock                  │
├─────────────────────────────────────────────────────────┤
│ Layer 4 — Transverse Services                           │
│ state-io, retry-resolver, error-classifier, validator,  │
│ protocol, logger, clock, run-id, run-dir,               │
│ abortable-sleep, lock                                   │
└─────────────────────────────────────────────────────────┘
```

### 4.2 Liste exhaustive des modules et leur NIB-M

| Couche | Module | NIB-M | Rôle |
| --- | --- | --- | --- |
| L4 | errors (abstract + 11 concrete) | NIB-M-ERRORS | Taxonomie d'erreurs + `OrchestratorErrorKind` |
| L4 | clock, run-id, abortable-sleep | NIB-M-INFRA-UTILS | Utilitaires triviaux groupés |
| L4 | run-dir | NIB-M-RUN-DIR | `resolveRunDir`, `cleanupOldRuns` |
| L4 | state-io | NIB-M-STATE-IO | `readState`, `writeStateAtomic` |
| L4 | protocol | NIB-M-PROTOCOL | `writeProtocolBlock`, `parseProtocolBlock` |
| L4 | validator | NIB-M-VALIDATOR | `validateResult`, `summarizeZodError` |
| L4 | retry-resolver | NIB-M-RETRY-RESOLVER | `resolveRetryDecision` (fonction pure) |
| L4 | error-classifier | NIB-M-ERROR-CLASSIFIER | `classify` transient/permanent/abort/unknown |
| L4 | logger | NIB-M-LOGGER | Stderr NDJSON + `events.ndjson` owner-only |
| L4 | lock | NIB-M-LOCK | Acquire O_EXCL, refresh, release avec ownerToken |
| L3 | 3 bindings (skill/agent/agent-batch) | NIB-M-BINDINGS | `buildManifest` + `buildProtocolBlock` |
| L2 | run-orchestrator (entry) | NIB-M-RUN-ORCHESTRATOR | Entry point + preflight + mode dispatch initial/resume |
| L2 | dispatch-loop | NIB-M-DISPATCH-LOOP | Boucle §14.1 step 16 + PhaseResult branches + catch retry |
| L2 | handle-resume | NIB-M-HANDLE-RESUME | Préflight resume + classification + retry pré-dispatch |
| L1 | Public API surface | NIB-M-PUBLIC-API | Exports + `definePhase` + constantes |

**14 NIB-M au total** + ce NIB-S.

### 4.3 Target file tree (convention, hors scope NIB)

```
src/
├── index.ts                          # exports publics (NIB-M-PUBLIC-API)
├── errors/
│   ├── base.ts                       # OrchestratorError abstract + OrchestratorErrorKind
│   └── concrete.ts                   # 11 sous-classes concrètes
├── services/
│   ├── clock.ts                      # nowWall/nowWallIso/nowEpochMs/nowMono
│   ├── run-id.ts                     # generateRunId
│   ├── abortable-sleep.ts            # abortableSleep
│   ├── run-dir.ts                    # resolveRunDir + cleanupOldRuns
│   ├── state-io.ts                   # readState + writeStateAtomic
│   ├── protocol.ts                   # writeProtocolBlock + parseProtocolBlock
│   ├── validator.ts                  # validateResult + summarizeZodError
│   ├── retry-resolver.ts             # resolveRetryDecision
│   ├── error-classifier.ts           # classify
│   ├── logger.ts                     # stderr + events.ndjson emitter
│   └── lock.ts                       # acquireLock / refreshLock / releaseLock
├── bindings/
│   ├── types.ts                      # DelegationBinding interface commune
│   ├── skill.ts                      # SkillBinding
│   ├── agent.ts                      # AgentBinding
│   └── agent-batch.ts                # AgentBatchBinding
└── engine/
    ├── run-orchestrator.ts           # runOrchestrator entry + mode dispatch
    ├── dispatch-loop.ts              # boucle + PhaseResult branches + catch retry
    └── handle-resume.ts              # préflight resume + classification
```

Cette structure est une **convention dérivée** du NIB-S + NIB-M. Elle est maintenue après construction (contrairement aux NIBs) : divergence immédiatement visible par comparaison avec l'arborescence réelle. Les tests correspondants suivent la structure miroir dans `tests/` (voir NIB-T §1.1).

### 4.4 Frontières de modules (types IN/OUT)

**Types publics** (exportés, Layer 1) — voir §6 pour la définition complète :

- `OrchestratorConfig<State>`, `Phase<State, Input, Output>`, `PhaseIO<State>`, `PhaseResult<State, Output>`
- `DelegationRequest` (union), `SkillDelegationRequest`, `AgentDelegationRequest`, `AgentBatchDelegationRequest`
- `RetryPolicy`, `TimeoutPolicy`, `LoggingPolicy`, `OrchestratorLogger`, `OrchestratorEvent` (union discriminée)
- `OrchestratorError` (abstract) + 11 sous-classes, `OrchestratorErrorKind`
- `PROTOCOL_VERSION: 1`, `STATE_SCHEMA_VERSION: 1`
- `runOrchestrator`, `definePhase`

**Types canoniques intermédiaires** (NON exportés, voir §7) :

- `StateFile<State>` + `PendingDelegationRecord` (§7.1)
- `DelegationManifest` (§7.2)
- `ProtocolBlock` (§7.4)
- `LockFile` (§7.5)
- `RetryDecision` (§8.2)

---

## 5. Cross-cutting policies

Les NIB-M renvoient à ces policies sans les redéfinir.

| Policy | Scope | NIB-M owner |
| --- | --- | --- |
| **P-ATOMIC-WRITE** : tmp + rename pour tout write persistant (state, manifest, output, lock, results produits par binding si applicable) | Tous | NIB-M-STATE-IO + NIB-M-LOCK (référencés par tous) |
| **P-JSON-SERIALIZABLE** : tout state et output sont JSON-sérialisables | Phases user + engine | NIB-M-STATE-IO (validation au write) |
| **P-FAIL-CLOSED** : toute erreur → bloc ERROR + exit ≠ 0, jamais de throw qui remonte | Engine + services | NIB-M-RUN-ORCHESTRATOR + NIB-M-DISPATCH-LOOP + NIB-M-HANDLE-RESUME |
| **P-NO-PII** : jamais de prompts/contenus dans logs, ≤ 200 chars pour message d'erreur | Logger + tous | NIB-M-LOGGER + tous émetteurs |
| **P-CLOCK-DISCIPLINE** : wall-clock ISO pour timestamps humains, wall-clock epoch ms pour cross-process, monotonic pour intra-process | Tous | NIB-M-INFRA-UTILS (clock) |
| **P-SEM-THROW** : toute erreur remontée du runtime est une `OrchestratorError` enrichie (runId, orchestratorName, phase) | Engine | NIB-M-DISPATCH-LOOP |
| **P-OWNER-ONLY-LOG** : `events.ndjson` écrit uniquement après acquire lock réussi | Logger + engine | NIB-M-LOGGER + NIB-M-RUN-ORCHESTRATOR |
| **P-DETERMINISTIC-DECISIONS** : retry, classify, protocol, validator sont des fonctions pures | Services L4 | NIB-M-RETRY-RESOLVER + NIB-M-ERROR-CLASSIFIER + NIB-M-PROTOCOL + NIB-M-VALIDATOR |
| **P-DEEP-FREEZE** : state passé aux phases est gelé en profondeur | Engine | NIB-M-DISPATCH-LOOP |
| **P-SINGLE-PHASE-RESULT** : flag `committed` empêche second `io.transition/delegate*/done/fail` | Engine | NIB-M-DISPATCH-LOOP |
| **P-PER-ATTEMPT-PATHS** : chemins de résultat versionnés par tentative | Engine + bindings | NIB-M-DISPATCH-LOOP + NIB-M-HANDLE-RESUME + NIB-M-BINDINGS |
| **P-LOCK-RELEASE-SYSTEMATIC** : `releaseLockIfOwner()` avant tout exit (DELEGATE/DONE/ERROR/ABORTED) | Engine | NIB-M-DISPATCH-LOOP + NIB-M-HANDLE-RESUME |

---

## 6. Contrat public (Layer 1) — surface stable

### 6.1 OrchestratorConfig

```ts
export interface OrchestratorConfig<State extends object = object> {
  /** Nom unique de l'orchestrateur. Utilisé pour RUN_DIR, logs, protocole. Kebab-case requis. */
  readonly name: string;

  /** Phase initiale, exécutée au premier démarrage. */
  readonly initial: string;

  /** Map des phases, keyed by phase name. Kebab-case requis sur les clés. */
  readonly phases: Readonly<Record<string, Phase<State, any, any>>>;

  /** État initial du run (required). Validé au démarrage si stateSchema fourni. Pas de fallback {}. */
  readonly initialState: State;

  /**
   * Builder de la commande de reprise (required).
   * Le runtime appelle resumeCommand(runId) à chaque délégation et place le résultat
   * dans le champ `resume_cmd` du bloc @@CC_ORCH@@ action: DELEGATE.
   * DOIT retourner une commande complète : interpréteur + main + --run-id <runId> --resume.
   * Exemple : (runId) => `bun run ~/.claude/scripts/senior-review/main.ts --run-id ${runId} --resume`
   */
  readonly resumeCommand: (runId: string) => string;

  /** Schéma zod du state. Validé au read/write. Défaut : opaque (pas de validation). */
  readonly stateSchema?: import("zod").ZodSchema<State>;

  /** Policies globales. Chaque phase peut override par délégation individuelle. */
  readonly retry?: RetryPolicy;
  readonly timeout?: TimeoutPolicy;
  readonly logging?: LoggingPolicy;

  /** Durée de rétention des runs antérieurs (jours). Défaut : 7. */
  readonly retentionDays?: number;
}
```

**Règles de validation** (préflight) :

- `name` : regex `/^[a-z][a-z0-9-]*$/`. Sinon `InvalidConfigError`.
- `initial` présent dans `phases`. Sinon `InvalidConfigError`.
- `phases` non-vide. `{}` → `InvalidConfigError`.
- Clés de `phases` suivent le même regex que `name`.
- `initialState` défini (pas `undefined`). Si `stateSchema` fourni, validé contre lui.
- `resumeCommand` est une fonction. Absent ou non-fonction → `InvalidConfigError`.

### 6.2 Phase

```ts
export type Phase<State, Input = void, Output = void> = (
  state: State,
  io: PhaseIO<State>,
  input?: Input
) => Promise<PhaseResult<State, Output>>;
```

**Règles** :

- La phase est **asynchrone**.
- Le `state` passé est **gelé en profondeur** (`Object.freeze` récursif). Mutation → `TypeError` natif.
- Chaque phase retourne **un seul** `PhaseResult`. Second appel `io.*` qui commit → `ProtocolError`.
- La phase ne doit pas écrire sur disque hors des API fournies par `io` (invariant documentaire).
- La phase peut faire des IO en lecture externes (repo, git, fs arbitraire).
- **`input` in-process only** : le second argument et `PhaseResult.transition.input` ne sont **pas persistés** dans `state.json`/`pendingDelegation`/manifest. Toute transition qui franchit une délégation reçoit `input: undefined` au resume. Pour données durables cross-délégation, utiliser `state.data`.
- **Phase max duration** : phase mécanique sans délégation ne devrait pas dépasser 30 min (`DEFAULT_IDLE_LEASE_MS`). Au-delà → splitter en sous-phases ou appeler `io.refreshLock()` périodiquement.

### 6.3 PhaseIO

```ts
export interface PhaseIO<State extends object> {
  /** Transition vers la phase suivante, même process. `input` in-process only (non-persisté). */
  transition<NextInput = void>(
    nextPhase: string,
    nextState: State,
    input?: NextInput
  ): PhaseResult<State>;

  /** Délégation à un skill. Le process exit après émission DELEGATE. */
  delegateSkill(req: SkillDelegationRequest, resumeAt: string, nextState: State): PhaseResult<State>;

  /** Délégation à un sub-agent unique. */
  delegateAgent(req: AgentDelegationRequest, resumeAt: string, nextState: State): PhaseResult<State>;

  /** Délégation à un batch parallèle de sub-agents du même type. */
  delegateAgentBatch(req: AgentBatchDelegationRequest, resumeAt: string, nextState: State): PhaseResult<State>;

  /** Terminaison réussie. Exit 0 après émission DONE. */
  done<FinalOutput>(output: FinalOutput): PhaseResult<State>;

  /** Terminaison en erreur. Exit 1 après émission ERROR. */
  fail(error: Error): PhaseResult<State>;

  /** Logger structuré, corrélé par runId. */
  readonly logger: OrchestratorLogger;

  /** Clock abstrait pour tests. */
  readonly clock: Clock;

  /** Run ID (ULID stable pour toute la durée du run). */
  readonly runId: string;

  /** Argv parsé (après retrait des flags internes --resume, --run-id). */
  readonly args: readonly string[];

  /** Chemin absolu du RUN_DIR. */
  readonly runDir: string;

  /** Signal d'abort OS-propagé (SIGINT/SIGTERM). */
  readonly signal: AbortSignal;

  /**
   * Consomme le résultat d'une délégation skill ou agent (non-batch).
   * Throw ProtocolError si pending.kind === "agent-batch".
   * Throw DelegationMissingResultError si fichier absent.
   * Throw DelegationSchemaError si fichier présent mais invalide (JSON malformé ou schéma violé).
   * Enforce exact-once : deux appels dans la même phase → ProtocolError immédiat.
   */
  consumePendingResult<T>(schema: import("zod").ZodSchema<T>): T;

  /**
   * Consomme les résultats d'une délégation agent-batch. Retourne readonly T[] aligné sur jobIds.
   * Throw ProtocolError si pending.kind !== "agent-batch".
   * Même sémantique d'erreur que consumePendingResult.
   */
  consumePendingBatchResults<T>(schema: import("zod").ZodSchema<T>): readonly T[];

  /**
   * Rafraîchit le lock file avec un nouveau leaseUntilEpochMs.
   * Utile pour phases mécaniques longues (> 30 min).
   * Coût : une écriture disque tmp+rename.
   */
  refreshLock(): void;
}

export interface Clock {
  nowWall(): Date;
  nowWallIso(): string;
  nowEpochMs(): number;
  nowMono(): number;
}
```

**Règle critique — consumption exact-once** :

- Durant une phase de reprise (invocation via `--resume`), la phase doit appeler **exactement un** des deux (`consumePendingResult` OU `consumePendingBatchResults`).
- Zéro appel → `ProtocolError` post-phase (check en §14.1 step 16.l du NX).
- Deux appels dans la même phase → `ProtocolError` immédiat au second appel.
- Wrong-kind (consumePendingResult sur batch ou inverse) → `ProtocolError` immédiat à l'appel.

### 6.4 PhaseResult

```ts
export type PhaseResult<State, Output = void> =
  | { readonly kind: "transition"; readonly nextPhase: string; readonly nextState: State; readonly input?: unknown }
  | { readonly kind: "delegate"; readonly request: DelegationRequest; readonly resumeAt: string; readonly nextState: State }
  | { readonly kind: "done"; readonly output: Output }
  | { readonly kind: "fail"; readonly error: Error };
```

**Mapping canonique `PhaseResult.kind ↔ action protocole`** (référence unique) :

| `PhaseResult.kind` (TS interne) | Protocole stdout | Exit code |
|---|---|---|
| `"transition"` | aucun (continue boucle in-process) | — |
| `"delegate"` | `@@CC_ORCH@@ action: DELEGATE` | 0 |
| `"done"` | `@@CC_ORCH@@ action: DONE` | 0 |
| `"fail"` | `@@CC_ORCH@@ action: ERROR` | 1 |
| (exception utilisateur non catchée) | `@@CC_ORCH@@ action: ERROR` | 1 |
| (signal SIGINT / SIGTERM) | `@@CC_ORCH@@ action: ABORTED` | 130 / 143 |

Aucun autre verbe n'est utilisé dans la suite du corpus. `fail` désigne le résultat TS, `ERROR` désigne l'action protocole. Deux concepts, un mapping.

**Règles** :

- `transition.nextPhase` doit exister dans `config.phases`. Sinon `ProtocolError` interne.
- `delegate.resumeAt` doit exister dans `config.phases`. Sinon `ProtocolError` interne.
- `delegate.nextState` est le state à persister **avant** d'exit.
- `done.output` est sérialisé en JSON dans `$RUN_DIR/output.json`. Doit être JSON-sérialisable.

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
  readonly retry?: RetryPolicy;        // override policy globale (partiel OK, champ par champ)
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

**Règles** :

- `label` unique au sein d'un run. Enforced via `state.usedLabels` (cf §7.1). Collision → `ProtocolError("duplicate label: " + label)`.
- `label` : `/^[a-z][a-z0-9-]*$/`.
- `skill` et `agentType` : strings arbitraires (le runtime ne valide pas leur existence — le parent agent invoquera ou échouera).
- `AgentBatchDelegationRequest.jobs.length >= 1`. Batch vide → `InvalidConfigError` au binding et à l'engine (défense en profondeur).
- `jobs[].id` unique au sein du batch. Duplication → `ProtocolError("duplicate job id in batch: " + id)` au niveau engine.

### 6.6 Errors — taxonomie fermée

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

Liste canonique des 11 classes :

| Classe | `kind` | Situation | Retriable ? |
| --- | --- | --- | --- |
| `InvalidConfigError` | `"invalid_config"` | Config invalide au preflight | Non |
| `StateCorruptedError` | `"state_corrupted"` | `state.json` non parseable, schéma violé | Non |
| `StateMissingError` | `"state_missing"` | `--resume` mais pas de `state.json` | Non |
| `StateVersionMismatchError` | `"state_version_mismatch"` | `state.json` d'une version incompatible | Non |
| `DelegationTimeoutError` | `"delegation_timeout"` | Résultat absent, deadline dépassée | Oui |
| `DelegationSchemaError` | `"delegation_schema"` | Résultat présent mais invalide (JSON malformé ou schéma violé) | Oui |
| `DelegationMissingResultError` | `"delegation_missing_result"` | `consumePending*` appelé mais fichier absent alors que deadline pas dépassée (bug parent agent) | Non |
| `PhaseError` | `"phase_error"` | Exception jetée par une phase utilisateur (ou wrap défaut) | Non (v1) |
| `ProtocolError` | `"protocol"` | Violation du protocole (nextPhase invalide, label dupliqué, wrong consume kind, double PhaseResult, etc.) | Non |
| `AbortedError` | `"aborted"` | Signal SIGINT/SIGTERM reçu | Non (voulu) |
| `RunLockedError` | `"run_locked"` | Au démarrage, `.lock` actif détenu par un autre process. Propriétés publiques : `ownerPid`, `acquiredAtEpochMs`, `leaseUntilEpochMs`. | Non (exit 2) |

Voir `NIB-M-ERRORS` pour les constructeurs, enrichissement, héritage détaillé.

### 6.7 Logger + Events — taxonomie fermée (11 types)

```ts
export interface OrchestratorLogger {
  emit(event: OrchestratorEvent): void;
}

interface BaseEvent {
  readonly eventType: string;
  readonly runId: string;
  readonly timestamp: string;          // ISO 8601 UTC
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

**Discipline `orchestrator_end`** : résumé terminal canonique. Champs figés. Aucun champ de détail intermédiaire ne migre vers `orchestrator_end`. L'agrégation est la responsabilité du consommateur via `runId`.

**L'ajout d'un event = breaking change** (major bump). Toute évolution v1 de l'observabilité passe par ajout d'un `eventType` discriminé nouveau dans l'union — donc breaking.

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
  readonly logger?: OrchestratorLogger;   // défaut : stderr NDJSON
  readonly enabled: boolean;              // défaut true
  readonly persistEventLog?: boolean;     // défaut true — double-write à $RUN_DIR/events.ndjson
}
```

**Sémantique** :

- `RetryPolicy.maxAttempts` : nombre total de tentatives, **attempt initial inclus**. Condition de retry : `attempt + 1 < maxAttempts` (attempt 0-indexé dans la boucle). Avec `maxAttempts = 3`, le runtime exécute au plus 3 délégations : 1 initiale + 2 retries.
- `backoff(attempt, policy) = min(policy.backoffBaseMs * 2^attempt, policy.maxBackoffMs)`. Pas de jitter v1.
- `TimeoutPolicy.perDelegationMs` : mesuré en wall-clock epoch ms via `deadlineAtEpochMs = emittedAtEpochMs + timeoutMs`. **Per-attempt** : chaque retry recalcule son propre deadline.
- `LoggingPolicy.enabled === false` coupe toute émission (stderr + events.ndjson).
- `LoggingPolicy.persistEventLog === false` coupe uniquement `events.ndjson`.
- `LoggingPolicy.logger` custom remplace l'émission stderr. `events.ndjson` owner-only reste écrit sauf `persistEventLog: false` ou `enabled: false`.

**Résolution RetryPolicy effective (v0.8 M26)** — `effectiveRetryPolicy` capturée à l'émission initiale, champ par champ :

```ts
effectiveRetryPolicy = {
  maxAttempts: request.retry?.maxAttempts ?? config.retry?.maxAttempts ?? 3,
  backoffBaseMs: request.retry?.backoffBaseMs ?? config.retry?.backoffBaseMs ?? 1000,
  maxBackoffMs: request.retry?.maxBackoffMs ?? config.retry?.maxBackoffMs ?? 30000,
}
```

Persisté dans `state.pendingDelegation.effectiveRetryPolicy`. Réutilisé à chaque retry (catch §14.1 step 16.i, resume §14.2 step 12.e). Plus de perte d'override cross-process.

### 6.9 Fonctions + constantes exportées

```ts
export declare function runOrchestrator<State extends object>(
  config: OrchestratorConfig<State>
): Promise<void>;

export declare function definePhase<State, Input = void, Output = void>(
  fn: Phase<State, Input, Output>
): Phase<State, Input, Output>;  // pass-through runtime, utile pour inférence TS

export const PROTOCOL_VERSION = 1 as const;
export const STATE_SCHEMA_VERSION = 1 as const;
```

---

## 7. Formes canoniques intermédiaires

Ces formes vivent entre les re-entries et entre les layers. Non exportées publiquement mais **normatives** — tout orchestrateur et agent parent doit les respecter.

### 7.1 `state.json` — forme canonique unique

**Seule** source de vérité pour le format de `state.json`. Les §10 et les NIB-M y renvoient sans redéfinir.

```ts
interface StateFile<State> {
  readonly schemaVersion: 1;
  readonly runId: string;                      // ULID
  readonly orchestratorName: string;

  // Temporal — wall clock uniquement (cross-process safe).
  // Aucun champ monotonic ici.
  readonly startedAt: string;                  // ISO 8601
  readonly startedAtEpochMs: number;
  readonly lastTransitionAt: string;           // ISO 8601
  readonly lastTransitionAtEpochMs: number;

  // Flow state.
  readonly currentPhase: string;
  readonly phasesExecuted: number;
  readonly accumulatedDurationMs: number;      // somme des durées intra-process de phases traversées

  // User data — typée par l'orchestrateur, opaque au runtime sauf stateSchema fourni.
  readonly data: State;

  // Délégation en cours (undefined hors période de délégation active).
  readonly pendingDelegation?: PendingDelegationRecord;

  // Registre des labels utilisés dans ce run, append-only.
  // Chaque émission de délégation append son label. Jamais retiré.
  readonly usedLabels: readonly string[];
}

interface PendingDelegationRecord {
  readonly label: string;
  readonly kind: "skill" | "agent" | "agent-batch";
  readonly resumeAt: string;
  readonly manifestPath: string;               // chemin absolu du manifest JSON

  // Deadline — wall clock epoch ms uniquement.
  readonly emittedAtEpochMs: number;
  readonly deadlineAtEpochMs: number;          // = emittedAtEpochMs + timeoutMs effectif de la tentative

  // Retry state.
  readonly attempt: number;                    // 0-indexé, capturé à l'émission
  readonly effectiveRetryPolicy: {             // capturée à l'émission initiale (M26)
    readonly maxAttempts: number;
    readonly backoffBaseMs: number;
    readonly maxBackoffMs: number;
  };

  // Batch uniquement.
  readonly jobIds?: readonly string[];
}
```

**Règles normatives** :

- Écrit atomiquement (tmp + rename) à chaque transition et à chaque émission de délégation.
- Lu au démarrage de toute invocation sauf au tout premier run (pas de `state.json` → initial via `config.initialState`).
- `schemaVersion === 1` obligatoire. Autre valeur → `StateVersionMismatchError`.
- `data` opaque au runtime sauf si `config.stateSchema` fourni (validé à chaque read/write).
- `accumulatedDurationMs` incrémenté uniquement à la fin de chaque phase terminée (transition/delegate/done/fail) par la durée monotonic de cette phase. Jamais de double-comptage.
- `pendingDelegation` effacé (set à `undefined`) **au traitement du PhaseResult** de la phase de reprise (§14.1 step 16.n), **pas au début** de la phase de reprise. Garantie cross-crash : un crash mid-phase préserve le pending pour retry correct.
- `usedLabels` : append-only. Jamais retiré même après consommation.
- **Pas de champ monotonic dans le state**. Tout timing cross-process utilise wall clock epoch ms.

### 7.2 Manifest de délégation

Écrit par le binding dans `$RUN_DIR/delegations/<label>-<attempt>.json`.

```ts
interface DelegationManifest {
  readonly manifestVersion: 1;
  readonly runId: string;
  readonly orchestratorName: string;
  readonly phase: string;                      // phase qui a émis la délégation
  readonly resumeAt: string;
  readonly label: string;
  readonly kind: "skill" | "agent" | "agent-batch";

  // Temporal — wall clock uniquement.
  readonly emittedAt: string;                  // ISO 8601
  readonly emittedAtEpochMs: number;
  readonly timeoutMs: number;                  // timeoutPolicy.perDelegationMs effectif
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
    readonly resultPath: string;               // per-jobId per-attempt
  }>;

  // Pour skill et agent (non-batch), resultPath top-level.
  readonly resultPath?: string;
}
```

**Règles** :

- `kind: "agent-batch"` ⇔ `jobs` présent, `resultPath` top-level absent.
- `kind: "skill" | "agent"` ⇔ `resultPath` top-level présent, `jobs` absent.
- **Résultats per-attempt** (I-15) :
  - `kind: "skill" | "agent"` : `$RUN_DIR/results/<label>-<attempt>.json`
  - `kind: "agent-batch"` : `$RUN_DIR/results/<label>-<attempt>/<jobId>.json`
- Les tentatives antérieures conservent leurs fichiers. Le runtime ne lit que `attempt` courant via `state.pendingDelegation.attempt`. Nettoyage via rétention RUN_DIR standard.

### 7.3 Fichier de résultat

Écrit par le skill ou le sub-agent au chemin `resultPath` du manifest. Format : JSON arbitraire.

- Le runtime **ne valide** le résultat que contre le schéma zod fourni à `consumePending*(schema)`.
- Aucun champ obligatoire imposé par le runtime.
- Fichier absent → `DelegationMissingResultError` (si deadline pas dépassée) ou `DelegationTimeoutError` (si dépassée).
- Fichier présent mais JSON unparseable → `DelegationSchemaError`. Logger uniquement `path` + `fileSizeBytes`, **jamais** d'extrait de contenu ni de message `JSON.parse`.
- Pour `agent-batch` : chaque fichier doit être présent et valide. Un seul manquant → même classification que single delegation ; un seul malformed → `DelegationSchemaError` global.

### 7.4 Protocole `@@CC_ORCH@@`

Émis sur stdout par le runtime pour communiquer avec l'agent parent.

**Forme générique** :

```
@@CC_ORCH@@
version: 1
run_id: <ulid> | null
orchestrator: <name>
action: <ACTION>
<fields spécifiques>
@@END@@
```

**Règles normatives** :

- Le bloc commence par `@@CC_ORCH@@` sur une ligne seule.
- Le bloc finit par `@@END@@` sur une ligne seule.
- Entre les deux : lignes `key: value` (YAML-subset simplifié), une par ligne.
- Valeurs autorisées : **strings**, **nombres** (entiers ou décimaux), **booléens** (`true`/`false`), ou `null`. Pas de structure inline.
- Strings avec caractères spéciaux (`:`, `\n`, `"`) : quoted `"..."` avec échappement JSON standard. Sinon quotes optionnelles.
- Chaque bloc est précédé et suivi d'une ligne vide.
- **Un seul bloc par invocation du process**. Un run complet émet typiquement N × `DELEGATE` + 1 × `{DONE, ERROR, ABORTED}`.

**Actions** : `DELEGATE`, `DONE`, `ERROR`, `ABORTED`. Voir `NIB-M-PROTOCOL` pour les champs spécifiques détaillés et exemples.

**Préflight errors** : `run_id: null` si le runId n'a pas encore été généré/adopté. `orchestrator: <config.name>` toujours présent (parsé en premier avant validation).

### 7.5 `events.ndjson` + `.lock`

**`events.ndjson`** — audit trail append-only dans `$RUN_DIR/events.ndjson`.

- Format : NDJSON (newline-delimited JSON), UTF-8, fin de ligne LF. Une ligne = un `OrchestratorEvent` complet sérialisé par `JSON.stringify` sans espaces inutiles.
- Append-only. Aucune ligne n'est jamais modifiée ou supprimée.
- **Owner-only** (I-11 conséquence) : écrit **uniquement** par le process qui possède le lock. Un contender bloqué sur `RunLockedError` (avant acquire) n'écrit pas.
- Écriture synchrone via `fs.appendFileSync` pour garantir que l'event est sur disque avant continuation. Accepté car events rares (~5-30 par run typique, ~100 max).
- Créé au premier event émis par l'owner (typiquement `orchestrator_start` immédiatement après acquire lock).
- Pas de rotation. Un run = un fichier append sur toutes les invocations du même owner. Cleanup via rétention RUN_DIR.

**`.lock`** — forme canonique du lock file dans `$RUN_DIR/.lock`.

```ts
interface LockFile {
  readonly ownerPid: number;           // pour debug humain (ps -p)
  readonly ownerToken: string;         // ULID random, source de vérité pour release
  readonly acquiredAtEpochMs: number;
  readonly leaseUntilEpochMs: number;  // absolu, wall-clock epoch
}
```

Voir `NIB-M-LOCK` pour la sémantique complète (acquire O_EXCL, override expiré, release avec vérification ownerToken, lease idle simple 30 min).

### 7.6 DelegationBinding (interface interne)

```ts
interface DelegationBinding<Req extends DelegationRequest> {
  readonly kind: "skill" | "agent" | "agent-batch";
  buildManifest(request: Req, context: DelegationContext): DelegationManifest;
  buildProtocolBlock(manifest: DelegationManifest, resumeCmd: string): string;
}

interface DelegationContext {
  readonly runId: string;
  readonly orchestratorName: string;
  readonly phase: string;
  readonly resumeAt: string;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly emittedAt: string;           // ISO
  readonly emittedAtEpochMs: number;
  readonly timeoutMs: number;
  readonly deadlineAtEpochMs: number;
  readonly runDir: string;
}
```

**Règle normative v0.6 C9** : le binding **ne lit pas** les fichiers résultats. Lecture exclusivement côté engine au resume (§14.2 step 12). Le binding s'occupe uniquement de write-side : `buildManifest` + `buildProtocolBlock`.

### 7.7 RetryDecision (décision matérialisée)

```ts
interface RetryDecision {
  readonly retry: boolean;
  readonly delayMs?: number;            // présent ssi retry === true
  readonly reason: string;
}
```

Voir `NIB-M-RETRY-RESOLVER` pour la table de décision complète (§8.2).

---

## 8. Taxonomie d'erreurs et décisions de retry

### 8.1 Classification transient / permanent / abort / unknown

| `kind` | Classification |
|---|---|
| `"invalid_config"` | `"permanent"` |
| `"state_corrupted"` | `"permanent"` |
| `"state_missing"` | `"permanent"` |
| `"state_version_mismatch"` | `"permanent"` |
| `"delegation_timeout"` | `"transient"` |
| `"delegation_schema"` | `"transient"` |
| `"delegation_missing_result"` | `"permanent"` (bug parent agent) |
| `"phase_error"` | `"permanent"` sauf `cause instanceof AbortedError` → `"abort"` |
| `"protocol"` | `"permanent"` |
| `"aborted"` | `"abort"` |
| `"run_locked"` | `"permanent"` |
| Erreur non-`OrchestratorError` | `"unknown"` |

Voir `NIB-M-ERROR-CLASSIFIER` pour la fonction `classify`.

### 8.2 Table de décision retry

Condition de retry : `attempt + 1 < maxAttempts` (attempt 0-indexé dans la boucle).

| Erreur | Budget restant | Décision |
|---|---|---|
| `DelegationTimeoutError` | oui | `{ retry: true, delayMs: backoff, reason: "transient_timeout" }` |
| `DelegationSchemaError` | oui | `{ retry: true, delayMs: backoff, reason: "transient_schema" }` |
| Tout retriable | non (épuisé) | `{ retry: false, reason: "retry_exhausted" }` |
| `InvalidConfigError` | n/a | `{ retry: false, reason: "fatal_invalid_config" }` |
| `StateCorruptedError` | n/a | `{ retry: false, reason: "fatal_state_corrupted" }` |
| `StateMissingError` | n/a | `{ retry: false, reason: "fatal_state_missing" }` |
| `StateVersionMismatchError` | n/a | `{ retry: false, reason: "fatal_state_version_mismatch" }` |
| `DelegationMissingResultError` | n/a | `{ retry: false, reason: "fatal_delegation_missing_result" }` |
| `PhaseError` | n/a | `{ retry: false, reason: "fatal_phase_error" }` |
| `ProtocolError` | n/a | `{ retry: false, reason: "fatal_protocol" }` |
| `AbortedError` | n/a | `{ retry: false, reason: "fatal_aborted" }` |
| `RunLockedError` | n/a | `{ retry: false, reason: "fatal_run_locked" }` |
| Erreur non-`OrchestratorError` | n/a | `{ retry: false, reason: "fatal_unknown" }` |

`backoff(attempt, policy) = min(policy.backoffBaseMs * 2^attempt, policy.maxBackoffMs)`.

Voir `NIB-M-RETRY-RESOLVER` pour la fonction `resolveRetryDecision` pure.

### 8.3 Règle phase errors

Si une phase utilisateur throw, le runtime :

1. Catch l'exception (catch ciblé §14.1 step 16.i, pas de try/catch global autour de la boucle)
2. Émet `phase_error` event (errorKind, message tronqué 200 chars)
3. Wrap dans `PhaseError(cause)` et termine le run avec action `ERROR`
4. **Ne retry pas** la phase automatiquement en v1

Rationale : une phase utilisateur qui throw signifie probablement un bug, pas une condition transient. Retry risque de masquer le bug. L'utilisateur relance manuellement si besoin (state préservé à la dernière transition stable).

---

## 9. Modèle temporel — trois horloges distinctes

### 9.1 Trois horloges

**Horloge murale ISO** (`new Date().toISOString()`) — timestamps humains :
- `StateFile.startedAt`, `StateFile.lastTransitionAt`
- `DelegationManifest.emittedAt`
- Tous les `timestamp` des events NDJSON

**Horloge murale epoch ms** (`Date.now()`) — math cross-process :
- `StateFile.startedAtEpochMs`, `lastTransitionAtEpochMs`
- `DelegationManifest.emittedAtEpochMs`, `deadlineAtEpochMs`
- `PendingDelegationRecord.emittedAtEpochMs`, `deadlineAtEpochMs`
- `LockFile.acquiredAtEpochMs`, `leaseUntilEpochMs`
- **Toute arithmétique qui doit survivre à un exit/re-entry**.

**Horloge monotone** (`performance.now()`) — durées intra-process :
- `phase_end.durationMs`
- `accumulatedDurationMs` (accumulé dans le state par addition de durées intra-process)
- Sleep de retry via `abortableSleep` ou `AbortSignal.timeout`
- Timeouts intra-phase côté utilisateur
- **Jamais utilisée cross-process** — `performance.now()` est relatif au démarrage du process courant.

### 9.2 Règles normatives

- `durationMs` intra-phase **toujours ≥ 0** (garanti par monotonic).
- **Règle cross-process — wall clock uniquement** : le runtime n'essaie **jamais** de reconstituer une horloge monotone cross-process.
- **Règle intra-process — monotonic** : immunité aux clock jumps système (NTP, DST).
- **Accumulation cumulative** : `state.accumulatedDurationMs` incrémenté à la fin de chaque phase par sa durée monotonic. Stable cross-process car somme de deltas intra-process immuns aux jumps.

### 9.3 Deadline per-attempt (pas global)

Chaque nouvelle tentative après timeout recalcule son propre `deadlineAtEpochMs = emittedAtEpochMs_de_cette_tentative + timeoutMs`. Le deadline n'est pas un budget global initial partagé entre tentatives. Invariant : `newDeadlineAtEpochMs === newEmittedAtEpochMs + oldManifest.timeoutMs`.

---

## 10. Orchestration de haut niveau

### 10.1 Flux initial (§14.1 du NX, synthèse)

```
runOrchestrator(config) [mode initial, pas de --resume]
  1. Valider config → preflight ERROR si invalide (run_id: null)
  2. Parse argv (--resume absent, --run-id optionnel)
  3. Générer/adopter runId (ULID)
  4. Résoudre RUN_DIR = <cwd>/.claude/run/cc-orch/<config.name>/<runId>/
  5. Créer RUN_DIR + sous-dossiers (delegations/, results/)
  6. Installer stderr logger uniquement (pas encore events.ndjson)
  7. Acquire lock (O_EXCL) :
     - Si RunLockedError → emit ERROR + exit(2)
     - Si expired → override + emit lock_conflict
     - Activer events.ndjson logger après acquire réussi (owner-only)
  8. Capturer nowEpoch / nowIso
  9. Log orchestrator_start
  10. Construire StateFile initial (data: config.initialState, pendingDelegation: undefined, usedLabels: [])
  11. Valider initialState si stateSchema fourni
  12. Persister state.json initial (atomic)
  13. Installer handlers SIGINT/SIGTERM
  14. Cleanup runs anciennes (retentionDays)
  15. Entrée boucle de dispatch [voir §10.3]

Détaillé dans NIB-M-RUN-ORCHESTRATOR.
```

### 10.2 Flux resume (§14.2 du NX, synthèse)

```
runOrchestrator(config) [--resume + --run-id]
  1. Valider config → preflight ERROR si invalide
  2. Parse argv — --run-id obligatoire
  3. Adopter runId depuis argv
  4. Résoudre RUN_DIR
  5. Vérifier RUN_DIR existe → state_missing sinon
  6. Lire + valider state.json (schemaVersion, stateSchema)
  7. Vérifier state.runId === runId && state.orchestratorName === config.name → protocol ERROR sinon
  8. Installer stderr logger
  9. Installer handlers SIGINT/SIGTERM
  10. Acquire lock + activer events.ndjson logger (owner-only)
  11. Identifier pd = state.pendingDelegation (sinon ProtocolError)
  12. Vérifier deadline + présence + parseabilité résultats (missing/malformed/parseable) :
      - allParseable → continuer step 13
      - anyMalformed → DelegationSchemaError → retry ou fatal
      - !allPresent && deadlinePassed → DelegationTimeoutError → retry ou fatal
      - !allPresent && !deadlinePassed → DelegationMissingResultError (fatal, bug parent)
  13. Log delegation_result_read (jobCount, filesLoaded)
  14. Transition en mémoire : state.currentPhase = pd.resumeAt (pendingDelegation reste en place)
  15. Entrée boucle de dispatch avec loadedResults en RAM pour consumePending*

Détaillé dans NIB-M-HANDLE-RESUME.
```

### 10.3 Boucle de dispatch (§14.1 step 16, cœur engine)

```
while (true) {
  a. currentPhase = state.currentPhase (source unique, relue à chaque itération)
  b. Refresh lock (leaseUntilEpochMs = nowEpoch + DEFAULT_IDLE_LEASE_MS)
  c. consumedCount = 0 (per-phase)
  d. committed = false (per-phase, single PhaseResult flag)
  e. frozenState = deepFreeze(structuredClone(state.data))
  f. io = PhaseIO avec transition/delegate*/done/fail qui check committed, consumePending*, refreshLock
  g. Log phase_start
  h. phaseStartMono
  i. Try await phaseFn(frozenState, io, input)
     Catch → si DelegationSchemaError + budget → reconstruction manifest + retry branche
             sinon → phase_error + orchestrator_end + ERROR + release lock + exit(1)
  j. phaseDurationMs via monotonic
  k. accumulatedDurationMs += phaseDurationMs
  l. Consumption check (uniquement si pending à l'entrée) : consumedCount === 1 sinon protocol ERROR
  m. Log phase_end (resultKind)
  n. Switch result.kind :
     - "transition" : update state, continue boucle
     - "delegate" : manifest + pendingDelegation + usedLabels + persist state
                    + log delegation_emit + emit @@CC_ORCH@@ DELEGATE + release lock + exit(0)
     - "done" : write output.json + persist state + log orchestrator_end
                + emit @@CC_ORCH@@ DONE + release lock + exit(0)
     - "fail" : persist state + log phase_error + orchestrator_end
                + emit @@CC_ORCH@@ ERROR + release lock + exit(1)
}

Détaillé dans NIB-M-DISPATCH-LOOP.
```

### 10.4 Dépendances externes v1

| Package | Version | Rôle | DC associé |
| --- | --- | --- | --- |
| `zod` | `^3.x` | Schema validation pour résultats de délégations | Pas de DC (usage trivial couvert intégralement par NIB-M-VALIDATOR) |
| `ulid` | `^2.x` | Génération `runId` et `ownerToken` | Pas de DC (API triviale `ulid() => string`) |

Tout le reste est écrit maison ou utilise l'API standard Node ≥ 22 natif :

- `fs/promises`, `fs` (sync pour atomic write + lock)
- `crypto` si besoin (non utilisé v1, `ulid` suffit)
- `AbortSignal.timeout`, `AbortController` natifs
- `performance.now()` natif
- `process.stderr.write()` + `fs.appendFileSync` pour logger
- Pas de framework de tests runtime : tests via `vitest` (dev-only)

**Règle normative** : ajouter une dépendance runtime = modification du NX + justification écrite.

### 10.5 Manager de packages et runtime Node

- **Package manager** : `pnpm >= 10`
- **Node runtime** : `>= 22 LTS`
- **Bun comme runtime de consommation** : les consommateurs (orchestrateurs dans `~/.claude/scripts/`) peuvent exécuter le package via `bun run`. Le runtime ne dépend d'aucune API exclusive à Node ou Bun.

---

## 11. Critères de complétude du NIB-S

Le NIB-S est considéré complet si :

1. **Frontière v1 déclarée** : §2 établit ce qui est et n'est pas couvert.
2. **Invariants transversaux listés** : §3 énumère I-1 à I-15.
3. **Liste exhaustive des modules** : §4.2 mappe chaque module à son NIB-M d'owner. Aucun module orphelin.
4. **Types publics figés** : §6 définit la surface publique complète. Tout type non listé est interne.
5. **Formes canoniques figées** : §7 définit les contrats inter-layers et on-disk.
6. **Observabilité figée** : §6.7 liste les 11 events. Aucun NIB-M ne peut ajouter un event.
7. **Policies cross-cutting listées** : §5 liste les policies transversales avec leurs NIB-M owners.
8. **Mapping PhaseResult.kind ↔ action protocole** unique : §6.4.
9. **Taxonomie erreurs + table retry** uniques : §6.6 + §8.
10. **Modèle temporel** formalisé : §9.
11. **Orchestration de haut niveau** : §10 décrit le flux général. Les NIB-M remplissent le détail.

---

## 12. Référence au NIB-T

Le NIB-T (`NIB-T-CCOR v1.0`) est déjà rédigé. Il couvre :

- Les fonctions pures des services L4 (retry-resolver, classify, parseProtocolBlock/writeProtocolBlock, validateResult, readState/writeStateAtomic, resolveRunDir/cleanupOldRuns, generateRunId, clock, abortableSleep)
- Le lock (§11) — acquire O_EXCL, refresh phase-start, release avec ownerToken, events lock_conflict, SIGKILL crash recovery
- Les 3 bindings (SkillBinding, AgentBinding, AgentBatchBinding)
- L'engine via adapters publics (`runOrchestrator`) avec mocks fs + clock + stdio + logger + signal
- La taxonomie d'erreurs (11 classes)
- L'observabilité (11 events, corrélation runId, PII absence, events.ndjson owner-only)
- Le modèle temporel (cumul cross-reentry, deadline cross-reentry, clock jump immunité)
- Les signaux OS (SIGINT/SIGTERM handler → ABORTED + release lock)
- La composition récursive
- La surface publique (exports, constantes, dépendances minimales)

Chaque NIB-M doit avoir ses vecteurs de test correspondants dans le NIB-T. Le mapping se fait par trigramme :

| NIB-M | Trigramme(s) NIB-T |
| --- | --- |
| NIB-M-ERRORS | ER |
| NIB-M-INFRA-UTILS | CK + ID + AS |
| NIB-M-RUN-DIR | RD |
| NIB-M-STATE-IO | SI |
| NIB-M-PROTOCOL | PR |
| NIB-M-VALIDATOR | VA |
| NIB-M-RETRY-RESOLVER | RR |
| NIB-M-ERROR-CLASSIFIER | EC |
| NIB-M-LOGGER | OB + EV |
| NIB-M-LOCK | LK |
| NIB-M-BINDINGS | SK + AG + AB |
| NIB-M-RUN-ORCHESTRATOR | PF + partial RO + partial RS |
| NIB-M-DISPATCH-LOOP | RO + DF + CS + RT + SG |
| NIB-M-HANDLE-RESUME | RS + CS |
| NIB-M-PUBLIC-API | GL + CP + TM + FC |

**Cohérence inter-NIB** : un test qui échoue sur une implémentation fidèle d'un NIB-M révèle une incohérence entre NIB-M et NIB-T. L'architecte est responsable de la résolution. Discipline : "on questionne la fixture avant de questionner le code" (§29.1 NIB-T).

---

*cc-orchestrator-runtime — Implicit-Free Execution — "Reliability precedes intelligence."*
