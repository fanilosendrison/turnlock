---
okf_version: "1.0"
kind: "RuntimeArtifact"
format: "dependency-contract"
workspace: "turnlock"
date: "2026-07-21"
step_id: 0
id: "DC-PI-SUBAGENTS"
type: "dependency-contract"
version: "0.1.0"
dependency_version: "0.35.1"
scope: "pi-subagents-turnlock-integration"
status: "active"
consumers:
  - "CDD-S-PI-SUBAGENTS-EXECUTION"
referenced_by:
  - "CDD-S-PI-SUBAGENTS-EXECUTION"
superseded_by: []
source_repository: "https://github.com/fanilosendrison/pi-subagents-4-turnlock"
source_commit: "2842823d421ed01619f6cc58c15dab850cef7eaa"
source_tree: "606e362d8d50ea075a7975e2ed9e2779999689e4"
compatibility_verdict: "incompatible"
---

# Dependency Contract — pi-subagents 0.35.1

## 0. Identity

- **Component:** `pi-subagents`
- **Package version:** `0.35.1`
- **Source:** `fanilosendrison/pi-subagents-4-turnlock`
- **Commit:** `2842823d421ed01619f6cc58c15dab850cef7eaa`
- **Git tree:** `606e362d8d50ea075a7975e2ed9e2779999689e4`
- **Upstream:** `nicobailon/pi-subagents`
- **Turnlock compatibility:** Incompatible; preflight use only
- **Role:** Establish the exact inspected public surface and require Turnlock to
  reject dispatch until a compatible fork release supersedes this contract.

This contract is deliberately active and negative. It prevents a consumer from
assuming guarantees that the inspected dependency does not provide. It does not
specify a hypothetical future API as if it already existed.

## 1. Interface

### 1.1 RPC transport

The dependency exposes process-local event-bus RPC protocol version 1:

```typescript
const SUBAGENT_RPC_PROTOCOL_VERSION = 1;
const SUBAGENT_RPC_REQUEST_EVENT = "subagents:rpc:v1:request";
const SUBAGENT_RPC_READY_EVENT = "subagents:rpc:v1:ready";
const SUBAGENT_RPC_REPLY_EVENT_PREFIX = "subagents:rpc:v1:reply:";

type SubagentRpcMethod =
  | "ping"
  | "status"
  | "spawn"
  | "interrupt"
  | "stop";
```

Requests and replies are:

```typescript
interface SubagentRpcRequestEnvelope {
  version: 1;
  requestId: string;
  method: SubagentRpcMethod;
  params?: unknown;
  source?: {
    extension?: string;
    [key: string]: unknown;
  };
}

type SubagentRpcReplyEnvelope<T = unknown> =
  | {
      version: 1;
      requestId: string;
      method?: SubagentRpcMethod;
      success: true;
      data: T;
    }
  | {
      version: 1;
      requestId: string;
      method?: SubagentRpcMethod;
      success: false;
      error: {
        code: SubagentRpcErrorCode;
        message: string;
      };
    };
```

Treat `requestId` as RPC reply correlation only. Do not treat it as an
idempotency key, durable launch identity, or recovery identity.

### 1.2 Ping

`ping` returns protocol version, method names, basic capability booleans, event
names, and current session data. The advertised capabilities are `status`,
`asyncSpawn`, `interrupt`, and `stop`.

It does not advertise:

- caller-committed launch correlation;
- idempotent launch replay;
- durable acknowledgement semantics;
- non-destructive result retention;
- per-job structured result commitments;
- restart-safe status independent of active session;
- retention acknowledgement.

### 1.3 Spawn

`spawn` accepts ordinary subagent parameters, forces detached asynchronous mode,
and rejects management actions, synchronous mode, and clarify UI.

The bridge invokes the extension executor with an internal call label derived as
`rpc-spawn-<requestId>`. The resulting subagent run identity remains
implementation-generated and is not committed by the caller before the external
side effect.

The method has no public equal-request idempotency contract and no public
conflict response for reuse of one caller launch key with divergent content.

### 1.4 Status and interrupt

`status` and `interrupt` accept target fields `id`, `runId`, `dir`, and `index`
and delegate to the ordinary extension control surface. Directory targeting is
part of the existing API and must not be exposed to an untrusted Turnlock job.

The contract provides no Turnlock caller-key lookup and no guarantee that status
remains available after session replacement or result consumption.

### 1.5 Stop

`stop` resolves one live asynchronous run, requires it to belong to the active
Pi session, requires current state `running`, and returns a `stopping` response
after issuing the stop request.

Completed runs are reported as not found for this operation. The method does not
provide an idempotent terminal stop result keyed by a Turnlock launch identity.

### 1.6 Result watcher

The public runtime watcher reads JSON files from the shared result directory,
emits completion/intercom events, and calls `unlinkSync(resultPath)` after
processing. It also deletes a duplicate result file after completion dedupe.

Result observation is therefore destructive. No public acknowledgement delays
that deletion, and no retention floor preserves the exact result for a later
Turnlock recovery process.

### 1.7 Background-work registry

The exported background-work API is process-local. It registers providers and
lists active items for one exact Pi session. It does not provide durable launch,
status, result, or stop authority across process restart.

## 2. Behavioral Contract

### 2.1 Permitted Turnlock use

Use this dependency only for bounded capability discovery during Pi strategy
preflight:

1. verify exact package and source identity;
2. call or observe RPC `ping` within the resource-policy startup budget;
3. verify protocol version 1 and the advertised methods;
4. compare the surface with the required Turnlock strategy capabilities;
5. return `dependency-unavailable` without invoking `spawn`.

The current compatibility verdict is deterministic and remains incompatible
even when `ping` reports all five current methods.

### 2.2 Forbidden Turnlock use

Do not use this version to:

- dispatch a Turnlock worker group;
- correlate uncertain spawn by RPC `requestId` or generated run ID;
- scan directories or timestamps for a plausible launch;
- consume watcher events as durable terminal evidence;
- read a result path that the watcher may delete;
- rely on status or stop after active-session replacement;
- ask a broker to infer missing correlation around the same public surface;
- import private package modules to obtain stronger behavior;
- scrape TUI output or terminal text.

### 2.3 Side effects

`ping` has no external execution side effect. `spawn` can create detached child
processes and durable or temporary files before its caller receives a reply.
`status`, `interrupt`, and `stop` can reconcile or mutate live run state.

Because acknowledgement can be lost after spawn, retrying `spawn` can create a
second execution. Turnlock must not enter this state with the current version.

## 3. Error Semantics

The RPC error taxonomy is:

```typescript
type SubagentRpcErrorCode =
  | "invalid_request"
  | "invalid_params"
  | "unsupported_version"
  | "unsupported_method"
  | "no_active_session"
  | "execution_failed"
  | "not_found"
  | "invalid_state";
```

Handle every error during current-version preflight as follows:

| Error | Turnlock handling |
| ----- | ----------------- |
| `unsupported_version` | `dependency-unavailable` |
| `unsupported_method` | `capability-mismatch` |
| `no_active_session` | `dependency-unavailable` |
| `invalid_request` | Adapter protocol defect; fail preflight |
| `invalid_params` | Adapter/configuration defect; fail preflight |
| `execution_failed` | `dependency-unavailable` before dispatch |
| `not_found` | Not a safe proof of launch absence |
| `invalid_state` | Not a safe terminal or stop proof |
| Timeout or no reply | `dependency-unavailable` |
| Malformed reply | Dependency protocol defect; fail preflight |

Do not reinterpret `not_found` as permission to launch a replacement because
the API lacks caller-committed correlation and durable visibility guarantees.

## 4. Integration Patterns

### 4.1 Instantiation

Load the package only through its documented extension and public RPC surface.
Pin exact source and package identity in CI and deployment. Do not import files
under `src/` from Turnlock.

### 4.2 Runtime handshake

Bound handshake retries and total time with
`STD-TURNLOCK-DELEGATION-RESOURCE-POLICY`. Retries may repeat `ping`; they must
not invoke `spawn`.

### 4.3 Compatibility result

Persist the contract ID, source commit, package version, ping evidence digest,
and incompatible verdict in the strategy preflight evidence. The generic Runner
may select a trusted `dependency-unavailable` attempt rejection when all attempt
identities remain valid.

### 4.4 Upgrade path

A future fork release must receive a new package version and source commit. Write
a superseding Dependency Contract only after its public API and tests actually
provide:

- caller-supplied launch key committed before spawn;
- request digest and divergent-key conflict;
- idempotent equal launch replay;
- durable acknowledgement before success reply;
- restart-safe inspect by caller key;
- strict per-job structured output at caller-allocated confined targets;
- non-destructive result reads and a retention floor;
- idempotent stop by caller key;
- explicit digest-scoped retention acknowledgement.

Do not edit this contract to claim compatibility for an unmodified source
commit.

## 5. Consumer Constraints

- Keep Pi strategy dispatch disabled under this contract.
- Validate exact source commit in CI; a clean fork name alone is insufficient.
- Treat live events as hints only.
- Treat generated run IDs as secondary evidence only.
- Do not expose dependency directory parameters to host or worker input.
- Bound every RPC request and reply before parsing.
- Keep provider credentials out of RPC audit evidence.
- Preserve the negative compatibility verdict across process restart.
- Require an explicit superseding contract before changing the verdict.

## 6. Known Limitations

- Spawn has no caller-committed durable idempotency key.
- An RPC reply can be lost after an external child starts.
- Exact recovery correlation is not public.
- Result watching consumes and deletes shared result files.
- Per-job retained structured output is not guaranteed.
- Status and stop are coupled to the active session and current live state.
- Stop does not expose restart-safe terminal reconciliation.
- The background-work registry is process-local.
- The fork commit is clean and functionally identical to upstream for these
  required Turnlock guarantees.

These limitations are admission blockers, not implementation details for the
Turnlock adapter to work around.
