---
id: TURNLOCK-RUNNERS
version: "1.9.0"
scope: turnlock
status: draft
---

# Turnlock Runners

**Date** : 2026-07-16
**Statut** : draft — contrats de crash et de concurrence fermés. Dernière passe avant freeze.
**Références** :
- [Interpretable Context Methodology](https://arxiv.org/abs/2603.16021) (arXiv:2603.16021v2)
- [Pi extensions API](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)
- [Claude Agent SDK TypeScript](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md)

---

## 1. Problème

Sans runner : 82 lignes de procédure protocole par SKILL.md. Avec l'Agent
Runner : 5 lignes. La complexité est dans le pipeline, le runner, les
schémas et le bridge.

---

## 2. Principe

Tout appel externe passe par `io.delegate()` (checkpoint atomique, retry,
timeout, classification, audit trail, process isolation).

---

## 3. Deux types de runners

- **LLM Runner** : code pur, pas d'agent.
- **Agent Runner** : parse → valide → BridgeEvent → injection message natif
  → agent exécute le travail sémantique.

---

## 4. Protocole `@@TURNLOCK@@`

Format key:value v2. Parser → `{ version, runId, orchestrator, action,
fields: {...} }`. Actions : `DELEGATE`, `DONE`, `ERROR` (`runId` nullable),
`ABORTED`. Priorité au bloc sur `result.error`/`result.signal`.

---

## 5. Architecture

```
pipeline.ts → agent-runner.ts (6 frontières principales + artefacts internes)
→ bridge (spool, fencing, déduplication, mono-consommateur)
→ main agent (travail sémantique, relance --resume-yield)
```

---

## 6. Verrous

### 6.1 Verrou de session : `active-runner.lock`

Empêche deux workflows logiques différents. `ownerToken` = fencing token
(dans le verrou, `config.json`, chaque `BridgeEvent`). Bridge rejette si
`event.ownerToken !== lock.ownerToken`. START (O_EXCL) vs RECOVER (rotate
token via `.lock-mutex`).

### 6.2 Verrou d'invocation : `runnerDir/.invocation-lock`

Empêche deux processus du même runner de s'exécuter simultanément.
Acquis avant toute exécution, **y compris la publication d'erreur**,
relâché après `handoff` durable.

```typescript
const InvocationLockSchema = z.object({
  version: z.literal(1),
  invocationId: z.string().min(1),
  pid: z.number().int().positive(),
  acquiredAt: z.string().datetime(),
  leaseUntil: z.number().int().positive(),
}).strict();
```

Récupérable après crash : lease > timeout pipeline maximal, vérification
du PID. Un ancien processus ne doit pas supprimer le verrou d'un
successeur (comparaison d'`invocationId`).

### 6.3 `invocationId` — défini depuis le mode

```typescript
const InvocationIdSchema = z.union([
  z.string().regex(/^initial:[A-Za-z0-9_-]+$/),
  z.string().regex(/^resume:[A-Za-z0-9:_-]+$/),
]);

// Construction :
const invocationId = mode.kind === "initial"
  ? `initial:${config.runId}`
  : `resume:${mode.yieldId}`;
```

Stable par construction. Utilisé dans `dedupeKey`, `payloadHash`,
`handoff`, `BridgeEvent.invocationId`, et le diagnostic.

---

## 7. Contrat bridge → loader

```text
TURNLOCK_BRIDGE_DIR=/tmp/turnlock-bridge/sess_abc123
TURNLOCK_SESSION_KEY=sess_abc123
```

---

## 8. Structure et loader

### 8.1 Structure

```
/tmp/turnlock-<runnerId>/
├── config.json
├── .invocation-lock
├── current-yield.json
├── handoff.json
├── yield-records/<sha256(yieldId)>.json
└── tools/agent-runner.ts
```

### 8.2 Preuve de handoff : l'événement durable, pas seulement `handoff.json`

Après le retour du processus runner, le loader cherche une preuve de
transfert dans le spool :

```typescript
function hasProofOfHandoff(
  bridgeDir: string,
  runnerId: string,
  logicalRunId: string,
  invocationId: string,
  ownerToken: string,
): boolean {
  // 1. Index rapide
  if (fs.existsSync(handoffPath)) return true;

  // 2. Preuve principale : événement durable dans le spool
  const event = findBridgeEvent({
    bridgeDir,
    runnerId,
    logicalRunId,
    invocationId,
    ownerToken,
    locations: ["pending", "inflight", "delivered"],
  });

  return event !== null;
}
```

Le loader applique :

```text
preuve de handoff → propriété transférée, ne pas libérer
preuve explicite d'échec avant publication → libération possible
situation ambiguë → ne pas libérer (lease + recovery + GC)
```

`handoff.json` est un index rapide, pas la source de vérité exclusive.

### 8.3 `loader.ts` (START)

```typescript
const config = RunnerConfigSchema.parse({...});
const invocationId = `initial:${config.runId}`;

let ownershipTransferred = false;
try {
  acquireSessionLock(...);
  copyTemplate(runnerDir);
  writeConfigAtomically(runnerDir, config);
  fs.mkdirSync(path.join(runnerDir, "yield-records"), { recursive: true });

  spawnSync("bun", ["run", config.runnerPath, "--initial"], {
    cwd: runnerDir, stdio: "inherit",
  });

  ownershipTransferred = hasProofOfHandoff(
    config.bridgeDir, config.runnerId, config.runId, invocationId, config.ownerToken,
  );

  if (!ownershipTransferred) {
    releaseSessionLock(config.bridgeDir, config.runnerId, config.ownerToken);
  }
} finally {
  if (!ownershipTransferred) {
    releaseSessionLock(config.bridgeDir, config.runnerId, config.ownerToken);
    removePartialRunnerDir(runnerDir);
  }
}
```

---

## 9. `agent-runner.ts`

### 9.1 Structure : verrou couvre tout, y compris l'erreur

```typescript
async function run(): Promise<void> {
  const config = loadConfig();
  const mode = parseModeArg(process.argv.slice(2));
  const invocationId = mode.kind === "initial"
    ? `initial:${config.runId}`
    : `resume:${mode.yieldId}`;

  if (!acquireInvocationLock(config.runnerDir, invocationId)) {
    process.stdout.write(JSON.stringify({ status: "invocation_already_running" }));
    process.exit(0);
  }

  try {
    try {
      await executeLocked(config, mode, invocationId);
    } catch (error) {
      await publishRunnerFailureLocked(config, error, invocationId);
    }
  } finally {
    releaseInvocationLock(config.runnerDir, invocationId);
  }
}
```

Le `catch` qui publie l'erreur est **à l'intérieur** du `try` du verrou.
Aucune fenêtre entre la libération du verrou et la publication d'erreur.

### 9.2 `executeLocked()`

```typescript
async function executeLocked(
  config: RunnerConfig, mode: RunMode, invocationId: string,
): Promise<void> {
  verifySessionLock(config.bridgeDir, config);
  touchSessionActivity(config.bridgeDir, config.ownerToken);

  let knownRunDir: string | null = null;

  if (mode.kind === "resume") {
    const yieldRecord = loadYieldRecord(mode.yieldId);
    if (!yieldRecord) { exitStale("unknown_yield_id"); }
    const state = readAndValidateState(yieldRecord.runDir);
    if (state.runId !== config.runId || state.orchestratorName !== config.orchestrator) {
      throw new CrossValidationError("state mismatch");
    }
    if (!state.pendingDelegation) { exitStale("no_pending_delegation"); }
    if (realpathSync(state.pendingDelegation.manifestPath) !==
        realpathSync(yieldRecord.manifestPath)) { exitStale("manifest_path_mismatch"); }
    knownRunDir = yieldRecord.runDir;
  }

  const args = mode.kind === "resume"
    ? ["--run-id", config.runId, "--resume"]
    : ["--run-id", config.runId];

  const result = spawnSync("bun", ["run", config.mainPath, ...args], {
    cwd: config.projectRoot, encoding: "utf-8",
    maxBuffer: 10 * 1024 * 1024, timeout: 600_000,
  });

  const blockCount = countTurnlockBlocks(result.stdout ?? "");
  if (blockCount === 1) {
    const output = normalizeAndValidate(parseProtocolBlock(result.stdout));
    validateProcessOutcomeConsistency(output, result);
    await route(config, output, knownRunDir, invocationId);
    return;
  }
  if (result.error) throw new PipelineProcessError({ reason: "spawn_failed" });
  if (result.signal) throw new PipelineProcessError({ reason: "killed_by_signal" });
  if (result.status === null) throw new PipelineProcessError({ reason: "no_exit_code" });
  if (blockCount === 0) throw new PipelineProcessError({ reason: "no_turnlock_block" });
  throw new ProtocolError(`Expected exactly one block, received ${blockCount}`);
}
```

### 9.3 `publishRunnerFailureLocked()`

```typescript
async function publishRunnerFailureLocked(
  config: RunnerConfig, error: unknown, invocationId: string,
): Promise<void> {
  const classification = classifyRunnerError(error);
  const recoveryStatus = classification.terminal ? "terminal" : "unknown";

  const receipt = publishBridgeEvent(config.bridgeDir, {
    type: "ERROR", source: "runner", errorKind: classification.kind,
    recoveryStatus, logicalRunId: config.runId, protocolRunId: null,
    ownerToken: config.ownerToken, invocationId,
    content: buildRunnerErrorMessage(error, recoveryStatus),
  });

  writeHandoff(config.runnerDir, receipt);
  touchSessionActivity(config.bridgeDir, config.ownerToken);
}
```

### 9.4 `publishAndHandoff()`

```typescript
function publishAndHandoff(
  config: RunnerConfig, event: BridgeEventInput, invocationId: string,
): PublicationReceipt {
  verifySessionLock(config.bridgeDir, config);

  const receipt = publishBridgeEvent(config.bridgeDir, event);
  writeHandoff(config.runnerDir, receipt);
  touchSessionActivity(config.bridgeDir, config.ownerToken);

  process.stdout.write(JSON.stringify({ status: "event_published" }));
  return receipt;
}
```

`publishBridgeEvent()` retourne un `PublicationReceipt` :

```typescript
interface PublicationReceipt {
  eventId: string;
  invocationId: string;
  filePath: string;
  publishedAt: string;
}
```

### 9.5 Handlers (`route` → `handleDelegate`, `handleDone`, `handleError`, `handleAborted`)

Identiques à v1.8.0. Chaque handler appelle `publishAndHandoff()` avec le
`BridgeEventInput` approprié et l'`invocationId`.

### 9.6 `validateResultPaths()` — `canonicalFuturePath`

```typescript
function canonicalFuturePath(filePath: string): string {
  const parent = fs.realpathSync(path.dirname(filePath));
  return path.join(parent, path.basename(filePath));
}
```

TOCTOU parent → symlink : accepté en v1 (les processus locaux sont fiables
dans le threat model de confiance faible).

### 9.7 Machine RECOVER

```text
1. Scanner le spool (pending/inflight/delivered)
   → événements avec ownerToken obsolète → superseded/
   → événements avec token courant → terminer le traitement

2. state.pendingDelegation ?
   → retrouver YieldRecord via manifestPath
   → resultPath existent + JSON parseable ?
     → oui : --resume-yield (le core valide le schéma métier)
     → non : republier CONTINUATION

3. Événement terminal dans le spool → livrer, nettoyer

4. Sinon → unknown, conserver
```

Après `DONE`, supprimer `current-yield.json` (ou écrire
`{ status: "terminal" }`) pour ne pas induire le recovery en erreur.

---

## 10. Schémas Zod

### 10.1 Six frontières principales

Config, Protocole, Manifest, State, Yield, Event — toutes validées.

### 10.2 Artefacts internes

`ActiveRunnerSchema`, `InvocationLockSchema`, `CurrentYieldSchema`,
`HandoffSchema`, `InflightRecordSchema` — tous `.strict()`.

### 10.3 `BridgeEventSchema`

```typescript
const BridgeEventBase = z.object({
  version: z.literal(1),
  eventId: z.string().min(1),
  dedupeKey: z.string().min(1),
  payloadHash: z.string().min(1),
  runnerId: z.string().min(1),
  sessionKey: z.string().min(1),
  invocationId: InvocationIdSchema,
  sequence: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
  ownerToken: z.string().min(1),
  logicalRunId: z.string().min(1),
});

const BridgeEventSchema = z.discriminatedUnion("type", [
  BridgeEventBase.extend({ type: z.literal("CONTINUATION"), protocolRunId: z.string().min(1), yieldId: z.string().min(1), content: z.string().min(1) }).strict(),
  BridgeEventBase.extend({ type: z.literal("DONE"), protocolRunId: z.string().min(1), content: z.string().min(1) }).strict(),
  BridgeEventBase.extend({ type: z.literal("ERROR"), protocolRunId: z.string().nullable(), source: z.enum(["turnlock","runner"]), errorKind: z.string().min(1), recovery: RecoveryStateSchema, content: z.string().min(1) }).strict(),
  BridgeEventBase.extend({ type: z.literal("ABORTED"), protocolRunId: z.string().min(1), signal: z.enum(["SIGINT","SIGTERM"]), recovery: RecoveryStateSchema, content: z.string().min(1) }).strict(),
]);
```

### 10.4 `RecoveryStateSchema`

```typescript
const RecoveryInfoSchema = z.object({ yieldId: z.string().min(1), command: z.string().min(1) }).strict();
const RecoveryStateSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("resumable"), info: RecoveryInfoSchema }).strict(),
  z.object({ status: z.literal("terminal") }).strict(),
  z.object({ status: z.literal("unknown") }).strict(),
]);
```

### 10.5 `payloadHash`

Calculé sur une sérialisation JSON canonique (ordre stable des clés) du
contenu sémantique. **Exclut** : `eventId`, `sequence`, `createdAt`,
`ownerToken`, `claimedAt`. Une rotation de token produit le même hash.

### 10.6 `InvocationIdSchema`

```typescript
const InvocationIdSchema = z.union([
  z.string().regex(/^initial:[A-Za-z0-9_-]+$/),
  z.string().regex(/^resume:[A-Za-z0-9:_-]+$/),
]);
```

---

## 11. Le bridge

### 11.1 Spool

```text
bridgeDir/
├── active-runner.lock
├── .lock-mutex
├── publisher-state.json
├── pending/
├── inflight/<eventId>/
│   ├── event.json          ← BridgeEvent immuable
│   └── lease.json          ← { claimedAt, leaseUntil }
├── delivered/
├── superseded/
├── quarantine/
└── dedupe/<sha256(dedupeKey)>.json
```

### 11.2 Claim : répertoire par événement (crash-safe)

```text
1. Rename pending/<file>.json → inflight/<eventId>/event.json
   (l'eventId est extrait du nom de fichier ou du contenu)

2. Écrire atomiquement lease.json :
   { "version": 1, "claimedAt": "...", "leaseUntil": "..." }
```

États récupérables :

```text
event.json sans lease.json → claim interrompu → remettre en pending/
lease.json expiré → remettre en pending/
lease.json valide → laisser le worker courant terminer
```

L'événement est immuable. Les métadonnées de livraison sont séparées.

### 11.3 `delivered/` = journal autoritatif, `dedupe/` = index dérivé

Au démarrage :

```text
1. Scanner delivered/ → valider les événements
2. Reconstruire/réparer dedupe/ depuis delivered/
3. Scanner inflight/ → récupérer les leases
4. Scanner pending/ → enfiler par sequence
5. Activer le watcher
```

Lors du traitement d'un événement :

```text
1. Chercher dedupeKey dans dedupe/
2. Si absent → vérifier delivered/ (scan par nom de fichier)
3. Si toujours absent → injecter
4. Après injection : déplacer vers delivered/, écrire dedupe/
```

```typescript
const DedupeRecordSchema = z.object({
  version: z.literal(1),
  dedupeKey: z.string(),
  payloadHash: z.string(),
  eventId: z.string(),
  status: z.literal("delivered"),
  deliveredAt: z.string().datetime(),
}).strict();
```

### 11.4 Refencing après RECOVER — politique par type

| Type | Condition | Action |
|------|-----------|--------|
| `CONTINUATION` | `state.pendingDelegation.manifestPath === manifest` de l'événement superseded | Republier avec nouveau token |
| `CONTINUATION` | Mismatch | Obsolète, archiver |
| `DONE` | `output.json` existe, state correspond, pas de `pendingDelegation` | Republier |
| `DONE` | Condition non remplie | Obsolète |
| `ERROR` / `ABORTED` | L'état n'a pas progressé au-delà de l'invocation | Réutiliser la charge sémantique, nouveau token/eventId, `payloadHash` identique (token exclu) |
| `ERROR` / `ABORTED` | État a progressé | Obsolète |

Pour `ERROR`/`ABORTED`, vérifier que l'état n'a pas progressé : le
`state.currentPhase` et `state.pendingDelegation` (ou leur absence)
doivent être cohérents avec l'événement superseded.

### 11.5 Mono-consommateur

Une seule boucle de livraison par session. Traitement séquentiel par
`sequence`. Les trous sont autorisés. Deux événements ne sont jamais
injectés simultanément.

### 11.6 Garantie

At-least-once. Documenté.

### 11.7 Nettoyage

Utilise `logicalRunId`. Vérifie `lock.runnerId === event.runnerId` et
`lock.runId === event.logicalRunId`. `DONE` → supprimer. `ERROR terminal`
→ supprimer. Tout le reste → conserver.

### 11.8 Bridge Pi

```typescript
watchBridgeEvents(bridgeDir, async (filePath) => {
  const event = await spoolClaimAndValidate(filePath, lock.ownerToken);
  if (!event) return;
  await pi.sendUserMessage(event.content, { deliverAs: "followUp" });
  await spoolDeliver(event.eventId);
  touchSessionActivity(bridgeDir, lock.ownerToken);
});
```

### 11.9 Bridge Claude Agent SDK

```typescript
const turnCompleted = new AsyncSemaphore(0);

async function* messages(): AsyncIterable<SDKUserMessage> {
  yield toSdkUserMessage(initialUserMessage);
  while (true) {
    const event = await nextBridgeEvent();
    await turnCompleted.acquire();
    yield toSdkUserMessage(event.content);
  }
}

const session = query({ prompt: messages(), options: { ... } });
for await (const message of session) {
  if (message.type === "result") turnCompleted.release();
}
```

---

## 12. Garanties

| Garantie | Niveau |
|----------|--------|
| Reprise idempotente | Garanti |
| Frontières (6 principales + artefacts internes) | Garanti |
| Erreurs → BridgeEvent (verrou maintenu) | Garanti |
| Fencing (anciens bridges/runners/events) | Garanti |
| Concurrence (invocation + session) | Garanti |
| Crash recovery (handoff via spool, inflight dirs, delivered journal) | Garanti |
| Livraison bridge → session | **At-least-once** |
| Exécution sémantique exactly-once | **Non garanti** (v1) |
| Immutabilité resultPath | **Non garanti** (v1) |
| Authenticité canal bridge | **Confiance faible** (v1) |

---

## 13. Prochaines étapes

1. **Schémas** (tous `.strict()`) : `ActiveRunnerSchema`, `InvocationLockSchema`, `RunnerConfigSchema`, `PipelineOutputSchema`, `BridgeEventSchema`, `RecoveryStateSchema`, `CurrentYieldSchema`, `HandoffSchema`, `InflightRecordSchema`, `DedupeRecordSchema`, `YieldRecordSchema`, `RunnerStateEnvelopeSchema`, `InvocationIdSchema`
2. **Verrous** : session (START/RECOVER, fencing, `.lock-mutex`), invocation (O_EXCL, lease, récupération PID)
3. **Loader** : START (`hasProofOfHandoff` via spool, pas seulement `handoff.json`), RECOVER (machine structurée)
4. **Runner** : `run()` avec verrou couvrant l'erreur, `executeLocked()`, `publishRunnerFailureLocked()`, `publishBridgeEvent()` → `PublicationReceipt`, `validateResultPaths()` avec `canonicalFuturePath`
5. **Spool** : `inflight/<eventId>/event.json` + `lease.json`, `delivered/` journal autoritatif, `dedupe/` index reconstruit au démarrage, mono-consommateur
6. **Refencing** : politique par type (CONTINUATION, DONE, ERROR/ABORTED), vérification de non-progression du state
7. **Bridge** : Pi natif, Claude `AsyncIterable` + `AsyncSemaphore(0)`, scan startup, `maxIdleMs`
8. **Tests** : crash entre publication et handoff, crash pendant claim inflight, double invocation, fencing après RECOVER, refencing chaque type, delivered/ reconstruction au démarrage
