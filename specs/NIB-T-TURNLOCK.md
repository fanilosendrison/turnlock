---
id: NIB-T-TURNLOCK
type: nib-tddtests
version: "2.0.0"
scope: turnlock
status: approved
consumers: [claude-code]
superseded_by: []
---

# NIB-T-TURNLOCK — TDD Tests Brief

**Package** : `turnlock`
**Statut** : v2.0 — séparation RED strict / GREEN Layer 1 companion (cf §0.4, NIB spec §2.3.1)
**Source** : `docs/NX-TURNLOCK.md` v0.8 (2026-04-19)
**Date** : 2026-04-20

**Changelog v1.0 → v2.0** :
- Ajout §0.4 — règle de classification RED strict vs GREEN Layer 1 companion (amont : NIB spec §2.3.1 + §7.5)
- Déplacés en §27.bis (GREEN-L1 companion, hors RED) : interface clock module (T-CK-01..04), event shape (T-OB-01..13), surface publique + constantes + typage + error kinds + error classes (C-GL-01..13, C-ER-01..03)
- Retirés complètement du NIB-T : tests du `createMockClock` helper (T-CK-05..08, P-CK-a/b) — test-harness, pas runtime
- Sections §27.1-§27.6 dépréciées en place avec pointeur vers §27.bis ; §27.7-§27.14 conservées en RED strict comme post-conditions transversales
- §30 récap réécrit en 2 cohortes (~375 RED + ~33 GREEN-L1)

---

## 0. Préambule

Ce document est la spécification de tests à implémenter **avant** toute ligne de code de production (étape RED du cycle TDD). Il matérialise le **contrat observable** de `turnlock` : ce que le runtime doit faire, vu de l'extérieur — par un orchestrateur consommateur et par l'agent parent qui parse stdout.

### 0.1 Portée du NIB-T

Le NIB-T couvre trois types de tests :

- **Acceptance tests (test vectors)** — paires entrée/sortie concrètes. "Étant donné cet `OrchestratorConfig` et cet état disque, le runtime doit émettre ce bloc protocole et persister ce `state.json`." Chaque vecteur spécifie l'input, l'output attendu, et la propriété vérifiée. C'est le gros du NIB-T (préfixe `T-`).
- **Property tests (anti-cheat)** — invariants structurels qui empêchent le hardcoding et l'overfitting. Idempotence des fonctions pures, stabilité du protocole, ordering des events, immunité aux clock jumps, append-only strict de `events.ndjson`, isolation des chemins per-attempt (préfixe `P-`).
- **Contract invariants** — assertions transversales qui s'appliquent à toutes les fixtures. "Tout bloc protocole contient `run_id`, `orchestrator`, `action`." "`state.json` est toujours écrit atomiquement." "Aucun event ne contient de PII." "Un run qui émet `orchestrator_start` émet `orchestrator_end`." Documentées une fois, enforcées partout (préfixe `C-`).

Le NIB-T ne décrit **pas** les tests unitaires d'implémentation interne. Les fonctions internes non exportées (ex. forme interne du dispatcher, structure mémoire du resolver, layout du lock scanner) n'ont pas de vecteurs dédiés ici — ils émergeront pendant la GREEN comme tests de support. Ce qui est testé ici, c'est le contrat exporté par le runtime et le contrat observable côté parent agent.

### 0.2 Surface testée

Sont couverts dans ce NIB-T, dans l'ordre des fichiers de test :

1. **Services transversaux purs** (Layer 4) — `resolveRetryDecision`, `classify` (error-classifier), `parseProtocolBlock` / `writeProtocolBlock`, `validateResult` (zod), `readState` / `writeStateAtomic`, `resolveRunDir` / `cleanupOldRuns`, `generateRunId`, `clock` module, `abortableSleep`.
2. **Lock d'exécution** (§4.13) — acquire O_EXCL, update atomique, release avec vérification ownerToken, lease idle simple, refresh phase-start, events `lock_conflict`.
3. **Bindings** (Layer 3) — `SkillBinding.buildManifest` / `buildProtocolBlock`, `AgentBinding`, `AgentBatchBinding`.
4. **Engine** (Layer 2) — `runOrchestrator` flow initial (§14.1), flow resume (§14.2), retry post-schema-error, retry post-timeout, single PhaseResult guard, deep-freeze, consumption exact-once.
5. **Préflight errors** — config invalide, state manquant/corrompu, mismatch runId/orchestratorName → bloc ERROR preflight.
6. **Protocole `@@TURNLOCK@@`** — 4 actions (`DELEGATE`, `DONE`, `ERROR`, `ABORTED`), format YAML-subset, mapping `PhaseResult.kind ↔ action`.
7. **Taxonomie d'erreurs** — 11 classes (§6.6), champs publics de `RunLockedError`, classification transient/permanent.
8. **Observabilité** — 11 types d'events (§11.3), corrélation par `runId`, absence de PII, `events.ndjson` owner-only append-only.
9. **Modèle temporel** — séparation wall/monotonic/epoch-ms, `durationMs ≥ 0` sous clock jump, deadline cross-process via wall-clock epoch.
10. **Signaux OS** — SIGINT/SIGTERM → émission ABORTED + release lock + exit code 130/143.
11. **Composition récursive** — orchestrateur A délègue à skill B qui est lui-même un orchestrateur.
12. **Surface publique** — exports, classes d'erreur, constantes `PROTOCOL_VERSION` / `STATE_SCHEMA_VERSION`, dépendances minimales.

### 0.3 Contenu interdit

Ce NIB-T **ne contient pas** :

- De détails d'implémentation de production (forme interne du dispatcher, algorithme de parsing du protocole, structure de fichiers `src/`).
- De tests sur du comportement interne non observable (ex. "la fonction `X` appelle `Y` avant `Z`").
- De tests unitaires sur fonctions internes non exportées — ceux-là émergent pendant GREEN.
- De tests live (vrai parent process invoquant le binaire et exécutant les blocs protocole) — tous les tests sont mockés par `mock-fs`, `mock-clock`, `mock-stdio`, `mock-logger`.

### 0.4 Classification RED strict vs GREEN Layer 1 companion

Référence normative amont : **NIB spec §2.3.1** (Tests that do NOT belong in the NIB-T) et **§7.5** (Anti-pattern : prescribing always-green tests).

Tout test prescrit dans ce NIB-T doit **échouer avant toute ligne de code de production** (phase RED stricte). Un test qui passe trivialement après `tsc --noEmit` sans aucun runtime implémenté n'est PAS un test RED — il appartient à une catégorie séparée : **GREEN Layer 1 companion**.

**Ne sont PAS RED — déplacés en §27.bis GREEN Layer 1 companion** :

- Surface publique / exports (ex-§27.1) : `C-GL-01..04` vérifient qu'un module exporte tel symbole. Trivialement vrai dès que Layer 1 compile.
- Constantes (ex-§27.2) : `C-GL-05..06` vérifient `PROTOCOL_VERSION === 1` et `STATE_SCHEMA_VERSION === 1`. Checks littéraux, pas des comportements.
- Dépendances (ex-§27.3) : `C-GL-07..08` inspectent `package.json`. Pas de runtime.
- Typage (ex-§27.4) : `C-GL-09..11` vérifient la compilation TS. Pas de runtime.
- Union fermée d'error kinds (ex-§27.5) : `C-GL-12..13` — type-level.
- Classes d'erreur (ex-§27.6) : `C-ER-01..03` vérifient `new MyError(...).prop === X`. Trivialement GREEN dès que la classe est scaffoldée.
- Forme des events (ex-§23.1) : `T-OB-01..13` — fixtures hardcodées, ne sollicitent aucun runtime. Testent la forme de l'event construit inline, pas le code qui le produit.
- Fermeture de la taxonomie events (ex-§23.2) : `T-OB-12..13` — même raisonnement.
- Interface du clock module (ex-§9.1) : `T-CK-01..04` — vérifient que `clock.nowWall()` retourne un `Date`, etc. Type-level post-scaffold.

**Supprimés complètement du NIB-T** (tests de test-harness, pas de runtime) :

- `T-CK-05..08` + `P-CK-a`, `P-CK-b` (ex-§9.2, §9.3) : testent `createMockClock`, un helper de test. Pas un contrat de production.

**Restent RED strict** : tous les tests qui invoquent effectivement une fonction runtime (`runOrchestrator`, bindings, services avec vraies entrées), toutes les property tests qui exercent un comportement, et les **contract invariants qui rident parasiquement sur les acceptance tests** (post-conditions transversales : absence de PII, cohérence state↔manifest, format events.ndjson, etc.).

**Règle de décision pour tout nouveau test** : si le test peut passer avant qu'une seule fonction runtime soit écrite (après un simple scaffold de types + classes), il est GREEN-companion, pas RED.

---

## 1. Organisation des fixtures

### 1.1 Arborescence

```
tests/
├── fixtures/
│   ├── states/                     # StateFile canoniques (v1) pour réhydratation
│   │   ├── initial-empty.json
│   │   ├── mid-run-no-pending.json
│   │   ├── mid-run-skill-pending.json
│   │   ├── mid-run-agent-pending.json
│   │   ├── mid-run-batch-pending.json
│   │   ├── mid-run-retry-attempt-1.json
│   │   ├── version-mismatch.json
│   │   ├── corrupted-schema.json
│   │   └── mismatch-run-id.json
│   ├── manifests/                  # DelegationManifest canoniques
│   │   ├── skill-attempt-0.json
│   │   ├── skill-attempt-1.json
│   │   ├── agent-attempt-0.json
│   │   ├── agent-batch-3jobs.json
│   │   └── agent-batch-5jobs-attempt-1.json
│   ├── results/                    # Fichiers résultats écrits par sub-agents simulés
│   │   ├── ok-simple.json
│   │   ├── ok-complex.json
│   │   ├── malformed-trailing-comma.json
│   │   ├── malformed-truncated.json
│   │   ├── empty.json
│   │   └── non-json-html.txt
│   ├── protocol/                   # Blocs @@TURNLOCK@@ canoniques (chaînes brutes)
│   │   ├── delegate-skill.txt
│   │   ├── delegate-agent.txt
│   │   ├── delegate-batch.txt
│   │   ├── done-minimal.txt
│   │   ├── error-preflight.txt
│   │   ├── error-with-phase.txt
│   │   ├── aborted-sigint.txt
│   │   ├── malformed-missing-end.txt
│   │   └── malformed-double-block.txt
│   ├── events/                     # Lignes events.ndjson canoniques
│   │   ├── happy-path-5phases.ndjson
│   │   ├── retry-schema-then-ok.ndjson
│   │   ├── retry-timeout-exhausted.ndjson
│   │   └── aborted-mid-phase.ndjson
│   └── locks/                      # LockFile contents
│       ├── active.json
│       ├── expired.json
│       └── other-owner.json
├── helpers/
│   ├── mock-fs.ts                  # Filesystem isolé par test (memfs ou temp dir)
│   ├── mock-clock.ts               # wall/mono/epoch contrôlables
│   ├── mock-stdio.ts               # Capture stdout/stderr + scenarios de re-entry
│   ├── mock-logger.ts              # Logger qui collecte les events en mémoire
│   ├── mock-signal.ts              # AbortSignal + émission SIGINT/SIGTERM
│   ├── fixture-loader.ts           # Chargement fixtures
│   ├── state-builder.ts            # Fabriques de StateFile avec overrides
│   ├── protocol-asserts.ts         # Assertions composites sur blocs @@TURNLOCK@@
│   ├── temp-run-dir.ts             # Crée un RUN_DIR temporaire + cleanup
│   └── run-harness.ts              # Orchestre un scénario multi-invocations
├── services/                       # Layer 4
│   ├── retry-resolver.test.ts
│   ├── error-classifier.test.ts
│   ├── protocol.test.ts
│   ├── validator.test.ts
│   ├── state-io.test.ts
│   ├── run-dir.test.ts
│   ├── run-id.test.ts
│   ├── clock.test.ts
│   └── abortable-sleep.test.ts
├── lock/                           # §4.13
│   └── lock.test.ts
├── bindings/
│   ├── skill-binding.test.ts
│   ├── agent-binding.test.ts
│   └── agent-batch-binding.test.ts
├── engine/
│   ├── run-initial-happy-path.test.ts
│   ├── run-resume-happy-path.test.ts
│   ├── run-retry-schema.test.ts
│   ├── run-retry-timeout.test.ts
│   ├── run-retry-exhausted.test.ts
│   ├── run-consumption-check.test.ts
│   ├── run-single-phase-result.test.ts
│   ├── run-deep-freeze.test.ts
│   ├── run-per-attempt-isolation.test.ts
│   ├── run-preflight-errors.test.ts
│   ├── run-signals.test.ts
│   └── run-composition.test.ts
├── observability/
│   ├── events-taxonomy.test.ts
│   ├── events-ndjson.test.ts
│   └── pii.test.ts
├── temporal/
│   └── temporal.test.ts
├── contracts/
│   ├── surface.test.ts
│   ├── errors.test.ts
│   └── fail-closed.test.ts
├── properties/
│   └── properties.test.ts
└── integration/
    └── ping-pong.test.ts           # Orchestrateur jouet end-to-end
```

### 1.2 Convention de nommage

- **Acceptance tests** : `T-{module}-{NN}` où `{module}` est un trigramme (ex. `T-RR-01` pour retry-resolver 01, `T-RO-12` pour run-orchestrator initial 12, `T-LK-05` pour lock 05).
- **Property tests** : deux conventions coexistent.
  - **Globaux** (préfixe `P-{NN}` numéroté séquentiellement, P-01 à P-NN) : property tests transversaux qui mobilisent plusieurs modules à la fois ou qui testent des invariants du runtime complet. Regroupés en §26.
  - **Locaux** (préfixe `P-{trigramme}-{lettre}`, ex. `P-RR-a`, `P-PR-b`) : property tests spécifiques à un module, hébergés à la fin de la section du module concerné.
- **Contract invariants** : `C-{NN}` numérotés globalement (C-01 à C-NN, regroupés par domaine dans §22-§25).
- **Sauts de numérotation volontaires** : pour les trigrammes qui couvrent plusieurs sous-sections (`RO` réparti §14-§16, `RS` §17), la numérotation est avancée à la dizaine ou centaine suivante à chaque transition de sous-section (ex. §14 finit à T-RO-30, §15 reprend à T-RO-40). Ces trous sont **intentionnels** et laissent la place pour des ajouts futurs sans décaler le reste.

### 1.3 Trigrammes par module

| Trigramme | Module |
| --- | --- |
| `RR` | retry-resolver |
| `EC` | error-classifier |
| `PR` | protocol (writeProtocolBlock / parseProtocolBlock) |
| `VA` | validator (zod wrapper) |
| `SI` | state-io (readState / writeStateAtomic) |
| `RD` | run-dir (resolveRunDir / cleanupOldRuns) |
| `ID` | run-id (ULID) |
| `CK` | clock (wall / epoch-ms / mono) |
| `AS` | abortable-sleep |
| `LK` | lock (acquire / refresh / release) |
| `SK` | SkillBinding |
| `AG` | AgentBinding |
| `AB` | AgentBatchBinding |
| `RO` | runOrchestrator flow initial (§14.1) |
| `RS` | runOrchestrator flow resume (§14.2) |
| `RT` | retry post-delegation (catch §14.1 step 16.i + §14.2 step 12.e) |
| `CS` | consumption exact-once (§6.3, §14.1 step 16.l) |
| `DF` | deep-freeze + single PhaseResult (§6.2) |
| `PF` | preflight errors (§4.4, §14.1 step 1-2, §14.2 step 1-7) |
| `SG` | signal handling (SIGINT/SIGTERM, §13) |
| `CP` | composition récursive (§15.3) |
| `OB` | observability (events taxonomy, §11) |
| `EV` | events.ndjson owner-only append-only (§7.5, §11.7) |
| `TM` | temporal model (§12) |
| `ER` | errors taxonomy (§6.6, §8) |
| `GL` | global contract (surface publique, exports, constantes) |
| `FC` | fail-closed invariants (§4.4, §19.4) |

### 1.4 Principes de fixture

- **Pas de fixture vide** : chaque fichier JSON contient un payload réaliste, reproduction littérale de ce qu'un sub-agent ou un skill produirait.
- **Fixtures sous contrôle de version** : sourcées de specs littérales (§7.1, §7.2, §7.4) ou d'exécutions capturées.
- **Normalisation** : les fichiers JSON n'ont pas d'espaces de fin, fin de ligne LF. Les chemins dans les fixtures sont relatifs et résolus par les helpers à l'exécution.
- **Indépendance au filesystem réel** : aucun test n'écrit hors d'un temp dir ou memfs créé par `temp-run-dir.ts`. Garantie : `rm -rf /tmp/turnlock-test-*` après `afterAll` doit tout nettoyer.
- **Indépendance au wall clock réel** : tout timing passe par `mock-clock.ts`. Un test qui attend un vrai délai est un bug — utiliser `advanceMono` / `advanceEpoch`.

### 1.5 Principe de découverte du bug via fixture

Si une fixture rate, on questionne la fixture avant de questionner le code. C'est la discipline miroir du NIB-T — les fixtures sont des engagements normatifs. Un échec de fixture signale soit un bug prod, soit un écart entre la spec et le NIB-T (à remonter).

---

## 2. Tests du retry-resolver (`tests/services/retry-resolver.test.ts`)

Signature testée :
```ts
resolveRetryDecision(
  error: OrchestratorError | Error,
  attempt: number,           // 0-indexé
  policy: RetryPolicy
): RetryDecision
```

Référence normative : §8.2 (table de décision), §9.2 (policy), §10.1 (forme).

### 2.1 Acceptance tests — erreurs fatales (tous `retry: false`)

Pour chaque ligne, `attempt` varie à 0, 1, et `policy.maxAttempts - 1` — la décision doit être constante (fatale peu importe l'attempt).

**Policy fixture** : `{ maxAttempts: 3, backoffBaseMs: 1000, maxBackoffMs: 30000 }`.

| ID | Type d'erreur en entrée | `attempt` | Décision attendue | Propriété vérifiée |
| --- | --- | --- | --- | --- |
| T-RR-01 | `InvalidConfigError` | 0, 1, 2 | `{ retry: false, reason: "fatal_invalid_config" }` | InvalidConfigError jamais retried |
| T-RR-02 | `StateCorruptedError` | 0, 1, 2 | `{ retry: false, reason: "fatal_state_corrupted" }` | StateCorruptedError jamais retried |
| T-RR-03 | `StateMissingError` | 0, 1, 2 | `{ retry: false, reason: "fatal_state_missing" }` | StateMissingError jamais retried |
| T-RR-04 | `StateVersionMismatchError` | 0, 1, 2 | `{ retry: false, reason: "fatal_state_version_mismatch" }` | StateVersionMismatchError jamais retried |
| T-RR-05 | `DelegationMissingResultError` | 0, 1, 2 | `{ retry: false, reason: "fatal_delegation_missing_result" }` | Non retriable (bug parent agent) |
| T-RR-06 | `ProtocolError` | 0, 1, 2 | `{ retry: false, reason: "fatal_protocol" }` | ProtocolError jamais retried |
| T-RR-07 | `AbortedError` | 0, 1, 2 | `{ retry: false, reason: "fatal_aborted" }` | AbortedError jamais retried (voulu) |
| T-RR-08 | `PhaseError` | 0, 1, 2 | `{ retry: false, reason: "fatal_phase_error" }` | PhaseError jamais retried v1 (§8.3) |
| T-RR-09 | `RunLockedError` | 0, 1, 2 | `{ retry: false, reason: "fatal_run_locked" }` | RunLockedError jamais retried |

### 2.2 Acceptance tests — erreurs retriables avec budget disponible

Pour chaque ligne, `maxAttempts = 3` et `attempt ∈ {0, 1}` → `attempt + 1 < 3` → budget disponible.

| ID | Type d'erreur | `attempt` | `delayMs` attendu | `reason` attendu |
| --- | --- | --- | --- | --- |
| T-RR-10 | `DelegationTimeoutError` | 0 | 1000 (= 1000 × 2^0) | `transient_timeout` |
| T-RR-11 | `DelegationTimeoutError` | 1 | 2000 (= 1000 × 2^1) | `transient_timeout` |
| T-RR-12 | `DelegationSchemaError` | 0 | 1000 | `transient_schema` |
| T-RR-13 | `DelegationSchemaError` | 1 | 2000 | `transient_schema` |

### 2.3 Acceptance tests — budget épuisé

| ID | Type d'erreur | `attempt` | `maxAttempts` | Décision attendue |
| --- | --- | --- | --- | --- |
| T-RR-14 | `DelegationTimeoutError` | 2 | 3 | `{ retry: false, reason: "retry_exhausted" }` (`attempt + 1 === maxAttempts`) |
| T-RR-15 | `DelegationSchemaError` | 2 | 3 | `{ retry: false, reason: "retry_exhausted" }` |
| T-RR-16 | `DelegationTimeoutError` | 0 | 1 | `{ retry: false, reason: "retry_exhausted" }` (budget 1 = pas de retry) |
| T-RR-17 | `DelegationTimeoutError` | 5 | 3 | `{ retry: false, reason: "retry_exhausted" }` (au-delà, défensif) |

### 2.4 Acceptance tests — backoff cap

| ID | Input | `attempt` | `policy` | `delayMs` attendu |
| --- | --- | --- | --- | --- |
| T-RR-18 | `DelegationTimeoutError` | 5 | `{ maxAttempts: 10, backoffBaseMs: 1000, maxBackoffMs: 30000 }` | 30000 (capé, car 1000 × 2^5 = 32000) |
| T-RR-19 | `DelegationTimeoutError` | 6 | `{ maxAttempts: 10, backoffBaseMs: 1000, maxBackoffMs: 30000 }` | 30000 |
| T-RR-20 | `DelegationTimeoutError` | 0 | `{ maxAttempts: 3, backoffBaseMs: 500, maxBackoffMs: 2000 }` | 500 |
| T-RR-21 | `DelegationTimeoutError` | 2 | `{ maxAttempts: 5, backoffBaseMs: 500, maxBackoffMs: 2000 }` | 2000 (500 × 2^2) |

### 2.5 Acceptance tests — erreurs non classifiées

| ID | Input | `attempt` | `maxAttempts` | Décision attendue |
| --- | --- | --- | --- | --- |
| T-RR-22 | `new Error("weird")` | 0 | 3 | `{ retry: false, reason: "fatal_unknown" }` (le runtime ne retry pas d'erreur inconnue en v1, §8.3) |
| T-RR-23 | `new TypeError("oops")` | 0 | 3 | `{ retry: false, reason: "fatal_unknown" }` |

### 2.6 Propriétés

- **P-RR-a** : `resolveRetryDecision` est une fonction pure — deux appels avec mêmes arguments produisent le même résultat. Testé sur 50 itérations aléatoires (seeds 1-50).
- **P-RR-b** : la décision pour une erreur fatale est indépendante de `policy`. Testé avec 5 policies différentes pour chaque type fatal (T-RR-01 à T-RR-09).
- **P-RR-c** : `retry === true` ⇒ `delayMs !== undefined && delayMs > 0`.
- **P-RR-d** : `retry === false` ⇒ `delayMs === undefined`.
- **P-RR-e** : pour toute erreur retriable, `delayMs <= policy.maxBackoffMs`.

---

## 3. Tests de l'error-classifier (`tests/services/error-classifier.test.ts`)

Signature : `classify(error: Error) => "transient" | "permanent" | "abort" | "unknown"`.

Référence : §5.5, §8.1.

### 3.1 Acceptance tests — classification

| ID | Input | Sortie attendue |
| --- | --- | --- |
| T-EC-01 | `InvalidConfigError` | `"permanent"` |
| T-EC-02 | `StateCorruptedError` | `"permanent"` |
| T-EC-03 | `StateMissingError` | `"permanent"` |
| T-EC-04 | `StateVersionMismatchError` | `"permanent"` |
| T-EC-05 | `DelegationTimeoutError` | `"transient"` |
| T-EC-06 | `DelegationSchemaError` | `"transient"` |
| T-EC-07 | `DelegationMissingResultError` | `"permanent"` |
| T-EC-08 | `PhaseError` (cause = `new Error("x")`) | `"permanent"` |
| T-EC-09 | `PhaseError` (cause = `AbortedError`) | `"abort"` |
| T-EC-10 | `ProtocolError` | `"permanent"` |
| T-EC-11 | `AbortedError` | `"abort"` |
| T-EC-12 | `RunLockedError` | `"permanent"` |
| T-EC-13 | `new Error("unknown type")` | `"unknown"` |
| T-EC-14 | `new TypeError("generic")` | `"unknown"` |

### 3.2 Propriétés

- **P-EC-a** : `classify` est une fonction pure (50 itérations sur un même input produisent la même sortie).
- **P-EC-b** : le codomain est exactement `{"transient", "permanent", "abort", "unknown"}`. Jamais de string hors ensemble.

---

## 4. Tests du protocole (`tests/services/protocol.test.ts`)

Référence : §7.4.

### 4.1 writeProtocolBlock — action DELEGATE

Signature : `writeProtocolBlock(action: "DELEGATE", fields: DelegateFields): string`.

| ID | Input | Output attendu (string, lignes séparées par `\n`) |
| --- | --- | --- |
| T-PR-01 | `{ runId: "01HX...", orchestrator: "senior-review", manifest: "/abs/path.json", kind: "skill", resumeCmd: "bun run /path/main.ts --run-id 01HX... --resume" }` | `"\n@@TURNLOCK@@\nversion: 1\nrun_id: 01HX...\norchestrator: senior-review\naction: DELEGATE\nmanifest: /abs/path.json\nkind: skill\nresume_cmd: \"bun run /path/main.ts --run-id 01HX... --resume\"\n@@END@@\n\n"` (bloc précédé/suivi d'une ligne vide, `resume_cmd` quoté car contient espaces) |
| T-PR-02 | idem avec `kind: "agent"` | identique sauf `kind: agent` |
| T-PR-03 | idem avec `kind: "agent-batch"` | identique sauf `kind: agent-batch` |

### 4.2 writeProtocolBlock — action DONE

| ID | Input | Champs présents dans l'output |
| --- | --- | --- |
| T-PR-04 | `{ runId, orchestrator, output: "/abs/output.json", success: true, phasesExecuted: 5, durationMs: 12345 }` | `action: DONE`, `output: /abs/output.json`, `success: true`, `phases_executed: 5`, `duration_ms: 12345` |
| T-PR-05 | `success: true` + `phasesExecuted: 0` | `phases_executed: 0` (pas omis) |

### 4.3 writeProtocolBlock — action ERROR

| ID | Input | Output vérifié |
| --- | --- | --- |
| T-PR-06 | `{ runId, orchestrator, errorKind: "delegation_schema", message: "Validation failed", phase: "consolidate", phasesExecuted: 4 }` | `action: ERROR`, `error_kind: delegation_schema`, `message: "Validation failed"`, `phase: consolidate`, `phases_executed: 4` |
| T-PR-07 | Preflight ERROR : `{ runId: null, orchestrator: "senior-review", errorKind: "invalid_config", message: "OrchestratorConfig.resumeCommand is required", phase: null, phasesExecuted: 0 }` | `run_id: null`, `phase: null`, `phases_executed: 0`, quoting sur message |
| T-PR-08 | `errorKind: "run_locked"` avec message contenant un chemin | `error_kind: run_locked`, message quoté |
| T-PR-09 | Message contenant `"` double-quote | échappement JSON standard dans les quotes (`\"`) |
| T-PR-10 | Message contenant `\n` retour ligne | échappement `\\n` dans les quotes |

### 4.4 writeProtocolBlock — action ABORTED

| ID | Input | Output vérifié |
| --- | --- | --- |
| T-PR-11 | `{ runId, orchestrator, signal: "SIGINT", phase: "dispatch-reviews" }` | `action: ABORTED`, `signal: SIGINT`, `phase: dispatch-reviews` |
| T-PR-12 | `{ signal: "SIGTERM", phase: null }` | `action: ABORTED`, `signal: SIGTERM`, `phase: null` |

### 4.5 parseProtocolBlock — parsing d'un bloc valide

Signature : `parseProtocolBlock(stdout: string): ProtocolBlock | null`.

| ID | Input | Output attendu |
| --- | --- | --- |
| T-PR-13 | Bloc DELEGATE complet | `{ version: 1, runId, orchestrator, action: "DELEGATE", fields: { manifest, kind, resumeCmd } }` |
| T-PR-14 | Bloc DONE complet | `{ version: 1, runId, orchestrator, action: "DONE", fields: { output, success: true, phasesExecuted, durationMs } }` |
| T-PR-15 | Bloc ERROR avec `run_id: null` | `runId: null` (preflight) |
| T-PR-16 | Bloc ERROR avec `phase: null` | `fields.phase === null` |
| T-PR-17 | Bloc ABORTED | `action: "ABORTED"`, `signal`, `phase` |
| T-PR-18 | Booléen string `success: true` → parsé en vrai booléen | `fields.success === true` (boolean, pas string) |
| T-PR-19 | Entier string `phases_executed: 5` → parsé en number | `fields.phasesExecuted === 5` (number) |

### 4.6 parseProtocolBlock — parsing erroné

| ID | Input | Output attendu |
| --- | --- | --- |
| T-PR-20 | Texte ne contenant pas de bloc | `null` |
| T-PR-21 | Bloc sans `@@END@@` | `null` |
| T-PR-22 | Bloc sans `@@TURNLOCK@@` de début | `null` |
| T-PR-23 | Bloc avec version incompatible (`version: 2`) | `null` (ou throw — **DÉCISION** : retour `null`, la gestion du mismatch incombe au parent agent) |
| T-PR-24 | Bloc avec action inconnue | `null` |

### 4.7 parseProtocolBlock — multiplicité

| ID | Input | Output |
| --- | --- | --- |
| T-PR-25 | Deux blocs valides dans la même string (ne devrait pas arriver, mais défensif) | **DÉCISION** : retourne le **premier** bloc parsé. La règle §7.4 ("un seul bloc par invocation") est garantie par le runtime émetteur, le parser parent-side est tolérant. |
| T-PR-26 | Un bloc précédé de bruit (logs stderr mal redirigés, etc.) | Parsé correctement (le parser ignore les lignes avant `@@TURNLOCK@@`) |

### 4.8 Propriétés

- **P-PR-a** : round-trip. Pour tout bloc `b` émis par `writeProtocolBlock`, `parseProtocolBlock(b)` reconstruit les mêmes champs sémantiques. Testé sur 4 actions × 5 variantes chacune.
- **P-PR-b** : `writeProtocolBlock` et `parseProtocolBlock` sont des fonctions pures.
- **P-PR-c** : tout bloc émis contient exactement une ligne `@@TURNLOCK@@` et une ligne `@@END@@`.
- **P-PR-d** : tout bloc émis contient les champs obligatoires `version`, `run_id`, `orchestrator`, `action`. Vérifié par regex sur 20 émissions variées.

---

## 5. Tests du validator zod (`tests/services/validator.test.ts`)

Signature : `validateResult<T>(rawJson: unknown, schema: ZodSchema<T>): ValidationResult<T>`.

`ValidationResult<T> = { ok: true, data: T } | { ok: false, error: ZodError }`.

Référence : §5.5, §14.2 step 12.

### 5.1 Acceptance tests — validation réussie

Fixture schema : `const schema = z.object({ foo: z.string(), bar: z.number() })`.

| ID | `rawJson` | Output |
| --- | --- | --- |
| T-VA-01 | `{ foo: "a", bar: 1 }` | `{ ok: true, data: { foo: "a", bar: 1 } }` |
| T-VA-02 | `{ foo: "", bar: 0 }` | `{ ok: true, data: { foo: "", bar: 0 } }` |

### 5.2 Acceptance tests — validation échouée

| ID | `rawJson` | Output (shape) |
| --- | --- | --- |
| T-VA-03 | `{ foo: 1, bar: 1 }` (foo wrong type) | `{ ok: false, error: ZodError avec issue sur "foo" }` |
| T-VA-04 | `{ foo: "a" }` (bar missing) | `{ ok: false, error: ZodError avec issue sur "bar" }` |
| T-VA-05 | `null` | `{ ok: false, error: ZodError }` |
| T-VA-06 | `"plain string"` | `{ ok: false, error: ZodError }` |
| T-VA-07 | `[]` | `{ ok: false, error: ZodError }` |

### 5.3 Acceptance tests — extraction de résumé d'erreur zod

Signature helper : `summarizeZodError(err: ZodError): string` — produit un résumé ≤ 200 chars (§11.5) pour logger `delegation_validation_failed.zodErrorSummary`.

| ID | Input ZodError | Propriété vérifiée |
| --- | --- | --- |
| T-VA-08 | Erreur sur 1 champ | Summary contient le path du champ + code zod, ≤ 200 chars |
| T-VA-09 | Erreur sur 10 champs | Summary tronqué à 200 chars avec `"…"` terminal |
| T-VA-10 | Erreur sans path (root) | Summary commence par `"root: "` |

### 5.4 Propriétés

- **P-VA-a** : `validateResult` est pure.
- **P-VA-b** : le résumé `summarizeZodError` ≤ 200 chars pour toute entrée (50 erreurs générées aléatoirement).
- **P-VA-c** : `validateResult(x, schema).ok === true` ⇒ `data` satisfait le schéma (idempotence de validation).

---

## 6. Tests du state-io (`tests/services/state-io.test.ts`)

Signatures :
```ts
readState<S>(runDir: string, schema?: ZodSchema<S>): StateFile<S> | null
writeStateAtomic<S>(runDir: string, state: StateFile<S>, schema?: ZodSchema<S>): void
```

Référence : §4.3, §4.10, §7.1.

### 6.1 Acceptance tests — read

| ID | Situation | Output attendu |
| --- | --- | --- |
| T-SI-01 | `state.json` absent | `null` |
| T-SI-02 | `state.json` valide v1 | `StateFile` typé, champs tous présents |
| T-SI-03 | `state.json` invalide JSON (trailing comma) | throw `StateCorruptedError` |
| T-SI-04 | `state.json` avec `schemaVersion: 2` | throw `StateVersionMismatchError` |
| T-SI-05 | `state.json` sans `schemaVersion` | throw `StateCorruptedError` |
| T-SI-06 | `state.json` valide + schéma fourni, data conforme | `StateFile` typé |
| T-SI-07 | `state.json` valide + schéma fourni, data non conforme | throw `StateCorruptedError` (avec cause = ZodError) |

### 6.2 Acceptance tests — write atomique

| ID | Situation | Propriété vérifiée |
| --- | --- | --- |
| T-SI-08 | Premier write | `state.json` créé, `state.json.tmp` **absent** post-write |
| T-SI-09 | Write remplace un existant | Ancien contenu remplacé, aucune trace du tmp |
| T-SI-10 | Write d'un state invalide au schéma | throw avant tout write (ni tmp, ni rename) |
| T-SI-11 | Crash simulé entre `write` et `rename` (mock fs qui throw après `writeFileSync` mais avant `rename`) | `state.json` original intact, `state.json.tmp` peut exister (OK, sera écrasé au prochain write) |
| T-SI-12 | Write avec `pendingDelegation: undefined` | Champ absent (pas `"pendingDelegation": null`) OU présent à `null` — **DÉCISION** : sérialisé comme **absent** (convention JSON standard pour `undefined`) |

### 6.3 Propriétés

- **P-SI-a** : round-trip. Pour tout `state: StateFile<S>` conforme, `readState(writeStateAtomic(state))` produit un state structurellement identique.
- **P-SI-b** : `writeStateAtomic` est atomique au sens POSIX — aucun lecteur concurrent ne peut observer un `state.json` tronqué (testé via 100 reads concurrents pendant 10 writes séquentiels, tous observent soit l'ancien soit le nouveau, jamais partiel).
- **P-SI-c** : `state.json.tmp` n'est jamais présent à la fin d'un write réussi.

---

## 7. Tests du run-dir (`tests/services/run-dir.test.ts`)

Signatures :
```ts
resolveRunDir(cwd: string, orchestratorName: string, runId: string): string
cleanupOldRuns(cwd: string, orchestratorName: string, retentionDays: number, currentRunId: string): number
```

Référence : §5.5.

### 7.1 Acceptance tests — resolveRunDir

> **Note** : les noms d'orchestrateur (`senior-review`) proviennent du premier consommateur (Claude Code, voir `docs/consumers/claude-code/`). Pour le runtime, ce sont des labels opaques. Le préfixe `.turnlock/runs/` est le défaut du runtime, surchargeable via env `TURNLOCK_RUN_DIR_ROOT` ou champ `OrchestratorConfig.runDirRoot` (cf NIB-M-RUN-DIR §1).

| ID | Input | Output |
| --- | --- | --- |
| T-RD-01 | `cwd="/repo"`, `name="senior-review"`, `runId="01HX"` (défaut) | `"/repo/.turnlock/runs/senior-review/01HX"` |
| T-RD-02 | `cwd` avec espaces | chemin correctement composé |
| T-RD-03 | `cwd` vide | throw ou retourne chemin relatif — **DÉCISION** : throw `InvalidConfigError("cwd cannot be empty")` |
| T-RD-09 | `runDirRoot=".claude/run/cc-orch"` (relatif) | `"<cwd>/.claude/run/cc-orch/<name>/<runId>"` |
| T-RD-10 | `runDirRoot="/abs/path"` (absolu) | `"/abs/path/<name>/<runId>"` (cwd non préfixé) |
| T-RD-11 | Env `TURNLOCK_RUN_DIR_ROOT=".x"` + arg `".y"` | chemin basé sur `.x` (env > arg) |
| T-RD-12 | Env `TURNLOCK_RUN_DIR_ROOT=""` (vide) | fallback sur arg ou défaut |

### 7.2 Acceptance tests — cleanupOldRuns

Setup : créer 5 RUN_DIRs avec dates de dernière modification ISO (7 jours ago, 8 jours ago, 1 jour ago, today, today). Retention = 7 jours.

| ID | Situation | Comportement |
| --- | --- | --- |
| T-RD-04 | Run actuel (today) dans la liste | Jamais supprimé, même si sa mtime était incorrecte |
| T-RD-05 | Run > retentionDays | Supprimé |
| T-RD-06 | Run = retentionDays exactement | Conservé (strict `>`) |
| T-RD-07 | Retour de fonction | Nombre de dirs supprimés (retour utilisable pour logging) |
| T-RD-08 | RUN_DIR du nom d'un autre orchestrateur | Pas touché (scope strict par `orchestratorName`) |

### 7.3 Propriétés

- **P-RD-a** : `cleanupOldRuns` ne supprime **jamais** `currentRunId` (invariant testé sur 20 scénarios).
- **P-RD-b** : deux runs avec `orchestratorName` différents produisent des chemins disjoints (aucun ancêtre commun hors racine).

---

## 8. Tests du run-id (`tests/services/run-id.test.ts`)

Signature : `generateRunId(): string`.

Référence : §5.5.

### 8.1 Acceptance tests

| ID | Propriété vérifiée |
| --- | --- |
| T-ID-01 | Format ULID : regex `/^[0-9A-HJKMNP-TV-Z]{26}$/` (Crockford base32) |
| T-ID-02 | Longueur exacte 26 |
| T-ID-03 | Génération de 100 IDs successifs : tous distincts |
| T-ID-04 | Génération de 2 IDs à la même ms : lexicographiquement croissants (ou égaux dans le cas ultra-rare de collision random, **DÉCISION** : on tolère ≥) |

### 8.2 Propriétés

- **P-ID-a** : sur 1000 IDs générés avec mock clock qui avance d'1 ms par call, tri lexicographique == tri chronologique. Vérifie la propriété ULID.

---

## 9. Tests du clock (`tests/services/clock.test.ts`)

Référence : §5.5, §12.

**[DÉPLACÉ EN §27.bis GREEN Layer 1 companion]** — Les assertions sur l'interface du `clock` module (retour de types, format ISO) sont des vérifications type-level qui passent trivialement dès que Layer 1 compile. Elles ne guident pas le RED. Voir §0.4 et §27.bis pour `T-CK-01..04`.

**[SUPPRIMÉS]** — Les tests de `createMockClock` (ex-§9.2 `T-CK-05..08`, ex-§9.3 `P-CK-a`, `P-CK-b`) testaient le test-harness lui-même, pas du runtime. Retirés conformément à §0.4.

Les vrais tests du comportement temporel du runtime (mock clock vs monotonic, deadline cross-process, cumul durée cross-reentry) sont dans **§22.bis — Tests du modèle temporel**.

---

## 10. Tests de abortableSleep (`tests/services/abortable-sleep.test.ts`)

Signature : `abortableSleep(delayMs: number, signal: AbortSignal): Promise<void>`.

Référence : §13.4 (abort propagé).

### 10.1 Acceptance tests

| ID | Scénario | Comportement |
| --- | --- | --- |
| T-AS-01 | `delayMs: 100`, signal non abortée, mock clock avance de 100ms | Promise resolve |
| T-AS-02 | `delayMs: 100`, signal aborted au début | Promise reject `AbortedError` immédiatement (pas d'attente) |
| T-AS-03 | `delayMs: 100`, signal aborted à 50ms | Promise reject `AbortedError` à 50ms |
| T-AS-04 | `delayMs: 0` | Promise resolve immédiatement |
| T-AS-05 | `delayMs: -100` | throw ou resolve immédiat — **DÉCISION** : resolve immédiat (cohérent `setTimeout(0)`) |

### 10.2 Propriétés

- **P-AS-a** : `abortableSleep` ne retient pas de timer après resolve/reject (pas de leak). Vérifié en mockant `setTimeout`/`clearTimeout`.
- **P-AS-b** : abort toujours gagne sur delay (si les deux sont simultanés, la promise reject).

---

## 11. Tests du lock (`tests/lock/lock.test.ts`)

Référence : §4.13.

Signatures principales (internes, testées via l'engine ou directement si exposées) :
```ts
acquireLock(lockPath: string, ownerPid: number, clock: Clock, logger: Logger): { ownerToken: string } | RunLockedError
refreshLock(lockPath: string, ownerToken: string, clock: Clock): void
releaseLock(lockPath: string, ownerToken: string, clock: Clock, logger: Logger): void
```

Constantes : `DEFAULT_IDLE_LEASE_MS = 30 * 60 * 1000` (30 min).

### 11.1 Acceptance tests — acquire

| ID | Situation initiale | Action | Résultat |
| --- | --- | --- | --- |
| T-LK-01 | Pas de `.lock` | acquireLock | Succès, fichier `.lock` créé avec `{ownerPid, ownerToken: ULID, acquiredAtEpochMs: nowEpoch, leaseUntilEpochMs: nowEpoch + 1800000}` |
| T-LK-02 | `.lock` existe, `leaseUntilEpochMs > nowEpoch` (actif) | acquireLock | throw `RunLockedError` avec `ownerPid`, `acquiredAtEpochMs`, `leaseUntilEpochMs` du lock existant. Aucune écriture. |
| T-LK-03 | `.lock` existe, `leaseUntilEpochMs < nowEpoch` (expiré) | acquireLock | Succès : override. Emit event `lock_conflict` (reason: `"expired_override"`, currentOwnerToken: ancien token) |
| T-LK-04 | `.lock` existe, `leaseUntilEpochMs === nowEpoch` (edge) | acquireLock | **DÉCISION** : strict `<` donc ici considéré **actif** → throw `RunLockedError`. (Cohérent : lease inclusif) |
| T-LK-05 | Concurrence : deux processes en O_EXCL simultané | Un seul réussit, l'autre throw `RunLockedError` | Verifié via `mock-fs` simulant `EEXIST` sur le deuxième |

### 11.2 Acceptance tests — refresh (update atomique)

| ID | Situation | Action | Résultat |
| --- | --- | --- | --- |
| T-LK-06 | Lock owned par moi, `ownerToken` match | `refreshLock` | Nouveau `leaseUntilEpochMs = nowEpoch + DEFAULT_IDLE_LEASE_MS` écrit via tmp + rename. Autres champs inchangés. |
| T-LK-07 | Lock volé (ownerToken différent) | `refreshLock` | Emit event `lock_conflict` (reason: `"stolen_at_release"` — même reason que release, sémantique "token mismatch") — **DÉCISION NIB-T** : reason = `"stolen_at_release"` pour uniformité. Si la spec veut un reason dédié, ajuster. No-op (skip write). |
| T-LK-08 | Refresh multiple en rapide succession | Tous réussissent, `leaseUntilEpochMs` final = last `nowEpoch` + lease |

### 11.3 Acceptance tests — release

| ID | Situation | Action | Résultat |
| --- | --- | --- | --- |
| T-LK-09 | Lock owned par moi, ownerToken match | `releaseLock` | Fichier `.lock` supprimé |
| T-LK-10 | Lock volé (ownerToken différent) | `releaseLock` | Emit event `lock_conflict` (reason: `"stolen_at_release"`, currentOwnerToken: autre token). Pas d'unlink. |
| T-LK-11 | Lock déjà supprimé par quelqu'un d'autre | `releaseLock` | No-op silencieux (ENOENT traité comme already-released) |

### 11.4 Acceptance tests — événements

| ID | Situation | Event émis |
| --- | --- | --- |
| T-LK-12 | Acquire successful (pas d'override) | **Aucun event** (opération normale, §4.13) |
| T-LK-13 | Acquire avec override expiré | `lock_conflict` (reason: `"expired_override"`, currentOwnerToken: ancien token) |
| T-LK-14 | Refresh successful | **Aucun event** |
| T-LK-15 | Release successful | **Aucun event** |
| T-LK-16 | Release avec token mismatch | `lock_conflict` (reason: `"stolen_at_release"`) |

### 11.5 Acceptance tests — SIGKILL crash recovery

Référence : §3.2, §4.13, §17.

| ID | Scénario | Vérification |
| --- | --- | --- |
| T-LK-17 | Process A SIGKILL'd (simulé par suppression du handler, lock resté sur disque). Mock clock avance de 31 min. Process B démarre sur le même runId. | B trouve lock, `nowEpoch > leaseUntilEpochMs` → override via `expired_override`. B acquiert le lock, run continue. Validation de "pas de resume après SIGKILL" = dégradation à crash recovery gracieux (§17). |
| T-LK-18 | Process A SIGKILL'd. Mock clock avance de 29 min (lease encore actif). Process B démarre. | B trouve lock actif → throw `RunLockedError`. Pas d'override (lease pas expiré). Retry manuel par l'utilisateur après 30 min. |

### 11.6 Acceptance tests — io.refreshLock() depuis une phase

Référence : §4.13 helper, §6.3.

| ID | Scénario | Vérification |
| --- | --- | --- |
| T-LK-19 | Phase mécanique longue appelle `io.refreshLock()` toutes les 10 min (simulé via mock clock advance). Phase dure 40 min total. | Lock file écrit (mise à jour de `leaseUntilEpochMs`) à chaque appel. Aucun `expired_override` déclenché par une re-entry concurrente fictive. |
| T-LK-20 | Phase appelle `io.refreshLock()` 10 fois rapidement (< 1 sec) | Tous les refresh réussissent, `leaseUntilEpochMs` final = `nowEpoch + DEFAULT_IDLE_LEASE_MS`. Pas d'effet cumulatif indésirable. |

### 11.7 Propriétés

- **P-LK-a** : acquire + release laisse le filesystem dans l'état initial (pas de résidu `.lock` ni `.lock.tmp`).
- **P-LK-b** : pour tout ownerToken, `refreshLock` sur un lock qui n'est pas owned ne modifie **jamais** le fichier.
- **P-LK-c** : mutex réel — deux acquires simultanés avec le même runDir ne peuvent jamais tous les deux réussir. Testé via 10 runs concurrents avec `Promise.all`.
- **P-LK-d** : acquire → refresh N fois → release laisse `.lock` absent pour N ∈ {0, 1, 5, 100}.

---

## 12. Tests du SkillBinding (`tests/bindings/skill-binding.test.ts`)

Référence : §5.4, §6.5, §7.2, §7.4.1.

Signature : `SkillBinding.buildManifest(request, context): DelegationManifest` + `SkillBinding.buildProtocolBlock(manifest): string`.

### 12.1 Acceptance tests — buildManifest

> **Note** : les noms (`senior-review`, `dedup-codebase`, etc.) proviennent du premier consommateur Claude Code. Pour le runtime, ce sont des labels opaques. Voir `docs/consumers/claude-code/` pour le contexte de provenance. Les chemins utilisent le RUN_DIR root par défaut `.turnlock/runs/` (surchargeable, cf NIB-M-RUN-DIR §1).

Context fixture : `{ runId: "01HX", orchestratorName: "senior-review", phase: "dispatch", resumeAt: "consolidate", attempt: 0, maxAttempts: 3, emittedAt: "2026-04-19T12:00:00.000Z", emittedAtEpochMs: 1745062800000, timeoutMs: 600000, deadlineAtEpochMs: 1745063400000, runDir: "/tmp/.turnlock/runs/senior-review/01HX" }`.

| ID | Request | Champs clés du manifest attendu |
| --- | --- | --- |
| T-SK-01 | `{ kind: "skill", skill: "dedup-codebase", label: "cleanup", args: { path: "src/" } }` | `manifestVersion: 1`, `runId`, `orchestratorName`, `phase: "dispatch"`, `resumeAt: "consolidate"`, `label: "cleanup"`, `kind: "skill"`, `skill: "dedup-codebase"`, `skillArgs: { path: "src/" }`, `resultPath: "/tmp/.turnlock/runs/senior-review/01HX/results/cleanup-0.json"`, `emittedAt`, `emittedAtEpochMs`, `timeoutMs: 600000`, `deadlineAtEpochMs`, `attempt: 0`, `maxAttempts: 3` |
| T-SK-02 | Sans `args` | `skillArgs` absent ou `{}` — **DÉCISION** : **absent** (cohérent JSON) |
| T-SK-03 | `attempt: 2` | `resultPath` contient `cleanup-2.json` (per-attempt §7.2) |
| T-SK-04 | `label` contient caractères invalides (`UPPER`) | throw `ProtocolError` ? — **NON** : la validation de label est faite en amont par l'engine (§14.1 step 16.n). Le binding n'a pas cette responsabilité. |

### 12.2 Acceptance tests — buildProtocolBlock

| ID | Input (manifest) | Output |
| --- | --- | --- |
| T-SK-05 | Manifest de T-SK-01 + `resumeCmd: "bun run /path --run-id 01HX --resume"` | Bloc DELEGATE avec `manifest: <manifestPath>`, `kind: skill`, `resume_cmd: "..."` |
| T-SK-06 | Cohérence : `kind` du bloc == `kind` du manifest | Toujours vrai |

### 12.3 Propriétés

- **P-SK-a** : `buildManifest` est pure (deux appels avec mêmes args produisent un manifest identique, sauf si `clock` mocké pour varier).
- **P-SK-b** : `resultPath` toujours de la forme `<runDir>/results/<label>-<attempt>.json`.
- **P-SK-c** : `manifest.kind === "skill"` toujours pour un `SkillBinding`.

---

## 13. Tests du AgentBinding (`tests/bindings/agent-binding.test.ts`)

Référence : §5.4, §6.5, §7.2, §7.4.1.

### 13.1 Acceptance tests — buildManifest

| ID | Request | Champs clés attendus |
| --- | --- | --- |
| T-AG-01 | `{ kind: "agent", agentType: "senior-reviewer-file", prompt: "Review src/foo.ts", label: "review-foo" }` | `manifestVersion: 1`, `kind: "agent"`, `agentType: "senior-reviewer-file"`, `prompt: "Review src/foo.ts"`, `label: "review-foo"`, `resultPath: <runDir>/results/review-foo-0.json`, `skill` absent, `skillArgs` absent, `jobs` absent |
| T-AG-02 | `prompt` long (5000 chars) | Préservé intégralement dans le manifest (pas de troncature) |
| T-AG-03 | `attempt: 1` | `resultPath` contient `review-foo-1.json` |

### 13.2 Acceptance tests — buildProtocolBlock

| ID | Input | Output |
| --- | --- | --- |
| T-AG-04 | Manifest T-AG-01 | Bloc DELEGATE avec `kind: agent` |
| T-AG-05 | Cohérence | `manifest.kind === "agent"` → bloc `kind: agent` |

### 13.3 Propriétés

- **P-AG-a** : `buildManifest` est pure.
- **P-AG-b** : `resultPath` de la forme `<runDir>/results/<label>-<attempt>.json`.

---

## 14. Tests du AgentBatchBinding (`tests/bindings/agent-batch-binding.test.ts`)

Référence : §5.4, §6.5, §7.2, §7.4.1.

### 14.1 Acceptance tests — buildManifest

| ID | Request (n jobs) | Structure attendue |
| --- | --- | --- |
| T-AB-01 | 1 job `{ id: "j1", prompt: "p1" }` | `kind: "agent-batch"`, `jobs: [{ id: "j1", prompt: "p1", resultPath: "<runDir>/results/<label>-0/j1.json" }]`, `resultPath` top-level absent |
| T-AB-02 | 3 jobs | `jobs.length === 3`, chacun avec son propre `resultPath` per-jobId |
| T-AB-03 | Jobs avec IDs identiques | Le binding **n'enforce pas** l'unicité (responsabilité du caller §6.5). Manifest construit quand même. — **DÉCISION** : test accepte la construction, l'unicité est enforcée au niveau engine (T-RO-XX). |
| T-AB-04 | 0 jobs (`jobs: []`) | throw `InvalidConfigError` — **DÉCISION** : binding throw par défense en profondeur, même si l'engine doit throw aussi. |
| T-AB-05 | `attempt: 2`, 3 jobs | Chaque `resultPath` contient `<label>-2/<jobId>.json` |

### 14.2 Acceptance tests — buildProtocolBlock

| ID | Input | Output |
| --- | --- | --- |
| T-AB-06 | Manifest T-AB-02 | Bloc DELEGATE avec `kind: agent-batch` |

### 14.3 Acceptance tests — scaling

| ID | Request | Vérification |
| --- | --- | --- |
| T-AB-07 | 5 jobs | Manifest a 5 jobs, chaque job a son `resultPath` distinct. Validation end-to-end (§19.1 "N ≥ 5 jobs"). |
| T-AB-08 | 20 jobs (stress) | Performance raisonnable (< 100ms pour build). Tous les chemins corrects et disjoints. |

### 14.4 Propriétés

- **P-AB-a** : `buildManifest` est pure.
- **P-AB-b** : chaque job `resultPath` est de la forme `<runDir>/results/<label>-<attempt>/<jobId>.json` (dossier par attempt, fichier par jobId).
- **P-AB-c** : les chemins de 2 jobs distincts sont disjoints.

---

## 15. Tests du runOrchestrator — flow initial happy path (`tests/engine/run-initial-happy-path.test.ts`)

Référence : §14.1.

Setup commun : `mock-fs` avec RUN_DIR vide, `mock-clock` initialisé, `mock-stdio` pour capturer stdout/stderr, config jouet avec 3 phases (`a → b → c`).

### 15.1 Flow minimal : une phase qui done immédiatement

| ID | Config | Comportement vérifié |
| --- | --- | --- |
| T-RO-01 | `phases: { a: async (s, io) => io.done({ result: "hello" }) }`, `initial: "a"` | Émission `orchestrator_start` (events) → `phase_start` → phase exec → `phase_end` (resultKind: "done") → `orchestrator_end` (success: true). Bloc stdout `DONE` unique. Fichier `output.json` contient `{ result: "hello" }`. Exit code 0. Lock acquired puis released. |

### 15.1.bis Lock refresh à chaque phase-start (§4.13, §19.4)

| ID | Scénario | Vérification |
| --- | --- | --- |
| T-RO-01b | Run avec 5 transitions in-process (`a → b → c → d → e → done`). Inspecter le lock file avant/après chaque phase. | Avant chaque phase, `leaseUntilEpochMs` du lock est ré-écrit à `nowEpoch + DEFAULT_IDLE_LEASE_MS` (§14.1 step 16.b). 5 refresh total (un par phase-start). Pas de refresh sur `delegate/done/fail` exit (le lock est release à la place). |
| T-RO-01c | Run avec 1 phase qui done. Lock refresh une seule fois (au démarrage de la phase unique). | Vérifié via inspection séquentielle. |

### 15.2 Flow avec transitions in-process (pas de délégation)

| ID | Config | Vérification |
| --- | --- | --- |
| T-RO-02 | `a → b → c → done`. Chaque phase retourne `io.transition(nextPhase, newState)`. | 3 events `phase_start`/`phase_end` (resultKind: `"transition"`, `"transition"`, `"done"`). Un seul bloc stdout `DONE`. `state.phasesExecuted === 3`. `state.currentPhase === "c"` au moment du done. |
| T-RO-03 | Phase `a` fait `io.transition("b", { count: 1 })` + phase `b` reçoit state avec `count === 1` | Effectivement reçu |
| T-RO-04 | Phase `a` fait `io.transition("b", {}, "input-data")` ; `b(state, io, input)` reçoit `input === "input-data"` | Vérifié (canal in-process, §6.2) |

### 15.3 Flow avec une délégation skill

| ID | Config / Scénario | Vérification |
| --- | --- | --- |
| T-RO-05 | Phase `a` fait `io.delegateSkill({ kind: "skill", skill: "foo", label: "bar" }, resumeAt: "b")` | Bloc stdout `DELEGATE` unique avec `kind: skill`, `manifest` pointe sur `delegations/bar-0.json` qui existe, `resume_cmd` = `config.resumeCommand(runId)`. State persisté avec `pendingDelegation: { label: "bar", kind: "skill", resumeAt: "b", attempt: 0, ... }`. Exit code 0. Lock released. |
| T-RO-06 | Écriture atomique de state + manifest | Ni `state.json.tmp` ni `delegations/bar-0.json.tmp` ne subsistent |
| T-RO-07 | Registre `usedLabels` | `state.usedLabels === ["bar"]` post-emit |

### 15.4 Flow avec une délégation agent unique

| ID | Config / Scénario | Vérification |
| --- | --- | --- |
| T-RO-08 | Phase `a` fait `io.delegateAgent({ kind: "agent", agentType: "reviewer", prompt: "p", label: "rev" }, resumeAt: "b")` | Bloc `DELEGATE kind: agent`, manifest avec `agentType`, `prompt`, `resultPath: results/rev-0.json` |

### 15.5 Flow avec une délégation agent-batch

| ID | Scénario | Vérification |
| --- | --- | --- |
| T-RO-09 | `delegateAgentBatch` avec 3 jobs | Bloc `DELEGATE kind: agent-batch`, manifest avec `jobs: [...]`. Chaque job a son `resultPath` per-jobId dans `results/<label>-0/<jobId>.json`. `state.pendingDelegation.jobIds === ["j1", "j2", "j3"]`. |

### 15.6 Génération et adoption du runId

| ID | Scénario | Vérification |
| --- | --- | --- |
| T-RO-10 | Mode initial, pas de `--run-id` dans argv | RunId généré via ULID (§14.1 step 3). Répercuté dans events + RUN_DIR + protocole |
| T-RO-11 | Mode initial, `--run-id 01HX...` dans argv | RunId adopté, pas généré (testable pour tests déterministes) |
| T-RO-12 | RunId fourni invalide (non-ULID) | **DÉCISION** : accepté tel quel (pas de validation format en v1, l'utilisateur est responsable). Throw si format réel casse autre chose. |

### 15.7 Observabilité events

| ID | Scénario | Events attendus dans l'ordre |
| --- | --- | --- |
| T-RO-13 | `a → done` simple | `[orchestrator_start, phase_start(a, attempt 1), phase_end(a, resultKind: done), orchestrator_end]` |
| T-RO-14 | `a → b → done` | `[orch_start, phase_start(a), phase_end(a, transition), phase_start(b), phase_end(b, done), orch_end]` |
| T-RO-15 | `a → delegate → exit` | `[orch_start, phase_start(a), delegation_emit, phase_end(a, delegate), /* orch_end émis au moment de l'exit, cohérent avec §11.3 */]` — **DÉCISION** : `orchestrator_end` **est émis à tout exit réussi d'une invocation, même si le run continue** ? NON — le run dans la sémantique §4.6 est de `orchestrator_start` à `orchestrator_end`. Entre les deux, chaque invocation peut exit sans `orchestrator_end`. **L'invocation initiale avec delegate exit émet : [orch_start, phase_start, delegation_emit, phase_end]**. Pas d'`orchestrator_end` (le run continue cross-process). L'`orchestrator_end` est émis uniquement à l'invocation qui termine (DONE/ERROR/ABORTED). Cohérent avec §4.6 et §19.3. |

### 15.8 Output final et state initial persisté

Référence : §6.4, §14.1 step 13.

| ID | Scénario | Vérification |
| --- | --- | --- |
| T-RO-16 | Phase `a` retourne `io.done({ result: "x", nested: { n: 42 } })` | Fichier `$RUN_DIR/output.json` créé, contient exactement `{ result: "x", nested: { n: 42 } }`. Atomic write (pas de `output.json.tmp` résiduel). |
| T-RO-17 | Run initial démarre, phase `a` pas encore exécutée | `state.json` est écrit **avant** le premier `phase_start` (step 13 avant step 16). Vérifié en inspectant l'ordre des writes. |
| T-RO-18 | `done.output` avec valeur non-JSON-sérialisable (fonction) | throw au JSON.stringify → capté par top-level handler → bloc ERROR `error_kind: phase_error`. — **DÉCISION** : la phase est responsable. Le runtime ne valide pas la JSON-sérialisabilité avant, mais throw naturellement au write. |
| T-RO-19 | `done.output` avec `undefined` comme valeur top-level | **DÉCISION** : accepté, `output.json` contient `null` ou `{}` selon implémentation JSON.stringify. Test accepte `null` ou `{}`. |

### 15.9 Policy defaults

Référence : §6.8, §9.2, §9.3.

| ID | Scénario | Vérification |
| --- | --- | --- |
| T-RO-20 | Config sans `retry` | Délégation émise utilise `maxAttempts: 3, backoffBaseMs: 1000, maxBackoffMs: 30000` (defaults §6.8). Validé via `state.pendingDelegation.effectiveRetryPolicy`. |
| T-RO-21 | Config sans `timeout` | `timeoutMs: 600000` (10 min, §9.3) dans manifest + `deadlineAtEpochMs = emittedAtEpochMs + 600000`. |
| T-RO-22 | Config sans `retentionDays` | Cleanup utilise 7 jours de défaut (§6.1). Testable via `cleanupOldRuns` call ou via observable effect. |
| T-RO-23 | Config sans `logging` | `LoggingPolicy` default : `enabled: true, persistEventLog: true, logger: stderr default`. Vérifié : stderr a les events, `events.ndjson` créé. |
| T-RO-24 | Config sans `stateSchema` | `state.data` opaque au runtime, arbitrary shape accepté au read/write (§7.1). |

### 15.10 Propriétés

- **P-RO-a** : mutation du state passé à la phase throw `TypeError` (deep-freeze, §6.2, §14.1 step 16.e).
- **P-RO-b** : tout run qui émet `orchestrator_start` émet `orchestrator_end` (pour l'invocation finale).
- **P-RO-c** : aucun bloc stdout n'est émis avant `orchestrator_start` (sauf pour les preflight errors, §19).

---

## 16. Tests du runOrchestrator — flow initial, sous-cas (`tests/engine/run-initial-happy-path.test.ts` suite)

### 16.1 Flow : phase retourne `io.fail(error)`

| ID | Scénario | Vérification |
| --- | --- | --- |
| T-RO-20 | Phase `a` retourne `io.fail(new PhaseError("boom"))` | Bloc `ERROR` avec `error_kind: phase_error`, `message: "boom"`, `phase: "a"`, `phases_executed: 1`. Event `phase_error` + `orchestrator_end` (success: false). Exit code 1. |
| T-RO-21 | Phase `a` retourne `io.fail(new Error("generic"))` | `error_kind: phase_error` (fallback kind pour Error générique) |

### 16.2 Flow : phase throw une exception

| ID | Scénario | Vérification |
| --- | --- | --- |
| T-RO-22 | Phase `a` throw `new Error("oops")` | Capturé par top-level handler (§4.4 C13). Bloc `ERROR` avec `error_kind: phase_error`, `message: "oops"`. Event `phase_error`. Lock released. Exit code 1. **La Promise `runOrchestrator()` résout**, elle ne rejette pas (§4.4). |
| T-RO-23 | Phase `a` throw un `OrchestratorError` sous-classe (`ProtocolError`) | Bloc `ERROR` avec `error_kind: protocol` |

### 16.3 Flow : single PhaseResult enforcement

| ID | Scénario | Vérification |
| --- | --- | --- |
| T-DF-01 | Phase appelle `io.transition(...)` puis `io.done(...)` dans la même phase | Le second appel throw `ProtocolError("PhaseResult already committed")`. L'engine capture → bloc `ERROR error_kind: protocol` |
| T-DF-02 | Phase appelle `io.delegateSkill(...)` puis `io.fail(...)` | Second appel throw `ProtocolError` |
| T-DF-03 | Phase appelle `io.done(...)` seul | OK, un seul PhaseResult commit |

### 16.4 Flow : deep-freeze enforcement

| ID | Scénario | Vérification |
| --- | --- | --- |
| T-DF-04 | Phase reçoit state `{ a: 1 }` et fait `state.a = 2` | throw `TypeError` natif (strict mode + frozen object) |
| T-DF-05 | Phase fait `state.nested.b = 2` (nested) | throw `TypeError` (deep freeze récursif) |
| T-DF-06 | Phase fait `state.list.push(1)` | throw `TypeError` |
| T-DF-07 | Phase fait `const copy = structuredClone(state); copy.a = 2` | OK, copy est modifiable |
| T-DF-08 | Phase transition avec `io.transition("b", newState)` où `newState` diffère de `state` | OK, c'est le pattern attendu |

### 16.5 Flow : unicité des labels (usedLabels)

| ID | Scénario | Vérification |
| --- | --- | --- |
| T-RO-24 | Run avec 2 delegateSkill successifs avec labels différents | `state.usedLabels === ["label-1", "label-2"]` (append-only) |
| T-RO-25 | Run avec 2 delegateSkill successifs avec le même label | 2e appel throw `ProtocolError("duplicate label: X")`. Bloc `ERROR error_kind: protocol`. |
| T-RO-26 | Label re-utilisé entre deux runs différents (runId différents) | OK, chaque run a son propre `usedLabels` |
| T-RO-27 | Label invalide format (`"BAD_LABEL"`) | throw `ProtocolError` (kebab-case requis §6.5) |
| T-RO-28 | Label vide `""` | throw `ProtocolError` |

### 16.6 Flow : phases inconnues et références

| ID | Scénario | Vérification |
| --- | --- | --- |
| T-RO-29 | `config.initial === "x"` mais `phases.x` absent | Preflight `InvalidConfigError` (§6.1) → bloc ERROR preflight |
| T-RO-30 | `io.transition("unknown", ...)` | throw interne `ProtocolError("unknown phase: unknown")` → bloc ERROR |
| T-RO-31 | `io.delegateSkill({..., resumeAt: "unknown"})` | throw interne `ProtocolError` |

### 16.7 Flow : state JSON-sérialisable (§4.2)

| ID | Scénario | Vérification |
| --- | --- | --- |
| T-RO-32 | Phase retourne `io.transition("b", { fn: () => 1 })` (fonction dans state) | Au `writeStateAtomic`, JSON.stringify ignore la fonction → state écrit sans `fn` → `readState` au resume reconstruit `{}` sans `fn`. **DÉCISION NIB-T** : comportement par défaut de `JSON.stringify` (fonctions omises silencieusement). Le runtime n'alerte pas. Invariant documentaire (§4.2), pas enforced. |
| T-RO-33 | Phase retourne state avec `Map` ou `Set` | JSON.stringify produit `{}` pour Map/Set natif → perte silencieuse de data. Même DÉCISION. |
| T-RO-34 | Phase retourne state avec référence circulaire | `JSON.stringify` throw `TypeError` → capté par top-level handler → bloc ERROR `error_kind: phase_error`. |
| T-RO-35 | Phase retourne state avec `Date` natif | `JSON.stringify` sérialise en ISO string. Au resume, `state.data.date` est une **string**, pas un `Date`. Discipline auteur (§16.1). Test vérifie la transformation. |

### 16.8 Flow : `input` in-process only (non-persistence à travers délégation)

Référence : §6.2, C11.

| ID | Scénario | Vérification |
| --- | --- | --- |
| T-RO-36 | Phase `a` → `io.transition("b", newState, "my-input")`. Phase `b` reçoit `input === "my-input"` (in-process). | ✅ Passe in-process. |
| T-RO-37 | Phase `a` → `io.transition("b", newState, "my-input")`. Phase `b` délègue via `delegateSkill`, process exit. Resume : phase `b` (resumeAt) ne reçoit **pas** `input` (input === undefined). | Vérifié : `input` n'est pas persisté dans `state.json` ni dans `pendingDelegation`. Discipline C11. |
| T-RO-38 | Phase `a` transition avec input complexe `{ big: "obj" }`. Phase `b` consomme sans délégation. | Transition in-process = OK. |

### 16.9 Flow : unicité `jobs[].id` dans un batch (engine-level)

Référence : §6.5.

| ID | Scénario | Vérification |
| --- | --- | --- |
| T-RO-39 | `delegateAgentBatch` avec `jobs: [{id: "j1", ...}, {id: "j1", ...}]` (ID dupliqué) | Engine throw `ProtocolError("duplicate job id in batch: j1")` avant d'écrire le manifest. Bloc ERROR `error_kind: protocol`. Exit 1. |
| T-RO-40 | `delegateAgentBatch` avec `jobs: [{id: "j1"}, {id: "j2"}, {id: "j3"}]` | OK, manifest écrit. |

### 16.10 Flow : configuration figée au run-init (§4.8)

| ID | Scénario | Vérification |
| --- | --- | --- |
| T-RO-41 | Appeler `runOrchestrator(config)` avec config qui est ensuite modifiée (config.retry.maxAttempts = 99 après le call). | Le runtime utilise le snapshot initial (maxAttempts = valeur au moment du call). La modification post-runOrchestrator n'a aucun effet. — **DÉCISION** : teste le cas "config passée par référence, mutation externe" via `Object.freeze` ou snapshot interne. |
| T-RO-42 | Délégation avec `request.retry` override partiel (ex. seulement `maxAttempts: 5`) | `effectiveRetryPolicy.maxAttempts === 5`, `effectiveRetryPolicy.backoffBaseMs === config.retry.backoffBaseMs ?? default`, `effectiveRetryPolicy.maxBackoffMs === config.retry.maxBackoffMs ?? default`. Résolution champ par champ (M26). |
| T-RO-43 | Override avec `request.retry = { maxAttempts: 5, backoffBaseMs: 500, maxBackoffMs: 10000 }` total | Tous les champs remplacés. |
| T-RO-44 | Override vide `request.retry = {}` | Tous les defaults hérités via chaîne `config.retry?.X ?? default`. |

---

## 17. Tests du runOrchestrator — flow resume (`tests/engine/run-resume-happy-path.test.ts`)

Référence : §14.2.

Setup : RUN_DIR préexistant avec `state.json` où `pendingDelegation` est défini, manifest correspondant, et fichier résultat.

### 17.1 Resume happy path — délégation skill

| ID | Scénario | Vérification |
| --- | --- | --- |
| T-RS-01 | argv = `--run-id 01HX --resume`. State a `pendingDelegation: { label: "foo", kind: "skill", resumeAt: "b", attempt: 0, deadlineAtEpochMs: nowEpoch + 300000, effectiveRetryPolicy }`. `results/foo-0.json` contient `{ verdict: "clean" }`. Phase `b` appelle `io.consumePendingResult(z.object({ verdict: z.string() }))` et fait `io.done({ ok: true })`. | Ordre events : `[orch_start, phase_start(b), delegation_result_read(label: "foo", jobCount: 1, filesLoaded: 1), delegation_validated(label: "foo"), phase_end(b, done), orch_end(success: true)]`. Bloc stdout `DONE`. `state.pendingDelegation === undefined` dans state final. Lock acquired puis released. |
| T-RS-02 | Resume, phase appelle `consumePendingResult` avec schéma valide | Event `delegation_validated` émis. Phase reçoit data typée. |
| T-RS-03 | Resume, phase appelle `consumePendingResult` avec schéma qui rejette | Event `delegation_validation_failed` émis. `DelegationSchemaError` thrown dans la phase → catch par engine → si retry possible, retry. Sinon bloc ERROR. |

### 17.2 Resume happy path — délégation agent-batch

| ID | Scénario | Vérification |
| --- | --- | --- |
| T-RS-04 | State avec `pendingDelegation: { kind: "agent-batch", jobIds: ["j1","j2","j3"], attempt: 0, ... }`. 3 fichiers résultat présents. Phase appelle `consumePendingBatchResults(schema)`. | Reçoit `readonly T[]` de longueur 3, aligné sur ordre de `jobIds`. `delegation_result_read` avec `jobCount: 3, filesLoaded: 3`. `delegation_validated` unique (pas un par job, §11.3). |
| T-RS-05 | Wrong-kind : phase appelle `consumePendingResult` alors que `kind: "agent-batch"` | Immediate throw `ProtocolError("use consumePendingBatchResults for batch delegations")`. Bloc ERROR. |
| T-RS-06 | Inverse : phase appelle `consumePendingBatchResults` alors que `kind: "skill"` | Immediate throw `ProtocolError("use consumePendingResult for single delegations")` |

### 17.3 Resume — consumption check (§14.1 step 16.l)

| ID | Scénario | Vérification |
| --- | --- | --- |
| T-CS-01 | Phase de reprise ne consomme pas (consumedCount = 0) et transitionne | Post-phase check échoue → bloc `ERROR error_kind: protocol`, message: `"unconsumed delegation: <label>"`. Exit 1. |
| T-CS-02 | Phase appelle `consumePendingResult` deux fois | Le 2e appel throw `ProtocolError("multiple consume calls on same delegation: <label>")` — throw immédiat en §14.1 step 16.f. Bloc ERROR. |
| T-CS-03 | Phase consomme correctement 1 fois | Post-phase check passe, flow continue normalement. |
| T-CS-04 | Phase mixe `consumePendingResult` + `consumePendingBatchResults` (wrong-kind au premier) | T-RS-05 s'applique : throw immédiat |
| T-CS-05 | Phase consomme puis throw une exception | consumedCount === 1 OK, mais la phase a failli → bloc ERROR avec `error_kind: phase_error`. Le consumption check ne déclenche pas. |

### 17.4 Resume — deadline check (§14.2 step 12)

| ID | Scénario | Vérification |
| --- | --- | --- |
| T-RS-10 | `nowEpoch < deadlineAtEpochMs`, tous résultats présents et parseables | `allParseable === true` → step 13 (continuer). Aucune erreur de deadline même si proche. |
| T-RS-11 | `nowEpoch > deadlineAtEpochMs`, résultats absents | `allPresent === false && deadlinePassed === true` → `DelegationTimeoutError`. Retry selon policy. |
| T-RS-12 | `nowEpoch > deadlineAtEpochMs`, résultats présents et parseables | `allParseable === true` → continuer (deadline ignorée, cohérent §14.2 step 12.d). Raison : le résultat est arrivé, peu importe que ce soit juste après la deadline. |
| T-RS-13 | `nowEpoch < deadlineAtEpochMs`, résultats absents | `allPresent === false && deadlinePassed === false` → `DelegationMissingResultError` (bug parent agent, pas de retry automatique). Bloc ERROR. |

### 17.5 Resume — malformed JSON detection

| ID | Scénario | Vérification |
| --- | --- | --- |
| T-RS-14 | `results/foo-0.json` présent mais JSON malformé (trailing comma) | `anyMalformed === true` → `DelegationSchemaError` immédiat. Retry selon policy. Logger loggue `path` et `fileSizeBytes`, **pas** le contenu (C10). |
| T-RS-15 | `results/foo-0.json` présent mais vide (0 bytes) | Compté comme malformed (JSON vide n'est pas JSON parseable) |
| T-RS-16 | `results/foo-0.json` présent avec HTML (`<html>...</html>`) | Malformed, même traitement |
| T-RS-17 | Batch avec 2 parseable + 1 malformed | `anyMalformed === true` (quel que soit le reste) → `DelegationSchemaError` |
| T-RS-18 | Batch avec 2 parseable + 1 missing | `allPresent === false`, `anyMalformed === false`. Deadline check détermine : deadline passée → timeout, sinon → missing |

### 17.6 Resume — validation du state au read

| ID | Scénario | Vérification |
| --- | --- | --- |
| T-RS-19 | `state.runId !== argv.runId` (mismatch) | Bloc ERROR preflight `error_kind: protocol`, message: `"RUN_DIR mismatch with argv — likely wrong cwd or corrupted state"` (§14.2 step 7) |
| T-RS-20 | `state.orchestratorName !== config.name` | Bloc ERROR preflight `error_kind: protocol` |
| T-RS-21 | `state.json` absent mais `--resume` fourni | Bloc ERROR preflight `error_kind: state_missing` |
| T-RS-22 | `state.json` avec `schemaVersion: 2` | Bloc ERROR preflight `error_kind: state_version_mismatch` |
| T-RS-23 | `state.json` corrompu (JSON invalide) | Bloc ERROR preflight `error_kind: state_corrupted` |

### 17.7 Resume — timing d'effacement de `pendingDelegation`

Référence : §7.1, §14.2 step 14, §14.3, M14.

| ID | Scénario | Vérification |
| --- | --- | --- |
| T-RS-24 | Phase consume puis transition → state persisté au step 16.n avec `pendingDelegation: undefined` | Vérifié en lisant state.json après le write atomique |
| T-RS-25 | Phase consume, puis throw mid-phase | `pendingDelegation` toujours présent dans state (crash mid-phase préserve le pending pour retry) |
| T-RS-26 | Phase consume, puis done | State persisté avec `pendingDelegation: undefined` |

### 17.8 Multi-delegation sequence (§19.1)

| ID | Scénario | Vérification |
| --- | --- | --- |
| T-RS-27 | Run avec 3 délégations successives dans un même run (invocation initiale émet DELEGATE 1 → resume consomme et émet DELEGATE 2 → resume consomme et émet DELEGATE 3 → resume consomme et done). | 3 blocs DELEGATE + 1 bloc DONE au total. 4 invocations process. Chaque `resume_cmd` relance correctement. `state.usedLabels` final contient les 3 labels dans l'ordre. `events.ndjson` contient la séquence complète. |
| T-RS-28 | Séquence mixte : DELEGATE skill → DELEGATE agent → DELEGATE agent-batch → DONE | Chaque kind fonctionne. `state.pendingDelegation.kind` change correctement. Consumption typée fonctionne pour chaque kind. |

### 17.9 Edge cases au resume

| ID | Scénario | Vérification |
| --- | --- | --- |
| T-RS-29 | `--resume` fourni mais `state.pendingDelegation === undefined` (cas impossible en flow nominal, bug défensif) | throw interne `ProtocolError("resume without pending delegation")` → bloc ERROR `error_kind: protocol`. Exit 1. (§14.2 step 11.b) |
| T-RS-30 | Resume après un premier retry réussi : `state.pendingDelegation.attempt === 1`, résultats présents à `results/<label>-1.json`, parseable | Consommation OK. Events `delegation_result_read` + `delegation_validated`. Flow continue. |
| T-RS-31 | Resume, résultats présents à `<label>-0.json` (attempt N-1) mais `pd.attempt === 1` | Le runtime lit uniquement `<label>-1.json`. `<label>-0.json` ignoré (per-attempt isolation §19). Si `<label>-1.json` absent et deadline dépassée → timeout. |

### 17.10 Propriétés

- **P-RS-a** : `pendingDelegation` présent dans state au début de la phase de reprise, `undefined` après traitement du PhaseResult (uniquement si phase a réussi).
- **P-RS-b** : tout resume qui succeed émet exactement un `delegation_result_read` + un `delegation_validated` (ou un `delegation_validation_failed` si le consume fail).
- **P-RS-c** : les fichiers `results/<label>-<attempt>.json` (ou `<label>-<attempt>/<jobId>.json`) sont lus une seule fois par invocation (pas de re-read).
- **P-RS-d** : pour un run avec N délégations successives, le `runId` est le même dans tous les events, state, manifests et blocs protocole.

---

## 18. Tests du retry post-délégation (`tests/engine/run-retry-schema.test.ts`, `run-retry-timeout.test.ts`)

Référence : §8.2, §9.3, §14.1 step 16.i catch, §14.2 step 12.e.

### 18.1 Retry après DelegationSchemaError — budget disponible

| ID | Scénario | Vérification |
| --- | --- | --- |
| T-RT-01 | Resume, `consumePendingResult` échoue validation (schema fail) dans phase. `pd.attempt === 0`, `effectiveRetryPolicy.maxAttempts === 3`. | Engine catch DelegationSchemaError → `resolveRetryDecision` → `retry: true, delayMs: 1000`. Event `retry_scheduled` (attempt: 1, delayMs: 1000, reason: "delegation_schema"). `abortableSleep(1000)`. Reconstruction manifest : `results/<label>-1.json` et `delegations/<label>-1.json` nouveaux. State persisté avec `pd.attempt === 1, pd.manifestPath` nouveau, `pd.effectiveRetryPolicy` inchangé. Event `delegation_emit`. Bloc `DELEGATE` (nouveau manifest path, resumeCmd inchangé). Exit 0. Lock released. |

### 18.2 Retry après DelegationTimeoutError — budget disponible

| ID | Scénario | Vérification |
| --- | --- | --- |
| T-RT-02 | Resume, `allPresent === false && deadlinePassed === true`. `pd.attempt === 0`, maxAttempts 3. | Engine : `DelegationTimeoutError` → retry. Event `retry_scheduled` (reason: "delegation_timeout"). Reconstruction identique à T-RT-01 (chemins per-attempt, deadline recalculé per-attempt `newDeadlineAtEpochMs = newEmittedAtEpochMs + oldManifest.timeoutMs`). |

### 18.3 Retry exhausted

| ID | Scénario | Vérification |
| --- | --- | --- |
| T-RT-03 | `pd.attempt === 2`, `maxAttempts === 3`. `consumePendingResult` fail validation. | `resolveRetryDecision` → `retry: false, reason: "retry_exhausted"`. Bloc `ERROR error_kind: delegation_schema`, message contient "after 3 retries" (ou équivalent). Exit 1. |
| T-RT-04 | `pd.attempt === 2`, `maxAttempts === 3`. Deadline passé. | Bloc `ERROR error_kind: delegation_timeout`. |
| T-RT-05 | `maxAttempts === 1`, `attempt === 0`. Fail validation. | `attempt + 1 === maxAttempts` → pas de retry. Bloc ERROR immédiat. |

### 18.4 Retry reconstruction — cohérence avec ancien manifest

Référence : M13, §14.1 step 16.i catch.

| ID | Scénario | Vérification |
| --- | --- | --- |
| T-RT-06 | Retry d'une skill delegation avec `skillArgs: { path: "src/" }` | Nouveau manifest a les mêmes `skill`, `skillArgs`, `timeoutMs`. Seuls `attempt`, `emittedAt`, `emittedAtEpochMs`, `deadlineAtEpochMs`, `resultPath` changent. |
| T-RT-07 | Retry d'une agent-batch avec 3 jobs | Nouveau manifest a les mêmes `jobs[i].prompt`, nouveaux `jobs[i].resultPath` per-attempt dans `results/<label>-1/<jobId>.json` |
| T-RT-08 | `effectiveRetryPolicy` capturée à l'émission initiale avec override partiel | Persistée dans `pd.effectiveRetryPolicy` post-retry, réutilisée au retry suivant. Pas de "perte de policy cross-process" (M26). |

### 18.5 Retry preserves usedLabels

| ID | Scénario | Vérification |
| --- | --- | --- |
| T-RT-09 | Retry d'une délégation avec label `"foo"` | `state.usedLabels` reste `["foo"]` (pas de double-ajout) |
| T-RT-10 | 2 retries successifs (attempt 0 → 1 → 2) + délégation suivante avec nouveau label `"bar"` | `usedLabels === ["foo", "bar"]` au moment de la délégation `bar` |

### 18.6 Propriétés

- **P-RT-a** : pour tout retry, `newDeadlineAtEpochMs > oldDeadlineAtEpochMs` (nouvelle deadline strictement dans le futur de l'ancienne, modulo clock mock).
- **P-RT-b** : `effectiveRetryPolicy` persisté est invariant cross-retry (jamais ré-résolu).
- **P-RT-c** : pour tout retry, `pd.label` et `pd.resumeAt` sont inchangés.

---

## 19. Tests du flow : per-attempt result paths isolation (`tests/engine/run-per-attempt-isolation.test.ts`)

Référence : §7.2, M6.

### 19.1 Isolation structurelle

| ID | Scénario | Vérification |
| --- | --- | --- |
| T-RO-40 | Attempt 0 échoue (timeout). Attempt 1 relance. Un sub-agent orphelin de l'attempt 0 écrit tardivement `results/<label>-0.json`. Resume de l'attempt 1 regarde `results/<label>-1.json`. | Attempt 1 **ne voit pas** le fichier orphelin. Chemins disjoints. |
| T-RO-41 | Batch : attempt 0 a 3 jobs. Attempt 1 relance. Un job orphelin de l'attempt 0 écrit `results/<label>-0/j1.json`. | Attempt 1 lit `results/<label>-1/*.json`. Pas de pollution. |
| T-RO-42 | Manifests antérieurs préservés | `delegations/<label>-0.json` existe toujours post-retry. Pas nettoyé par le runtime. |

### 19.2 Propriétés

- **P-RO-d** : pour tout `(label, attempt1, attempt2)` avec `attempt1 !== attempt2`, les chemins de résultat sont strictement disjoints (aucun overlap).

---

## 20. Tests des préflight errors (`tests/engine/run-preflight-errors.test.ts`)

Référence : §4.4, §14.1 step 1-2, §14.2 step 1-7, §7.4.3.

### 20.1 Config invalide

| ID | Config fautive | Bloc ERROR attendu |
| --- | --- | --- |
| T-PF-01 | `name: ""` | `run_id: null`, `error_kind: invalid_config`, message mentionne "name" |
| T-PF-02 | `name: "BAD_NAME"` (pas kebab-case) | `error_kind: invalid_config`, message mentionne regex |
| T-PF-03 | `phases: {}` | `error_kind: invalid_config` |
| T-PF-04 | `initial: "x"` absent de `phases` | `error_kind: invalid_config` |
| T-PF-05 | `initialState` absent | `error_kind: invalid_config`, message mentionne "initialState" (M20) |
| T-PF-06 | `resumeCommand` absent | `error_kind: invalid_config`, message mentionne "resumeCommand" (M18) |
| T-PF-07 | `resumeCommand` non-function | `error_kind: invalid_config` |
| T-PF-08 | `stateSchema` fourni, `initialState` non conforme | `error_kind: invalid_config` (échoue à la validation initial, §14.1 step 12) |

### 20.2 Resume avec state invalide

| ID | Situation | Bloc ERROR attendu |
| --- | --- | --- |
| T-PF-09 | `--resume` sans `--run-id` | `run_id: null`, `error_kind: invalid_config`, message: `"--resume requires --run-id"` |
| T-PF-10 | RUN_DIR absent | `error_kind: state_missing`, `run_id: <runId>` (runId connu depuis argv) |
| T-PF-11 | `state.json` corrompu | `error_kind: state_corrupted` |
| T-PF-12 | `state.json` version mismatch | `error_kind: state_version_mismatch` |
| T-PF-13 | `state.runId !== argv.runId` | `error_kind: protocol` |

### 20.3 Préflight errors n'émettent pas events

| ID | Scénario | Vérification |
| --- | --- | --- |
| T-PF-14 | Config invalide | Aucun event dans `events.ndjson` (le fichier n'est pas créé). Stderr peut contenir un event `phase_error` si le stderr logger est déjà installé, **mais** §C12 / §14.1 step 6 dit : stderr logger installé avant preflight, donc oui les préflight errors vont sur stderr. **DÉCISION** : stderr a l'event `phase_error`, `events.ndjson` n'existe pas. |
| T-PF-15 | Preflight error → pas de `orchestrator_start` émis (ni stderr ni disque) | Invariant §4.6 |
| T-PF-16 | Preflight error → pas de `orchestrator_end` émis | Invariant §4.6 (run non démarré) |

### 20.4 Exit codes preflight

| ID | Scénario | Exit code |
| --- | --- | --- |
| T-PF-17 | `invalid_config` | 1 |
| T-PF-18 | `state_missing` | 1 |
| T-PF-19 | `state_corrupted` | 1 |
| T-PF-20 | `state_version_mismatch` | 1 |
| T-PF-21 | `RunLockedError` (active lock) | 2 (§14.1 step 7) |

---

## 21. Tests des signaux OS (`tests/engine/run-signals.test.ts`)

Référence : §13.

### 21.1 SIGINT pendant une phase mécanique

| ID | Scénario | Vérification |
| --- | --- | --- |
| T-SG-01 | Phase `a` fait `await longAsyncWork()`. SIGINT envoyé pendant l'attente. | `io.signal` abort. Phase interrompue (si elle respecte `io.signal`). Handler émet event `phase_error` (message: "Received SIGINT") + `orchestrator_end` (success: false). Bloc `ABORTED` avec `signal: SIGINT`. Lock released. Exit code 130. |
| T-SG-02 | Phase ne respecte pas `io.signal` et continue | Handler attend la fin naturelle de la phase puis émet ABORTED (best-effort, discipline auteur). — **DÉCISION NIB-T** : test vérifie uniquement le cas où `io.signal` est respecté (idéal). Le cas indiscipliné est hors scope (comportement hardware-level). |
| T-SG-03 | SIGTERM | Idem SIGINT mais `signal: SIGTERM`, exit code 143 |

### 21.2 SIGINT pendant un sleep de retry

| ID | Scénario | Vérification |
| --- | --- | --- |
| T-SG-04 | Retry scheduled avec delayMs 5000. SIGINT à 1000ms. | `abortableSleep` reject `AbortedError`. Engine catch → émet ABORTED (pas retry). Lock released. Exit 130. |

### 21.3 State préservé à la dernière transition stable

| ID | Scénario | Vérification |
| --- | --- | --- |
| T-SG-05 | Run avec 2 transitions stables (`a → b → c`) puis SIGINT pendant `c` | `state.json` à la valeur de la fin de `b` (dernière transition stable). L'utilisateur peut relancer avec `--resume`. |

### 21.4 Lock release à l'abort

| ID | Scénario | Vérification |
| --- | --- | --- |
| T-SG-06 | SIGINT pendant une phase, ownerToken match | Lock file supprimé. Pas d'event `lock_conflict`. |
| T-SG-07 | SIGINT, ownerToken ne match pas (volé) | Event `lock_conflict` (reason: "stolen_at_release"). Pas d'unlink. |
| T-SG-08 | SIGKILL (simulé, process mort sans handler) | Aucune émission. Lock file subsiste. Expire via lease idle (30 min) pour permettre une relance. |

### 21.5 Handler SIGINT/SIGTERM release lock avant exit (§13.2 step 4, C4)

| ID | Scénario | Vérification |
| --- | --- | --- |
| T-SG-09 | SIGINT reçu. Le handler appelle `releaseLockIfOwner()`. ownerToken match → unlink `.lock`. | Après exit, `.lock` absent. Aucun résidu. Sequence d'events : `phase_error` ("Received SIGINT") → `orchestrator_end` (success: false) → bloc ABORTED → release lock → exit 130. |
| T-SG-10 | SIGINT reçu, mais le lock a été volé (ownerToken différent dans `.lock`) | Event `lock_conflict` (reason: "stolen_at_release") émis. Pas d'unlink. Exit 130 quand même. |
| T-SG-11 | SIGINT pendant un sleep de retry actif | `abortableSleep` reject `AbortedError`. Handler execute : phase_error + orchestrator_end + ABORTED + release lock + exit 130. |

### 21.6 Propriétés

- **P-SG-a** : pour tout SIGINT/SIGTERM, exit code ∈ {130, 143}.
- **P-SG-b** : pour tout abort via signal, le bloc protocole est `ABORTED` (jamais `ERROR` ni `DONE`).
- **P-SG-c** : pour tout abort via signal avec ownerToken match, `.lock` est absent post-exit.

---

## 22. Tests de la composition récursive (`tests/engine/run-composition.test.ts`)

Référence : §15.3.

### 22.1 Orchestrateur A délègue à skill B (orchestrateur)

| ID | Scénario | Vérification |
| --- | --- | --- |
| T-CP-01 | A utilise `delegateSkill` avec skill=B. B est un orchestrateur imbriqué qui lui-même délègue (agent-batch). L'agent parent simule la boucle §15.1 récursivement. | A émet DELEGATE(skill=B). Parent invoque B. B émet DELEGATE(agent-batch). Parent invoque N agents. Parent relance B → B émet DONE (écrit à resultPath de A). Parent relance A (via resume_cmd) → A lit le résultat de B via `consumePendingResult` → A continue. |
| T-CP-02 | runIds distincts pour A et B | Vérifié : chaque orchestrateur a son propre runId indépendant, ses propres events, son propre RUN_DIR |
| T-CP-03 | Locks distincts | A et B ont leurs `.lock` respectifs dans leurs RUN_DIR respectifs. Pas de contention. |

### 22.2 Propriétés

- **P-CP-a** : la composition récursive ne modifie pas le contrat public de A ou B (transparence).
- **P-CP-b** : les events `runId` de A et B sont disjoints.

---

## 22.bis Tests du modèle temporel (`tests/temporal/temporal.test.ts`)

Référence : §12 (intégralité), spécialement §12.4 "Tests critiques".

### 22.bis.1 Cumul durée cross-reentry (§12.4)

| ID | Scénario | Vérification |
| --- | --- | --- |
| T-TM-01 | Run qui s'étale sur 3 invocations. Invocation 1 : phase `a` (durée mono 100ms) + delegate. Invocation 2 : resume phase `b` (durée mono 200ms) + delegate. Invocation 3 : resume phase `c` (durée mono 150ms) + done. Le mock `performance.now()` est **reset** entre chaque invocation (simule qu'on est dans un nouveau process). | `state.accumulatedDurationMs` final === `100 + 200 + 150 === 450`. Pas de double-comptage. Pas de tentative de reconstitution monotonic cross-process. |
| T-TM-02 | Run avec 10 transitions intra-process (1 seule invocation, pas de délégation). Chaque phase a une durée monotonic distincte (10ms, 20ms, ..., 100ms). | `state.accumulatedDurationMs === sum = 550`. Stable cross-invocation car accumulation se fait au state write. |
| T-TM-03 | `orchestrator_end.durationMs` au done final cross-reentry | Égal à `state.accumulatedDurationMs` accumulé jusque-là. |

### 22.bis.2 Deadline cross-reentry (§12.4)

| ID | Scénario | Vérification |
| --- | --- | --- |
| T-TM-04 | Délégation émise avec `timeoutMs: 1000`, `emittedAtEpochMs: 1000000`. Mock `nowEpochMs()` avance à `1002000` entre l'émission et la re-entry. Résultats absents. | Re-entry détecte `nowEpoch (1002000) > deadlineAtEpochMs (1001000)` → `DelegationTimeoutError`. Aucune tentative d'utiliser `performance.now()` cross-process. |
| T-TM-05 | Délégation émise à T0 avec `timeoutMs: 1000`. Re-entry à T0 + 500ms (avant deadline), résultats présents. | Flow continue, pas d'erreur. |
| T-TM-06 | Délégation à T0, re-entry à T0 + 1000ms exactement, résultats absents. | Strict `>` : `nowEpoch === deadlineAt` → **DÉCISION** : pas de timeout (deadline atteint mais pas dépassé). `DelegationMissingResultError` (pas de retry auto). — Alternative : `>=` strict. Test vérifie `>` strict cohérent avec spec §9.3 "durée max **entre** émission et disponibilité". |

### 22.bis.3 Clock jump immunité (§12.4)

| ID | Scénario | Vérification |
| --- | --- | --- |
| T-TM-07 | Pendant une phase, mock `nowWall()` jumpe en arrière de 10s (simulate NTP adjustment). Mock `nowMono()` continue normalement. | `phase_end.durationMs` positif, calculé via mono (pas wall). Deadline d'une délégation subséquente utilise wall-clock epoch courant (peut avoir bougé) mais reste cohérent. |
| T-TM-08 | Clock wall jumpe en avant de 10s | Même test, `phase_end.durationMs` ne reflète pas le jump. |
| T-TM-09 | Daylight saving time jump (+1h ou -1h) | Monotonic immunitaire. `state.accumulatedDurationMs` correct. |

### 22.bis.4 Discipline wall vs mono

| ID | Scénario | Assertion |
| --- | --- | --- |
| T-TM-10 | Inspection de `state.json` | Contient uniquement `startedAt` (ISO), `startedAtEpochMs` (number), `lastTransitionAt` (ISO), `lastTransitionAtEpochMs` (number), `accumulatedDurationMs` (number monotonic accumulé). **Aucun** champ `monotonicBase`, `monotonicOffset`, ou similaire. |
| T-TM-11 | Inspection d'un `manifest.json` | Contient uniquement `emittedAt` (ISO), `emittedAtEpochMs` (number), `deadlineAtEpochMs` (number). **Aucun** mono. |
| T-TM-12 | Inspection d'un event | `timestamp` est ISO. Pas de champ mono. `durationMs` dans `phase_end` / `orchestrator_end` calculé via mono mais stocké comme number. |

### 22.bis.5 Propriétés

- **P-TM-a** : `state.accumulatedDurationMs` est strictement croissant à chaque transition (jamais de régression).
- **P-TM-b** : pour tout event, `timestamp` est une ISO string UTC valide (suffix `Z`).
- **P-TM-c** : `emittedAtEpochMs` et `deadlineAtEpochMs` sont des entiers ≥ 0.
- **P-TM-d** : `deadlineAtEpochMs - emittedAtEpochMs === timeoutMs` (invariant deadline = emit + timeout, per-attempt).

---

## 23. Tests de l'observabilité — taxonomie d'events (`tests/observability/events-taxonomy.test.ts`)

Référence : §6.7, §11.3.

**[GREEN Layer 1 companion — §27.bis]** : `T-OB-01..13` sont des tests de forme (fixtures hardcodées inline, pas d'invocation runtime). Ils passent dès que les types d'events sont définis. Déplacés en §27.bis conformément à §0.4. La **couverture comportementale** des events émerge naturellement via les acceptance tests engine (§15-§22) qui vérifient les séquences d'events émis par `runOrchestrator`.

Ce qui reste **RED strict** dans cette section :

- §23.3 Property tests `P-OB-a..c` — testent des invariants sur des events réels émis par le runtime.
- Les tests PII (§25) et events.ndjson (§24) qui sollicitent le runtime.

### 23.1 [DÉPLACÉ §27.bis] Forme de chaque event (11 types)

Pour chaque type d'event, vérifier que `JSON.stringify(event)` est parseable et que les champs attendus sont présents avec les bons types.

| ID | eventType | Champs obligatoires vérifiés |
| --- | --- | --- |
| T-OB-01 | `orchestrator_start` | `runId`, `orchestratorName`, `initialPhase`, `timestamp` (ISO) |
| T-OB-02 | `phase_start` | `runId`, `phase`, `attemptCount`, `timestamp` |
| T-OB-03 | `phase_end` | `runId`, `phase`, `durationMs`, `resultKind` ∈ {"transition","delegate","done","fail"}, `timestamp` |
| T-OB-04 | `delegation_emit` | `runId`, `phase`, `label`, `kind`, `jobCount`, `timestamp` |
| T-OB-05 | `delegation_result_read` | `runId`, `phase`, `label`, `jobCount`, `filesLoaded`, `timestamp` |
| T-OB-06 | `delegation_validated` | `runId`, `phase`, `label`, `timestamp` |
| T-OB-07 | `delegation_validation_failed` | `runId`, `phase`, `label`, `zodErrorSummary` (≤ 200 chars), `timestamp` |
| T-OB-08 | `retry_scheduled` | `runId`, `phase`, `label`, `attempt`, `delayMs`, `reason`, `timestamp` |
| T-OB-09 | `phase_error` | `runId`, `phase`, `errorKind` ∈ OrchestratorErrorKind, `message` (≤ 200 chars), `timestamp` |
| T-OB-10 | `lock_conflict` | `runId`, `reason` ∈ {"expired_override","stolen_at_release"}, `currentOwnerToken?`, `timestamp` |
| T-OB-11 | `orchestrator_end` | `runId`, `orchestratorName`, `success`, `durationMs`, `phasesExecuted`, `timestamp` |

### 23.2 [DÉPLACÉ §27.bis] Fermeture de la taxonomie

| ID | Assertion |
| --- | --- |
| T-OB-12 | Tout event émis par le runtime a un `eventType` dans la liste des 11 types ci-dessus. |
| T-OB-13 | Aucun event avec `eventType === "unknown"` ou hors taxonomie. |

### 23.3 Propriétés

- **P-OB-a** : tout event est sérialisable en JSON (`JSON.stringify(event)` ne throw pas).
- **P-OB-b** : tout event a `runId` typé string non-vide (invariant §11.6).
- **P-OB-c** : tout `timestamp` est un ISO 8601 valide.

---

## 24. Tests de `events.ndjson` (`tests/observability/events-ndjson.test.ts`)

Référence : §7.5, §11.7, C14.

### 24.1 Création du fichier

| ID | Scénario | Vérification |
| --- | --- | --- |
| T-EV-01 | Run démarre avec `persistEventLog: true` (défaut) | `events.ndjson` créé au premier event émis par l'owner (typiquement `orchestrator_start`) |
| T-EV-02 | Run démarre avec `persistEventLog: false` | `events.ndjson` jamais créé |
| T-EV-03 | Run démarre avec `enabled: false` | Ni stderr ni `events.ndjson`. Le fichier n'est pas créé. |
| T-EV-04 | Contender bloqué sur RunLockedError | Pas d'écriture dans `events.ndjson` par ce contender. Le fichier (s'il existe, créé par l'owner) n'est pas modifié par le contender. |

### 24.2 Format NDJSON

| ID | Scénario | Vérification |
| --- | --- | --- |
| T-EV-05 | 5 events émis | `events.ndjson` contient 5 lignes, chacune terminée par `\n` |
| T-EV-06 | Chaque ligne | `JSON.parse(line)` produit un `OrchestratorEvent` valide |
| T-EV-07 | Pas de ligne vide | Aucune ligne vide ou whitespace-only |
| T-EV-08 | Encodage UTF-8 | Event contenant des caractères unicode (ex. français) correctement encodé |

### 24.3 Append-only (immuabilité)

| ID | Scénario | Vérification |
| --- | --- | --- |
| T-EV-09 | Après 5 events, émettre 3 nouveaux events → `events.ndjson` a 8 lignes | Les 5 premières lignes sont inchangées (octet par octet). |
| T-EV-10 | Crash / exit entre deux events | `events.ndjson` préservé, prochaine invocation append aux lignes existantes. |

### 24.4 Reconstruction du flux

Référence : §4.12, §7.5 invariant, §19.3.

| ID | Scénario | Vérification |
| --- | --- | --- |
| T-EV-11 | Run avec 5 phases et 2 délégations (une réussie, une retried) | Parsing de `events.ndjson` permet de reconstruire : ordre des phases, labels, tentatives, résultats (succès/retry), verdict final. Un test conformance parcourt et reconstitue. |
| T-EV-12 | `events.ndjson` ne contient **pas** `state.data` | Invariant §4.12 — aucun event n'a `state.data`. Parcourir les 11 types et vérifier l'absence. |

### 24.5 Owner-only (C14)

| ID | Scénario | Vérification |
| --- | --- | --- |
| T-EV-13 | Process A owner. Process B contender (RunLockedError). B n'écrit **jamais** dans `events.ndjson` de A. | Assertion : file size de `events.ndjson` à T0 (A a 5 events) = file size à T1 (B a tenté d'acquire et échoué). |
| T-EV-14 | Stderr toujours actif avant acquire | Le preflight error émis sur stderr, pas sur disque |

### 24.6 Propriétés

- **P-EV-a** : `events.ndjson` est strictement croissant en taille (append-only, jamais de décroissance).
- **P-EV-b** : l'ordre des lignes correspond à l'ordre d'émission des events (pas de réorganisation).
- **P-EV-c** : pour tout run qui émet N events, `events.ndjson` a exactement N lignes.

---

## 25. Tests PII (`tests/observability/pii.test.ts`)

Référence : §11.5, C10.

### 25.1 Absence de PII dans les events

| ID | Scénario | Assertion |
| --- | --- | --- |
| T-OB-20 | Run avec délégation skill `{ prompt: "super secret prompt" }` | Aucun event ne contient la string "super secret prompt". Seul `label` et `kind` apparaissent. |
| T-OB-21 | Run avec résultat skill `{ verdict: "CONFIDENTIAL" }` | Aucun event ne contient "CONFIDENTIAL". Même `delegation_validated` n'a pas de contenu. |
| T-OB-22 | Run avec malformed JSON result | Events `delegation_validation_failed` ou log équivalent contiennent `path` et `fileSizeBytes` mais **pas** de contenu du fichier ni du message d'erreur `JSON.parse`. |
| T-OB-23 | `phase_error.message` tronqué à 200 chars | Vérifié sur un message de 500 chars |

### 25.2 Propriétés

- **P-OB-d** : pour tout event émis dans un run jouet avec prompts/résultats marqués (strings canaries), aucune ligne de `events.ndjson` ni de stderr ne contient les canaries.

---

## 26. Property tests globaux (`tests/properties/properties.test.ts`)

Ces tests sont transversaux — ils mobilisent plusieurs modules ou vérifient des propriétés du runtime complet.

### 26.1 Stabilité du protocole

| ID | Assertion |
| --- | --- |
| P-01 | Pour un même scénario (config + argv + state disque + clock mocké), deux exécutions produisent exactement le même bloc stdout (même `run_id` si adopté via argv, mêmes champs, même ordre). Testé sur 5 scénarios types. |
| P-02 | Pour un même scénario, les événements `events.ndjson` sont identiques au byte près (sauf le timestamp qui est mocké). |

### 26.2 Idempotence du state

| ID | Assertion |
| --- | --- |
| P-03 | `readState(writeStateAtomic(state))` produit un state structurellement identique à `state`. Testé sur 20 states synthétiques. |
| P-04 | `writeStateAtomic` appelé deux fois avec le même state aboutit au même contenu de `state.json` (idempotence). |

### 26.3 Corrélation via runId

| ID | Assertion |
| --- | --- |
| P-05 | Tous les events émis lors d'un run (toutes invocations confondues) partagent le même `runId`. Testé sur un scénario avec 3 re-entries. |
| P-06 | Deux runs avec `runId` différents ne partagent aucun event (scoping strict). |

### 26.4 Mutex du lock

| ID | Assertion |
| --- | --- |
| P-07 | Sur 10 tentatives concurrentes d'acquire sur le même RUN_DIR, exactement un succède. Les 9 autres throw `RunLockedError`. |

### 26.5 Ordre des events

| ID | Assertion |
| --- | --- |
| P-08 | Pour tout run, `phase_start` précède toujours `phase_end` pour une même phase. |
| P-09 | `delegation_emit` précède toujours `delegation_result_read` pour un même label. |
| P-10 | `orchestrator_start` est toujours le premier event (pour un run qui n'est pas un preflight error). |
| P-11 | `orchestrator_end` est toujours le dernier event (pour une invocation terminale). |

### 26.6 Immunité aux clock jumps

| ID | Assertion |
| --- | --- |
| P-12 | Pour un mock clock qui jumpe en arrière de 10s pendant une phase, `phase_end.durationMs >= 0` toujours (monotonic indépendant). |
| P-13 | `state.accumulatedDurationMs` toujours ≥ 0 et monotone croissant entre transitions. |

### 26.7 Per-attempt isolation

| ID | Assertion |
| --- | --- |
| P-14 | Pour tout `(label, attempt1, attempt2)` avec `attempt1 !== attempt2`, les chemins de résultat sont strictement disjoints. Testé sur 10 combinaisons aléatoires. |
| P-15 | Les manifests antérieurs (`<label>-0.json`, `<label>-1.json`) sont tous préservés post-retry (jamais écrasés). |

### 26.8 Exactement-un PhaseResult

| ID | Assertion |
| --- | --- |
| P-16 | Pour toute phase qui retourne un PhaseResult, un seul des 5 appels possibles (`transition`, `delegateSkill`, `delegateAgent`, `delegateAgentBatch`, `done`, `fail`) a réussi. Le second throw `ProtocolError`. Testé sur 10 scénarios de combinaison. |

### 26.9 Exactly-once consumption

| ID | Assertion |
| --- | --- |
| P-17 | Pour toute phase de reprise qui retourne sans throw, `consumedCount === 1` exactement. Testé sur 10 scénarios variés (skill, agent, batch). |
| P-18 | Pour toute phase de reprise où `consumedCount !== 1`, bloc `ERROR error_kind: protocol` est émis. |

### 26.10 Release lock systématique

| ID | Assertion |
| --- | --- |
| P-19 | Pour tout exit (DELEGATE, DONE, ERROR, ABORTED), le lock est released avant l'exit (via `releaseLock` avec ownerToken match). Vérifié en mockant le call et en comptant les invocations. |
| P-20 | Pour SIGKILL (simulé), le lock n'est **pas** released — il expire via lease idle. |

### 26.11 Fail-closed universel

| ID | Assertion |
| --- | --- |
| P-21 | Pour toute erreur (preflight ou runtime), un bloc `@@TURNLOCK@@ action: ERROR` est émis sur stdout. Jamais de silence. Testé sur les 11 classes d'erreur. |
| P-22 | La Promise `runOrchestrator()` ne rejette **jamais** à l'appelant. Tout throw interne est capté par le top-level handler et converti en bloc ERROR + exit (§4.4, C13). |

### 26.12 Observabilité : run complet

| ID | Assertion |
| --- | --- |
| P-23 | Pour tout run qui émet `orchestrator_start`, un `orchestrator_end` est émis (sur l'invocation terminale). Testé sur 10 scénarios. |
| P-24 | Preflight errors n'émettent ni `orchestrator_start` ni `orchestrator_end` (invariant §4.6). |

### 26.13 Détermine mécanique

| ID | Assertion |
| --- | --- |
| P-25 | Pour un même input (config + argv + state disque + clock + mock-fs identique), `runOrchestrator` produit le même effet (events identiques, state final identique, bloc stdout identique). Vérifié sur 5 scénarios clés (happy path, retry, preflight, resume, abort). |

### 26.14 Protocole version constant

| ID | Assertion |
| --- | --- |
| P-26 | Tout bloc émis a `version: 1`. Vérifié sur 30 émissions variées. |

### 26.15 Aucune mutation du frozen state

| ID | Assertion |
| --- | --- |
| P-27 | Pour toute phase qui accepte state avec `Object.isFrozen(state) === true`, toute tentative de mutation throw `TypeError`. Testé sur 10 variantes (primitive, nested, array, boolean). |

### 26.16 Logger injecté ≠ stderr default

| ID | Assertion |
| --- | --- |
| P-28 | Avec `LoggingPolicy.logger` custom fourni, aucun event n'est écrit sur stderr. `events.ndjson` reste écrit (sauf si `persistEventLog: false`). |

### 26.17 `runId` adopté via argv

| ID | Assertion |
| --- | --- |
| P-29 | Pour `--run-id <fixedUlid>`, tous les events, path de RUN_DIR et bloc protocole utilisent exactement `<fixedUlid>`. Permet des tests reproductibles. |

### 26.18 Deadline per-attempt

| ID | Assertion |
| --- | --- |
| P-30 | Pour tout retry, `newDeadlineAtEpochMs === newEmittedAtEpochMs + oldManifest.timeoutMs` (pas un résiduel). Testé sur 10 retries. |

---

## 27. Contract invariant global (`tests/contracts/surface.test.ts`, `errors.test.ts`, `fail-closed.test.ts`)

**[STRUCTURE RÉVISÉE §0.4]** — Les sections §27.1 à §27.6 (surface publique, constantes, dépendances, typage, union error kinds, classes d'erreur) sont des vérifications type-level / littérales, **pas des contract invariants au sens post-condition**. Elles sont déplacées en §27.bis GREEN Layer 1 companion.

Les sections §27.7 à §27.14 restent RED strict : ce sont de vraies post-conditions qui rident parasiquement sur les acceptance tests des §15-§22 et §24-§25 (fail-closed, mapping `kind ↔ action`, un seul bloc par invocation, couplage `orchestrator_start/end`, invariants state/manifest/temporal/PII).

### 27.1 [DÉPLACÉ §27.bis] Surface publique exportée

| ID | Assertion |
| --- | --- |
| C-GL-01 | Le module `turnlock` exporte : `runOrchestrator`, `definePhase`, `OrchestratorConfig`, `Phase`, `PhaseIO`, `PhaseResult`, `DelegationRequest`, `SkillDelegationRequest`, `AgentDelegationRequest`, `AgentBatchDelegationRequest`, `RetryPolicy`, `TimeoutPolicy`, `LoggingPolicy`, `OrchestratorLogger`, `OrchestratorEvent`, `OrchestratorError`, `OrchestratorErrorKind`, `InvalidConfigError`, `StateCorruptedError`, `StateMissingError`, `StateVersionMismatchError`, `DelegationTimeoutError`, `DelegationSchemaError`, `DelegationMissingResultError`, `PhaseError`, `ProtocolError`, `AbortedError`, `RunLockedError`, `PROTOCOL_VERSION`, `STATE_SCHEMA_VERSION`. |
| C-GL-02 | Le module **n'exporte pas** : `executeCall`, engine internals, `SkillBinding`, `AgentBinding`, `AgentBatchBinding` (les 3 bindings restent internes), `clock` module, `state-io`, `validator`, `retry-resolver`, `error-classifier`, `logger`, `protocol`, `run-dir`, `run-id`, `abortableSleep` (tous internes). |
| C-GL-03 | `ValidationPolicy` n'existe pas dans les exports (retrait M12). |
| C-GL-04 | Toutes les sous-classes d'erreur sont `instanceof OrchestratorError` (TS + runtime check). |

### 27.2 [DÉPLACÉ §27.bis] Constantes exportées

| ID | Assertion |
| --- | --- |
| C-GL-05 | `PROTOCOL_VERSION === 1` (literal const). |
| C-GL-06 | `STATE_SCHEMA_VERSION === 1` (literal const). |

### 27.3 [DÉPLACÉ §27.bis] Dépendances minimales

| ID | Assertion |
| --- | --- |
| C-GL-07 | `package.json` `dependencies` contient exactement `zod` et `ulid`. Rien d'autre en runtime (§5.6). |
| C-GL-08 | Aucune sous-dépendance n'apporte d'API visible au consommateur (isolé). |

### 27.4 [DÉPLACÉ §27.bis] Typage

| ID | Assertion |
| --- | --- |
| C-GL-09 | `OrchestratorConfig<State>` accepte `State extends object = object`. Compile sur `config<MyState>`. |
| C-GL-10 | `Phase<State, Input, Output>` compile avec Input/Output typés. |
| C-GL-11 | `definePhase` est un pass-through (no-op runtime, utile pour inférence). |

### 27.5 [DÉPLACÉ §27.bis] OrchestratorErrorKind fermé

| ID | Assertion |
| --- | --- |
| C-GL-12 | L'union `OrchestratorErrorKind` a exactement 11 valeurs : `"invalid_config"`, `"state_corrupted"`, `"state_missing"`, `"state_version_mismatch"`, `"delegation_timeout"`, `"delegation_schema"`, `"delegation_missing_result"`, `"phase_error"`, `"protocol"`, `"aborted"`, `"run_locked"`. |
| C-GL-13 | Chaque sous-classe d'erreur a un `kind` exactement égal à un des 11 littéraux. |

### 27.6 [DÉPLACÉ §27.bis] Classes d'erreur — propriétés publiques

| ID | Assertion |
| --- | --- |
| C-ER-01 | `RunLockedError` a les propriétés publiques `ownerPid: number`, `acquiredAtEpochMs: number`, `leaseUntilEpochMs: number` (§6.6). |
| C-ER-02 | `OrchestratorError` a les propriétés publiques `kind: OrchestratorErrorKind`, `runId?: string`, `orchestratorName?: string`, `phase?: string`. |
| C-ER-03 | Chaque sous-classe est utilisable avec `throw new X(...)` et `instanceof` fonctionne. |

### 27.7 Fail-closed universel

| ID | Assertion |
| --- | --- |
| C-FC-01 | Pour toute erreur (preflight ou runtime), un bloc `@@TURNLOCK@@ action: ERROR` est émis sur stdout. Exit code ≠ 0. |
| C-FC-02 | La Promise `runOrchestrator()` résout sans rejeter. Tout throw interne capturé (§4.4, C13). |
| C-FC-03 | Preflight errors ont `run_id: null` si le runId n'a pas encore été adopté/généré. Sinon `run_id: <valeur>`. |
| C-FC-04 | `orchestrator: <name>` toujours présent dans le bloc ERROR (disponible dès `config.name` qui est parsé en premier). |

### 27.8 Mapping `PhaseResult.kind ↔ action` unique

Référence : §5.3 (table canonique).

| ID | Assertion |
| --- | --- |
| C-FC-05 | `PhaseResult.kind === "transition"` → aucun bloc émis (continue boucle in-process) |
| C-FC-06 | `PhaseResult.kind === "delegate"` → bloc `action: DELEGATE`, exit 0 |
| C-FC-07 | `PhaseResult.kind === "done"` → bloc `action: DONE`, exit 0 |
| C-FC-08 | `PhaseResult.kind === "fail"` → bloc `action: ERROR`, exit 1 |
| C-FC-09 | Exception utilisateur non-catchée → bloc `action: ERROR`, exit 1 |
| C-FC-10 | Signal SIGINT → bloc `action: ABORTED`, exit 130. SIGTERM → exit 143. |

### 27.9 Un seul bloc par invocation

| ID | Assertion |
| --- | --- |
| C-FC-11 | Toute invocation du process émet **exactement un** bloc protocole (DELEGATE OU DONE OU ERROR OU ABORTED). Jamais deux blocs. |
| C-FC-12 | Un run complet cross-process émet typiquement N × DELEGATE + 1 × {DONE, ERROR, ABORTED} (C15). |

### 27.10 Events `orchestrator_start` / `orchestrator_end` couplage

| ID | Assertion |
| --- | --- |
| C-OB-01 | Pour tout run qui émet `orchestrator_start`, un `orchestrator_end` est émis (sur l'invocation terminale). Cross-invocations, c'est `orchestrator_start` de la première invocation + `orchestrator_end` de la dernière. |
| C-OB-02 | Preflight errors n'émettent **ni** `orchestrator_start` **ni** `orchestrator_end` (§4.6 C12). |

### 27.11 State invariants

| ID | Assertion |
| --- | --- |
| C-SI-01 | `state.schemaVersion === 1` toujours. |
| C-SI-02 | `state.usedLabels` est un tableau (éventuellement vide). Append-only (jamais de splice). |
| C-SI-03 | `state.accumulatedDurationMs >= 0` toujours. |
| C-SI-04 | `state.phasesExecuted >= 0` toujours. |
| C-SI-05 | `state.runId` est un ULID valide (regex vérifiée). |

### 27.12 Manifest invariants

| ID | Assertion |
| --- | --- |
| C-MF-01 | `manifest.manifestVersion === 1` toujours. |
| C-MF-02 | `manifest.kind ∈ {"skill","agent","agent-batch"}` toujours. |
| C-MF-03 | `kind === "agent-batch"` ⇔ `jobs` présent et `resultPath` top-level absent. |
| C-MF-04 | `kind !== "agent-batch"` ⇔ `resultPath` top-level présent et `jobs` absent. |
| C-MF-05 | `manifest.attempt === state.pendingDelegation.attempt` (cohérence cross-artifact). |

### 27.13 Temporal invariants

| ID | Assertion |
| --- | --- |
| C-TM-01 | Tout `durationMs` est ≥ 0. |
| C-TM-02 | Tout `emittedAtEpochMs` ≤ `deadlineAtEpochMs`. |
| C-TM-03 | Le runtime ne stocke jamais `performance.now()` dans `state.json`, `manifest.json`, ni dans un event. Seul epoch ms et ISO. |

### 27.14 PII

| ID | Assertion |
| --- | --- |
| C-OB-03 | Aucun event n'a de champ `prompt`, `args` en clair, `content`, ou équivalent. |
| C-OB-04 | `delegation_validation_failed.zodErrorSummary` ≤ 200 chars. |
| C-OB-05 | `phase_error.message` ≤ 200 chars. |

---

## 27.bis GREEN Layer 1 companion (hors scope RED strict)

**Référence normative** : §0.4 (classification), NIB spec §2.3.1 et §7.5.

Cette section regroupe les vérifications **type-level / littérales / fixture-based** qui ne guident pas le RED mais doivent être exécutées **lorsque Layer 1 PUBLIC-API est implémenté** (premier palier du GREEN). Elles passent trivialement après `tsc --noEmit` + scaffolding des types et classes — leur valeur est de verrouiller le contrat de surface une fois la surface écrite.

**Exécution** : ces tests vivent dans `tests/_green-layer-1/` (ou équivalent). Exclus du run RED initial via `test.skip("[GREEN-L1] ...")` ou un fichier glob pattern séparé. Décommentés / activés au moment de l'implémentation de Layer 1.

**Contenu déplacé depuis** :

### 27.bis.1 Interface du clock module (ex-§9.1)

| ID | Propriété |
| --- | --- |
| T-CK-01 | `clock.nowWall()` retourne un `Date` |
| T-CK-02 | `clock.nowWallIso()` retourne une string format ISO 8601 UTC |
| T-CK-03 | `clock.nowEpochMs()` retourne un `number` entier ≥ 0 |
| T-CK-04 | `clock.nowMono()` retourne un `number` ≥ 0 (monotonic) |

### 27.bis.2 Forme des events (ex-§23.1, §23.2)

`T-OB-01..13` — vérification de la shape de chaque `OrchestratorEvent` construit inline. Voir §23.1-§23.2 pour le détail des 13 vecteurs.

Les **property tests P-OB-a/b/c** (§23.3) qui vérifient ces invariants sur des events **émis par le runtime** restent en RED strict — ils échouent si le runtime n'émet rien.

### 27.bis.3 Surface publique exportée (ex-§27.1)

`C-GL-01..04` — voir §27.1 pour le détail. Vérifications `module.exports` post-scaffold.

### 27.bis.4 Constantes exportées (ex-§27.2)

`C-GL-05..06` — `PROTOCOL_VERSION === 1`, `STATE_SCHEMA_VERSION === 1`.

### 27.bis.5 Dépendances minimales (ex-§27.3)

`C-GL-07..08` — inspection `package.json`.

### 27.bis.6 Typage (ex-§27.4)

`C-GL-09..11` — checks TS compile-time.

### 27.bis.7 OrchestratorErrorKind fermé (ex-§27.5)

`C-GL-12..13` — 11 valeurs littérales dans l'union.

### 27.bis.8 Classes d'erreur — propriétés publiques (ex-§27.6)

`C-ER-01..03` — `new RunLockedError(...).ownerPid`, etc.

### 27.bis.9 Règle de consommation

Ces tests sont **obligatoires** au moment où Layer 1 PUBLIC-API est implémenté (premier palier GREEN). Un consommateur Layer 2/3/4 ne doit pas construire au-dessus d'une surface non verrouillée par ces companions. En pratique : la CI a un run séparé `bun test tests/green-l1` qui passe dès que Layer 1 compile.

---

## 28. Helpers de test

Ce qui suit décrit les helpers à implémenter dans `tests/helpers/`. Ces helpers sont des **utilitaires de test**, pas du code de production — ils peuvent être écrits en parallèle des tests en RED.

### 28.1 `mock-fs.ts`

```ts
// Filesystem mockable : memfs ou temp dir avec cleanup.
export interface MockFs {
  readonly root: string;                   // Ex: /tmp/turnlock-test-abc123
  writeFile(path: string, content: string): void;
  readFile(path: string): string;
  exists(path: string): boolean;
  list(path: string): string[];
  rm(path: string): void;
  // Scénarios de panne contrôlée
  injectWriteError(path: string, error: Error): void;  // Le prochain write sur path throw
  reset(): void;
}

export function createMockFs(): MockFs;
```

### 28.2 `mock-clock.ts`

```ts
// Horloges contrôlables pour tests déterministes.
export interface MockClock {
  nowWall(): Date;
  nowWallIso(): string;
  nowEpochMs(): number;
  nowMono(): number;

  setWall(isoOrDate: string | Date): void;
  setEpochMs(ms: number): void;
  setMono(ms: number): void;

  advanceWall(ms: number): void;
  advanceEpoch(ms: number): void;
  advanceMono(ms: number): void;

  // Install/uninstall : remplace le module clock du runtime par ce mock.
  install(): void;
  uninstall(): void;
}

export function createMockClock(
  initialIso?: string,
  initialEpoch?: number,
  initialMono?: number
): MockClock;
```

### 28.3 `mock-stdio.ts`

```ts
// Capture de stdout/stderr + simulation de re-entry.
export interface MockStdio {
  readonly stdout: string;
  readonly stderr: string;
  clear(): void;
  // Utilities
  getProtocolBlocks(): ParsedProtocolBlock[];  // Parse tous les blocs émis sur stdout
  getEvents(): OrchestratorEvent[];            // Parse tous les events NDJSON sur stderr
}

export function createMockStdio(): MockStdio;
```

### 28.4 `mock-logger.ts`

```ts
// Logger qui collecte les events en mémoire pour inspection.
export interface MockLogger extends OrchestratorLogger {
  events: OrchestratorEvent[];
  reset(): void;
  find(eventType: string): OrchestratorEvent | undefined;
  findAll(eventType: string): OrchestratorEvent[];
  eventTypes(): string[];  // Séquence ordonnée
}

export function createMockLogger(): MockLogger;
```

### 28.5 `mock-signal.ts`

```ts
// AbortSignal contrôlable + simulation SIGINT/SIGTERM.
export interface ControlledSignal {
  signal: AbortSignal;
  abort(reason?: unknown): void;
  abortAfter(ms: number, reason?: unknown): void;  // Utilise mockClock
  emitOsSignal(sig: "SIGINT" | "SIGTERM"): void;   // Déclenche handler runtime
}

export function createControlledSignal(): ControlledSignal;
```

### 28.6 `fixture-loader.ts`

```ts
// Charge une fixture JSON depuis tests/fixtures/.
export function loadFixture(relativePath: string): string;
export function loadJsonFixture<T = unknown>(relativePath: string): T;
export function loadStateFixture<S>(relativePath: string): StateFile<S>;
export function loadManifestFixture(relativePath: string): DelegationManifest;
```

### 28.7 `state-builder.ts`

```ts
// Fabriques de StateFile avec overrides ergonomiques.
export function buildInitialState<S>(overrides?: Partial<StateFile<S>>): StateFile<S>;
export function buildMidRunState<S>(overrides?: Partial<StateFile<S>>): StateFile<S>;
export function buildPendingSkill<S>(label: string, attempt: number, overrides?: Partial<StateFile<S>>): StateFile<S>;
export function buildPendingAgent<S>(label: string, attempt: number, overrides?: Partial<StateFile<S>>): StateFile<S>;
export function buildPendingBatch<S>(label: string, jobIds: string[], attempt: number, overrides?: Partial<StateFile<S>>): StateFile<S>;
```

### 28.8 `protocol-asserts.ts`

```ts
// Assertions composites sur blocs protocole + séquences d'events.
export const protocolAsserts = {
  singleBlock(stdout: string): ParsedProtocolBlock;  // Throw si 0 ou > 1
  blockAction(block: ParsedProtocolBlock, action: "DELEGATE" | "DONE" | "ERROR" | "ABORTED"): void;
  blockRunId(block: ParsedProtocolBlock, runId: string | null): void;
  blockErrorKind(block: ParsedProtocolBlock, errorKind: OrchestratorErrorKind): void;
  noBlock(stdout: string): void;
};

export const eventAsserts = {
  sequenceMatches(events: OrchestratorEvent[], expectedTypes: string[]): void;
  allSameRunId(events: OrchestratorEvent[]): void;
  countOfType(events: OrchestratorEvent[], eventType: string): number;
  endEventFinal(events: OrchestratorEvent[]): void;
  noPIIIn(events: OrchestratorEvent[], forbiddenTexts: string[]): void;
};
```

### 28.9 `temp-run-dir.ts`

```ts
// Crée un RUN_DIR réel dans /tmp/ et cleanup automatique.
export async function withTempRunDir(
  orchestratorName: string,
  runId: string,
  fn: (runDir: string) => Promise<void>
): Promise<void>;
```

### 28.10 `run-harness.ts`

```ts
// Orchestre un scénario multi-invocations (initial → resume → resume → done).
export interface RunHarness {
  config: OrchestratorConfig<any>;
  fs: MockFs;
  clock: MockClock;
  stdio: MockStdio;
  logger: MockLogger;

  invokeInitial(args: string[]): Promise<void>;        // Simule premier démarrage
  invokeResume(runId: string): Promise<void>;          // Simule re-entry
  simulateAgentResult(path: string, result: unknown): void;   // Le parent agent écrit un résultat
  simulateSkillResult(path: string, result: unknown): void;
  simulateBatchResults(dir: string, jobsResults: Record<string, unknown>): void;
}

export function createRunHarness(config: OrchestratorConfig<any>): RunHarness;
```

### 28.11 Pour les property tests

Pas d'outil tiers requis (`fast-check` optionnel). Les property tests utilisent des boucles déterministes avec seeds fixes :

```ts
// Utilitaire simple pour générer des inputs pseudo-aléatoires reproductibles.
export function seededRandom(seed: number): {
  randomString(maxLen: number): string;
  randomInt(min: number, max: number): number;
  randomBool(): boolean;
  randomEvent(): OrchestratorEvent;
  randomState(): StateFile<any>;
};
```

Les tests de propriété itèrent typiquement 20-100 fois avec seeds dérivés (1, 2, 3, …) — reproductibles en cas d'échec.

---

## 29. Principes transversaux et règles de rédaction

### 29.1 Quand un GREEN est ambigu — procédure

Plusieurs vecteurs sont marqués "DÉCISION" dans ce NIB-T : la spécification laisse une latitude réelle sur un point, et le NIB-T tranche. Si GREEN découvre qu'une autre interprétation est plus adéquate (simplicité, alignement avec une fixture existante), le protocole est :

1. Documenter l'observation dans un commentaire au-dessus du vecteur de test.
2. Mettre à jour le vecteur (valeur attendue + justification).
3. Valider que le vecteur mis à jour reste cohérent avec la spec NX (sinon c'est un écart normatif à remonter au niveau spec).

Règle appliquée : "une fixture rate, on questionne la fixture avant de questionner le code" (miroir du NIB-T).

### 29.2 Couverture attendue

| Zone | Couverture branches cible | Couverture lines cible |
| --- | --- | --- |
| Services transversaux (Layer 4) | ≥ 95% | ≥ 98% |
| Lock (§4.13) | ≥ 95% | ≥ 98% |
| Bindings (Layer 3) | ≥ 90% | ≥ 95% |
| Engine (Layer 2) | ≥ 90% | ≥ 95% |
| Public API (Layer 1) | ≥ 85% | ≥ 95% |
| **Global** | **≥ 90%** | **≥ 95%** |

Cibles alignées sur §19.2 du NX. Les décisions matérialisées (retry, deadline, per-attempt paths) doivent être à 100% par testabilité exhaustive des fonctions pures.

### 29.3 Pas de test à un vrai parent process

Aucun test ne nécessite un parent process live (Claude Code, runner CI, daemon, ou autre) qui invoquerait réellement le binaire et interpréterait les blocs protocole. Tous les tests reposent sur `mock-fs` + `mock-clock` + `mock-stdio` + `mock-logger`. Critère de succès : `bun test` passe **offline** et sans aucun parent process attaché.

### 29.4 Granularité des fichiers de test

La découpe par module (un fichier `.test.ts` par section §N) est indicative. Le GREEN peut regrouper ou fractionner selon l'ergonomie, à condition de préserver :

- Les identifiants `T-XX-NN`, `P-NN`, `C-XX-NN` (même si dispersés).
- La traçabilité par un `it.each` ou équivalent nommé (`it("T-RO-05 | Delegation skill emits DELEGATE", ...)`).
- Le mapping inverse test → section NIB-T via un commentaire de header dans chaque fichier.

### 29.5 Vocabulaire de test

- **Acceptance test (vecteur)** : un cas concret avec entrée et sortie attendues. Porte un `T-XX-NN`.
- **Property test** : un invariant vérifié sur un échantillon d'inputs. Porte un `P-NN` ou `P-XX-a`.
- **Contract invariant** : une règle transversale appliquée à toutes les exécutions. Porte un `C-XX-NN`.

Si un test ne rentre dans aucune des trois catégories, c'est probablement un test unitaire d'implémentation → il émerge en GREEN, pas ici.

### 29.6 Un échec = un diagnostic

Chaque vecteur doit être rédigé de sorte que son échec donne un diagnostic immédiat :

- Nom du test explicite (inclut l'ID et une description humaine).
- Assertion fine (une propriété par assertion, pas un gros `toEqual` qui masque l'écart).
- Fixture identifiable (nommée explicitement, pas lambda).

Cette discipline est ce qui permet à GREEN de converger vite.

### 29.7 Discipline PII dans le test harness

Les fixtures ne contiennent **jamais** de données réelles de production. Toute fixture avec apparence de "prompt réel" ou "résultat réel" est un placeholder générique (`"LoremIpsum..."`, `{ verdict: "clean" }`). Cette discipline protège les tests de toute fuite accidentelle et reflète la PII policy du runtime (§11.5).

---

## 30. Total testable — récapitulatif

**Deux cohortes distinctes** (cf §0.4) : RED strict vs GREEN Layer 1 companion.

### 30.0 RED strict (doivent tous échouer avant implémentation runtime)

| Catégorie | Compte approximatif |
| --- | --- |
| Acceptance tests (`T-`) — services transversaux RED (§2-§8, §10) | ~72 (T-CK-01..04 retirés = §27.bis) |
| Acceptance tests (`T-`) — lock (§11) | ~20 |
| Acceptance tests (`T-`) — bindings (§12-§14) | ~20 |
| Acceptance tests (`T-`) — engine initial + sous-cas (§15-§16) | ~55 |
| Acceptance tests (`T-`) — engine resume + retry + isolation (§17-§19) | ~55 |
| Acceptance tests (`T-`) — preflight + signals + composition (§20-§22) | ~35 |
| Acceptance tests (`T-`) — temporal (§22.bis) | ~12 |
| Acceptance tests (`T-`) — observabilité PII + events.ndjson (§24-§25) | ~18 (T-OB-01..13 retirés = §27.bis) |
| Property tests globaux (`P-NN`) | 30 (§26) |
| Property tests locaux (`P-{trigramme}-{lettre}`) | ~33 (P-CK-a/b supprimés) |
| Contract invariants RED (`C-FC-*`, `C-OB-*`, `C-SI-*`, `C-MF-*`, `C-TM-*`) post-conditions transversales (§27.7-§27.14) | ~25 |
| **Total RED strict** | **~375 tests** |

**Garantie RED** : après scaffold de `tsc --noEmit` qui passe + exports de Layer 1, **100% de ces tests échouent**. Aucun n'est vacuously GREEN.

### 30.1 GREEN Layer 1 companion (hors scope RED, §27.bis)

| Catégorie | Compte approximatif |
| --- | --- |
| Clock module interface (`T-CK-01..04`) | 4 |
| Event shape + taxonomy closure (`T-OB-01..13`) | 13 |
| Surface publique exportée (`C-GL-01..04`) | 4 |
| Constantes (`C-GL-05..06`) | 2 |
| Dépendances (`C-GL-07..08`) | 2 |
| Typage (`C-GL-09..11`) | 3 |
| Error kind union fermé (`C-GL-12..13`) | 2 |
| Error class properties (`C-ER-01..03`) | 3 |
| **Total GREEN L1 companion** | **~33 tests** |

**Consommation** : décommentés / activés au moment de l'implémentation de Layer 1 PUBLIC-API. Exécutés via un run CI séparé (`bun test tests/green-l1`).

### 30.2 Retirés complètement du NIB-T

| Tests | Raison |
| --- | --- |
| `T-CK-05..08` + `P-CK-a`, `P-CK-b` | Testent `createMockClock` (test-harness), pas le runtime. |

**Total retiré** : 6 tests (vs ~425 dans la v1.0 initiale du NIB-T).

### 30.3 Volume global

- **Total testable NIB-T v2.0** : ~375 RED + ~33 GREEN-L1 = **~408 tests**
- **Delta vs v1.0** : -6 (mock self-tests retirés) + réclassification 33 en GREEN-L1

Volume cohérent avec la surface du runtime. Chaque sous-système et chaque invariant normatif du NX a son front de test adressable. Les chiffres sont des comptes au moment de l'éclatement RED ; des ajustements pendant GREEN peuvent faire bouger le total sans changer la couverture du contrat observable.

### 30.1 Couverture des invariants normatifs du NX

Chaque invariant normatif du NX doit avoir au moins un test dans ce NIB-T. Table de couverture :

| Invariant NX | §NX | Test(s) NIB-T |
| --- | --- | --- |
| Séparation décision mécanique / sémantique | §4.1 | structurel (design) |
| Re-entry + JSON-sérialisable state | §4.2 | T-RO-32 à T-RO-35 |
| Atomicité écriture state | §4.3 | T-SI-08 à T-SI-11, P-SI-b |
| Fail-closed | §4.4 | C-FC-01 à C-FC-10, P-21 |
| Déterminisme mécanique | §4.5 | P-25 |
| Observabilité obligatoire | §4.6 | C-OB-01, C-OB-02, P-23, P-24 |
| Abort propagé | §4.7 | §21 (T-SG-01 à T-SG-11) |
| Configuration figée run-init | §4.8 | T-RO-41 |
| Surface publique stable | §4.9 | §27 (C-GL-01 à C-GL-13) |
| JSON-only state | §4.10 | T-SI-*, T-RO-32 à T-RO-35 |
| Single process per run | §4.11 | T-LK-02, T-LK-05, P-07 |
| Snapshot-authoritative pas event-sourced | §4.12 | T-EV-12, P-02 |
| Lock d'exécution par run | §4.13 | §11 intégralité, T-RO-01b/c |
| Phase deep-freeze + single PhaseResult | §6.2 | §16.3, §16.4, P-16, P-27 |
| `input` in-process only | §6.2 C11 | T-RO-36 à T-RO-38 |
| Output JSON-sérialisable | §6.4 | T-RO-16, T-RO-18, T-RO-19 |
| Label unique au run | §6.5, §7.1 | T-RO-24 à T-RO-28 |
| Jobs[].id unique au batch | §6.5 | T-RO-39, T-RO-40 |
| Policy defaults | §6.8, §9 | T-RO-20 à T-RO-24 |
| state.json schemaVersion 1 | §7.1 | T-SI-04 |
| pendingDelegation timing d'effacement | §7.1 M14, §14.2 step 14 | T-RS-24, T-RS-25, T-RS-26 |
| usedLabels append-only | §7.1 M19 | T-RO-24, T-RT-09, T-RT-10 |
| effectiveRetryPolicy persistée | §7.1 M26, §14.1 step 16.n | T-RT-08, T-RO-42 à T-RO-44 |
| Manifest per-attempt | §7.2 M6 | §19, T-RO-40 à T-RO-42 |
| JSON malformé → DelegationSchemaError | §14.2 C6 | T-RS-14 à T-RS-18 |
| Protocole `@@TURNLOCK@@` format | §7.4 | §4 (T-PR-*) |
| events.ndjson owner-only append-only | §7.5 C14 | §24 (T-EV-*) |
| Reconstruction flux via events | §7.5, §11.7 | T-EV-11 |
| Retry table de décision | §8.2, §10.1 | §2 (T-RR-*) |
| PhaseError non retried | §8.3 | T-RR-08 |
| Timeout owned by runtime | §9.3 | T-RS-11, T-TM-04 |
| Deadline per-attempt | §9.3 AM2 | P-30, T-RT-02 |
| 11 event types fermés | §11.3 | T-OB-01 à T-OB-13 |
| PII absence | §11.5 C10 | §25 (T-OB-20 à T-OB-23) |
| Trois horloges séparées | §12.1 | §9, T-TM-10 à T-TM-12 |
| Cumul durée cross-reentry | §12.4 | T-TM-01 à T-TM-03 |
| Deadline cross-reentry | §12.4 | T-TM-04 à T-TM-06 |
| Clock jump immunité | §12.4 | T-TM-07 à T-TM-09, P-12 |
| SIGINT/SIGTERM handler | §13.2 | T-SG-01, T-SG-03, T-SG-09 |
| Mapping PhaseResult.kind ↔ action | §5.3, §14 | C-FC-05 à C-FC-10 |
| Consumption exact-once | §14.2 step 16.l, AM1 | §17.3, P-17, P-18 |
| Resume RUN_DIR mismatch | §14.2 M10 step 7 | T-RS-19, T-RS-20 |
| resumeCommand required | §14.1 M18 | T-PF-06, T-PF-07 |
| initialState required | §14.1 M20 | T-PF-05 |
| Lock = process-alive, release systématique | §4.13 M25 | §11, P-19, P-20 |
| Retry post-schema reconstruction | §14.1 step 16.i M13 | T-RT-01, T-RT-06 à T-RT-08 |
| Composition récursive | §15.3 | §22 (T-CP-*) |
| RunLockedError via protocole | §6.6 | T-LK-02, T-PF-21 |
| SIGKILL crash recovery | §3.2, §17 | T-LK-17, T-LK-18 |
| Phase > 30 min via refreshLock | §4.13, §17 | T-LK-19, T-LK-20 |
| PROTOCOL_VERSION = 1 | §5.2 | C-GL-05, P-26 |
| STATE_SCHEMA_VERSION = 1 | §5.2 | C-GL-06, C-SI-01 |
| Dépendances minimales (zod + ulid) | §5.6 | C-GL-07 |
| Cleanup rétention runs | §5.5, §6.1 | §7 (T-RD-*) |

---

## 31. Ce que ce NIB-T ne teste pas

Par design, ces zones sont hors scope :

- **Tests live avec un vrai parent process** : nécessitent un parent qui exécute réellement le travail demandé par les blocs protocole et relance le binaire (Claude Code, runner CI, daemon, etc.). Couverts par les consommateurs en usage quotidien — voir `docs/consumers/claude-code/` pour le premier consommateur (skills `senior-review`, `loop-clean`, etc.).
- **Tests de performance** : latence, débit, memoize. Peuvent être ajoutés en bench séparé, pas en NIB-T.
- **Tests de chaos** : injection aléatoire de failures filesystem concurrentes. Hors scope v1.
- **Tests de fuite mémoire long-running** : heures de re-entries consécutives. Mesure séparée.
- **Tests d'implémentation interne** : forme du dispatcher, layout des services, algorithme de parsing protocole — émergent en GREEN.
- **Tests d'intégration avec `llm-runtime`** : scenarios où une phase fait un call LLM direct. Hors scope v1 (§3.2, §16.4).
- **Tests de migration de consommateur** (ex. `senior-review` v1 → v2) : c'est un livrable de l'intégration consommateur, pas du runtime.
- **Tests de scheduler / cron** : le runtime ne planifie rien (§3.2). Testé séparément côté skill `schedule`.
- **Tests de reprise après SIGKILL** : limitation v1 explicite (§3.2, §13.1, §17).
- **Tests de circuit breaker / multi-run** : hors scope v1 (§3.2, §17).
- **Tests d'event sourcing pur** : explicitement refusé par design (§4.12). Pas pertinent.

---

*turnlock — Implicit-Free Execution — "Reliability precedes intelligence."*
