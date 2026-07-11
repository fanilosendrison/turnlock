---
id: NIB-M-BINDINGS
type: nib-module
version: "2.0.0"
scope: turnlock
module: bindings
status: approved
consumers: [claude-code]
superseded_by: []
validates: ["src/bindings/**/*.ts", "src/types/delegation.ts", "tests/bindings/**/*.test.ts"]
---

# NIB-M-BINDINGS — PromptBinding + BatchBinding

**Package** : `turnlock`
**Source NX** : §5.4, §6.5, §7.2, §7.4.1
**NIB-T associé** : tests `tests/bindings/*.test.ts`
**NIB-S référencé** : §7.2 (manifest shape), §7.6 (DelegationBinding interface), I-15 (per-attempt paths)

---

## 1. Purpose

Deux bindings partagent l'interface commune `DelegationBinding<Req>` :

1. `promptBinding` — délégation single à partir d'un prompt inline.
2. `batchBinding` — délégation parallèle de N jobs indépendants.

Chaque binding encapsule uniquement les transformations write-side :

1. `buildManifest(request, context)` construit le JSON manifest écrit à `$RUN_DIR/delegations/<label>-<attempt>.json`.
2. `buildProtocolBlock(manifest, manifestPath, resumeCmd)` construit le bloc `@@TURNLOCK@@ action: DELEGATE` écrit sur stdout.

Les bindings ne lisent jamais les fichiers résultats. La lecture et la validation vivent exclusivement côté engine (`NIB-M-HANDLE-RESUME`).

**Fichiers cibles** :

- `src/bindings/types.ts`
- `src/bindings/prompt.ts`
- `src/bindings/batch.ts`
- `src/bindings/index.ts`

---

## 2. Interface Commune

```ts
import type { DelegationRequest } from "../types/delegation";

export { MANIFEST_VERSION } from "../constants";

export interface DelegationContext {
  readonly runId: string;
  readonly orchestratorName: string;
  readonly phase: string;
  readonly resumeAt: string;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly emittedAt: string;
  readonly emittedAtEpochMs: number;
  readonly timeoutMs: number;
  readonly deadlineAtEpochMs: number;
  readonly runDir: string;
}

export interface DelegationManifestJob {
  readonly id: string;
  readonly prompt: string;
  readonly resultPath: string;
}

export interface DelegationManifest {
  readonly manifestVersion: 2;
  readonly runId: string;
  readonly orchestratorName: string;
  readonly phase: string;
  readonly resumeAt: string;
  readonly label: string;
  readonly kind: "prompt" | "batch";
  readonly emittedAt: string;
  readonly emittedAtEpochMs: number;
  readonly timeoutMs: number;
  readonly deadlineAtEpochMs: number;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly worker?: string;
  readonly prompt?: string;
  readonly jobs?: readonly DelegationManifestJob[];
  readonly resultPath?: string;
}

export interface DelegationBinding<Req extends DelegationRequest> {
  readonly kind: Req["kind"];
  buildManifest(request: Req, context: DelegationContext): DelegationManifest;
  buildProtocolBlock(
    manifest: DelegationManifest,
    manifestPath: string,
    resumeCmd: string,
  ): string;
}
```

---

## 3. PromptBinding

`promptBinding` traite les requêtes :

```ts
export interface PromptDelegationRequest {
  readonly kind: "prompt";
  readonly worker?: string;
  readonly prompt: string;
  readonly label: string;
  readonly retry?: RetryPolicy;
  readonly timeout?: TimeoutPolicy;
}
```

Manifest produit :

- `manifestVersion: 2`
- `kind: "prompt"`
- `prompt` préservé intégralement
- `worker` omis si absent
- `resultPath: <runDir>/results/<label>-<attempt>.json`
- `jobs` absent

`buildProtocolBlock()` émet toujours :

```ts
writeProtocolBlock("DELEGATE", {
  runId: manifest.runId,
  orchestrator: manifest.orchestratorName,
  manifest: manifestPath,
  kind: manifest.kind,
  resumeCmd,
});
```

---

## 4. BatchBinding

`batchBinding` traite les requêtes :

```ts
export interface BatchDelegationRequest {
  readonly kind: "batch";
  readonly worker?: string;
  readonly jobs: ReadonlyArray<{
    readonly id: string;
    readonly prompt: string;
  }>;
  readonly label: string;
  readonly retry?: RetryPolicy;
  readonly timeout?: TimeoutPolicy;
}
```

Manifest produit :

- `manifestVersion: 2`
- `kind: "batch"`
- `worker` omis si absent
- `jobs[].resultPath: <runDir>/results/<label>-<attempt>/<jobId>.json`
- `resultPath` top-level absent

Règles :

- Batch vide → `InvalidConfigError`.
- IDs dupliqués : validés en amont par l'engine, pas par le binding.
- Les chemins de résultats sont per-attempt et disjoints.

---

## 5. Contraintes Transversales

- Bindings purs : pas d'I/O, pas de clock, pas de logger.
- `manifestVersion` vaut toujours `MANIFEST_VERSION` (`2`).
- `manifest.kind` correspond exactement à `request.kind`.
- `kind: "prompt"` implique `resultPath` top-level et pas de `jobs`.
- `kind: "batch"` implique `jobs[]` et pas de `resultPath` top-level.
- L'engine écrit le manifest sur disque atomiquement, puis appelle `buildProtocolBlock()`.
- Les bindings utilisent `path.join()` pour les chemins.

---

## 6. Intégration Engine

```ts
import { batchBinding, promptBinding } from "../bindings";

function selectBinding(kind: "prompt" | "batch") {
  return kind === "prompt" ? promptBinding : batchBinding;
}
```

La reconstruction d'un manifest lors d'un retry lit le manifest précédent, vérifie `manifestVersion === 2`, copie les champs métier (`worker`, `prompt`, `jobs`), recalcule les champs temporels et les chemins per-attempt, puis écrit un nouveau manifest.

---

## 7. Ownership

- **Consomme** : `NIB-M-PROTOCOL`, `NIB-M-ERRORS`, types de `NIB-M-PUBLIC-API`.
- **Produit** : `DelegationManifest` et blocs `DELEGATE`.
- **Ne possède pas** : écriture disque, retry, validation des résultats, single-writer lock.
