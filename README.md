# turnlock

> **turnlock gives your scripts a deterministic spine with explicit agent yield points.**
> It lets your scripts run the mechanical workflow in code, pause only when a Claude Code, Codex, or other coding harness must do semantic work, then resume automatically.
>
> Write a pipeline where code handles the mechanical steps and the agent handles the rest.
> No manual handoff, no polling, no restart from scratch — your script controls the flow, the agent only intervenes where it's needed.

---

## The problem

In Claude Code (or Codex, or Cursor), you can invoke a script from a skill:

```
User types /lint-fix  →  skill launches lint-fix.sh  →  script runs
```

But what about the reverse? **A script cannot invoke a skill or delegate back to the host agent.** While AI SDKs allow a script to spawn *isolated, amnesic sub-agents*, you cannot ask the **main session agent** (which holds the conversation history, user preferences, and full project context) to do semantic work for you. Once you're in a script, you're a blocked subprocess — the parent agent is waiting for you to finish.

```
Without turnlock:
  ┌─────────────┐                          ┌──────────┐
  │  Host Agent │────── launches ────────▶ │ script.sh│
  └─────────────┘                          └──────────┘
         ▲                                       │
         │                                       │  needs host agent's project context
         │                  ❌                   │  (ex: /summarize-this-text)
         └───────────────────────────────────────┘
              script can't call the Host Agent back

With turnlock:
  ┌─────────────┐                          ┌──────────┐
  │  Host Agent │────── launches ────────▶ │ script.ts│
  └─────────────┘                          └──────────┘
         ▲                                       │
         │                                       │  delegates skill launch to turnlock
         │               ┌──────────┐            │  (ex: /summarize-this-text)
         └───────────────│ turnlock │◀───────────┘
                         └──────────┘
                           ✅
                 turnlock calls /summarize-this-text
```

And **leaving the orchestration to the agent is the problem**:

| Issue | Consequence |
|-------|-------------|
| **LLMs are non-deterministic** | Same input → different output. The agent might skip a step, reorder phases, or improvise. You can't guarantee the same pipeline runs the same way twice. |
| **Context pollution** | The agent carries the entire pipeline logic in its context window — consuming tokens on mechanical decisions (retry? next phase? validate schema?) that code should handle. |
| **Token waste** | Every mechanical decision the agent makes is a billed token. A 3-step pipeline with retries can burn thousands of tokens on flow control alone. |

**turnlock solves this by inverting control.** You write a TypeScript pipeline where *you* decide when the agent is invoked. The pipeline is deterministic. Mechanical steps are code. Agent steps are delegated through a clean protocol. If the process crashes mid-pipeline, `--resume` picks up exactly where it stopped.

The useful mental model: turnlock is the mechanical spine of a workflow. A phase is a persisted, resumable transaction in that spine. A delegation is the explicit yield point where the workflow needs semantic judgment, host-agent tools, or another non-deterministic worker.

---

## Quick example (30 seconds)

A pipeline that runs after the agent has written code: verify, delegate the commit message to a skill, then commit.

```typescript
import { runOrchestrator } from "turnlock";
import { z } from "zod";

runOrchestrator({
  name: "verify-and-commit",
  initial: "verify",
  phases: {
    verify: async (state, io) => {
      // Mechanical: tests pass, lint passes, typecheck passes
      // Delegate to a skill: write the commit message
      return io.delegate(
        { kind: "prompt", worker: "commit-msg", prompt: "Write a conventional commit for the staged diff", label: "msg" },
        "commit",
        state,
      );
    },
    commit: async (state, io) => {
      const { message } = io.consumePendingResult(z.object({ message: z.string() }));
      // Mechanical: git commit with the agent-written message
      return io.done({ committed: true, message });
    },
  },
  initialState: {},
  resumeCommand: (runId) => `bun run pipeline.ts --run-id ${runId} --resume`,
});
```

**What happens at runtime:**

1. `verify` runs once. Checks pass, then it calls `io.delegate(...)`.
2. The runtime snapshots state to disk, prints a `@@TURNLOCK@@` protocol block on stdout, and **exits**.
3. The parent agent (Claude Code) reads the protocol block, invokes the `commit-msg` skill, waits for completion, then relaunches the binary with `--resume --run-id <id>`.
4. On resume, `state.json` is loaded. `commit` runs, consumes the skill's result, commits with the agent-written message, and emits `DONE`.

Notice that a phase is not synonymous with an agent call. A phase can do as much mechanical work as it needs before yielding. Splitting into another phase is reserved for durable boundaries: `delegate(...)`, `delegateBatch(...)`, `requestExternal(...)`, `done(...)`, or `fail(...)`.

---

## How it works

```
┌──────────────────────────────────────────────────────────────┐
│                      TURNLOCK PIPELINE                        │
│                                                              │
│   Phase 1            Phase 2             Phase 3             │
│  (mechanical)       (delegation)        (mechanical)         │
│  ┌──────────┐      ┌──────────┐        ┌──────────┐         │
│  │   Lint   │─────▶│  Delegate│        │  Verify  │         │
│  │  (code)  │      │ (suspend)│        │  (code)  │         │
│  └──────────┘      └────┬─────┘        └────▲─────┘         │
│                         │                   │                │
│          ┌──────────────┼───────────────────┼─────────────┐  │
│          │  PROTOCOL    │                   │             │  │
│          │              ▼                   │             │  │
│          │  @@TURNLOCK@@                     │             │  │
│          │  action: DELEGATE                │             │  │
│          │  run_id: 01J...                  │             │  │
│          │  resume_cmd: bun run ...         │             │  │
│          │  @@END@@                         │             │  │
│          │                                  │             │  │
│          │  Process exits (code 0)          │             │  │
│          │         │                        │             │  │
│          │         ▼                        │             │  │
│          │  ┌────────────────────┐         │             │  │
│          │  │  Parent agent      │         │             │  │
│          │  │  executes skill    │         │             │  │
│          │  │  or spawns agent   │         │             │  │
│          │  │  writes result to  │         │             │  │
│          │  │  $RUN_DIR/results/ │         │             │  │
│          │  └────────┬───────────┘         │             │  │
│          │           │                     │             │  │
│          │           ▼                     │             │  │
│          │  ┌────────────────────┐         │             │  │
│          │  │  Resume process    │─────────┼─────────────┘  │
│          │  │  loads state.json  │         │                │
│          │  │  consumes result   │─────────┘                │
│          │  │  continues at      │                          │
│          │  │  Phase 3           │                          │
│          │  └────────────────────┘                          │
│          └─────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
```

**The key insight:** turnlock doesn't run a persistent server. It starts, executes mechanical phases until it hits a delegation, snapshots state, and **exits**. The parent agent does the delegated work, then relaunches. This means there's nothing running while the workflow is yielded — no memory leaks, no dangling processes, no port conflicts.

---

## Why turnlock instead of...

### ...a Bash script?

```bash
#!/bin/bash
# What you WANT to do:
bunx biome check src/ > lint-output.json
if [ $? -ne 0 ]; then
  # ❌ Impossible: you can't invoke a Claude Code skill from Bash.
  # You have to stop here, tell the user to run /fix-lint manually,
  # then tell them to re-run this script.
  echo "Run /fix-lint in Claude Code, then re-run this script."
  exit 1
fi
bunx biome check src/  # verify
```

```typescript
// What turnlock lets you do:
const lint = async (state, io) => {
  const errors = findLintErrors(state.files);
  if (errors.length === 0) return io.done({ ok: true });
  return io.delegate(
    { kind: "prompt", prompt: `Fix: ${JSON.stringify(errors)}`, label: "fix" },
    "verify",
    { ...state, errors },
  ); // ← suspends, agent runs, resumes at "verify"
});
```

| Concern | Bash script | turnlock |
|---------|-------------|----------|
| Invoke an agent from code | ❌ Impossible | ✅ `io.delegate(...)` |
| Crash recovery | ❌ Restart from scratch | ✅ `state.json` + `--resume` |
| Structured audit trail | ❌ Ad-hoc `echo` | ✅ `events.ndjson` + manifests |
| Retry on transient errors | ❌ Manual trap/retry | ✅ Built-in backoff + timeout |
| JSON manipulation | ❌ `jq` chains, fragile | ✅ Native TS + zod validation |
| Deterministic flow | ❌ Discipline-only | ✅ Frozen state, single-result guard, lock file |

### ...Temporal / Inngest / Trigger.dev?

Temporal is a fantastic workflow engine — for distributed systems with a server. turnlock is designed for environments where **no server can exist**: a CI runner, a laptop, a Claude Code session. No Docker, no database, no worker pool — a single process that starts, runs, and exits. If you have a Temporal cluster, use Temporal. If you're inside an agent session, use turnlock.

### ...an AI SDK (Vercel AI, LangChain)?

AI SDKs are for chaining LLM calls. turnlock is for chaining **mechanical and agent steps** with reliability guarantees. Turnlock doesn't call LLMs directly — it delegates to the host agent, which has full session context (tools, memory, project knowledge). Different layer.

### ...an in-process FSM library (XState, etc.)?

If you don't need crash recovery or auditability, a state-machine library in a long-running process is simpler. turnlock adds snapshot persistence, a delegation protocol, and resume-by-relaunch. Use it when "the script might die mid-pipeline and must recover exactly where it was."

**The through-line: lightweight.** Every alternative above brings a server, a framework, or a stack of dependencies. turnlock ships **2 production dependencies** (`zod`, `ulid`), runs as a single process that starts and exits, and requires zero infrastructure. No Docker, no database, no queue, no daemon. Clone it, read the README, write your first pipeline in 10 minutes.

---

## Core properties

**Determinism.** The orchestration logic lives in your TypeScript code, not in the agent's judgment. Given the same state, turnlock always picks the same next yield. State is deep-frozen before each phase — no accidental mutation.

**Reliability.** Every stable phase yield snapshots state to disk atomically (`tmp + rename`). `--resume` continues snapshots suspended on a pending delegation or External Request. Turnlock does not currently replay a freely executing phase after a crash.

**Auditability.** Each run produces an authoritative `state.json` snapshot, an append-only `events.ndjson` audit trail, and JSON manifests for yielded requests — all correlated by `run_id`. Events supplement the snapshot; they do not reconstruct `state.data`.

**Host-agnostic.** Delegation requests travel over stdout in a neutral protocol (`@@TURNLOCK@@ ... @@END@@`). Any host that can read them, execute the request, and relaunch the binary is a valid consumer. Claude Code is the reference integration; Codex, Cursor, and custom scripts are all valid.

---

## External effects and robustness levels

Turnlock does not make phases transactional. Consumers choose the robustness level that matches each external effect. Existing delegation remains the level for agent work with Turnlock's delegation retry policy; External Requests use a separate, non-retrying path.

### Direct effect

A phase may perform an effect directly:

```typescript
async function phase(state, io) {
  await externalEffect();
  return io.done(state);
}
```

**Guarantee:** Turnlock provides no guarantee for this effect. If the process dies during a freely executing phase, normal `--resume` refuses to continue because there is no pending yield. The effect's outcome may therefore be unknown and requires consumer- or operator-defined recovery. Turnlock neither automatically replays nor deduplicates that phase.

### External Request

A phase may instead suspend durably until a consumer supplies an opaque JSON resolution:

```typescript
const phases = {
  push: async (state, io) =>
    io.requestExternal(
      {
        label: "push-repo-a",
        requestType: "git.push",
        payload: {
          repository: "/repo-a",
          remote: "origin",
          branch: "main",
          targetSha: "abc123",
        },
      },
      "after-push",
      state,
    ),

  "after-push": async (state, io) => {
    const resolution = io.consumePendingExternalResolution(
      z.object({
        outcome: z.enum(["PUSHED", "REJECTED", "UNKNOWN"]),
        remoteSha: z.string().optional(),
      }),
    );
    return io.done({ state, resolution });
  },
};
```

**Guarantee:** the suspended state records a SHA-256 digest of the exact request manifest bytes. Every resume verifies that digest before re-emission, so `requestId` cannot remain stable while payload, metadata, formatting, or other manifest content changes. Turnlock treats the request and resolution as opaque JSON and leaves business validation to the phase's Zod schema.

At the first syntactically valid JSON resolution, Turnlock atomically preserves the exact bytes under `accepted-external-resolutions/<label>.json`, records its path, digest, and acceptance time in `state.json`, and only then runs the continuation phase. A crash before the phase's next stable transition reuses that accepted copy, never a changed consumer result. A syntactically valid but schema-invalid resolution is therefore still pinned and cannot be replaced under the same request identity.

**Limit:** Turnlock does not perform, retry, reconcile, compensate, or interpret the external effect. If no resolution is written, the workflow remains suspended without an implicit success, failure, business timeout, or effect retry. Each explicit resume attempt can re-publish the same request identity, manifest, and result path. Turnlock does not guarantee that a host will relaunch the process or receive a publication, and re-publication is not an instruction to retry the effect.

The consumer should write the candidate resolution through a temporary file, flush it when required by its durability model, and atomically rename it to the manifest's `resultPath` before running `resume_cmd`. Turnlock owns the accepted copy and never executes the external effect.

Turnlock 0.10.0 emits protocol version 3 and state schema version 3. It migrates state schema v2 snapshots to v3 during resume while preserving pending delegations. Older Turnlock releases cannot read a state v3 snapshot, and consumers must recognize `REQUEST_EXTERNAL` before handling this new yield type.

> `requestExternal()` is optional. It should be used only when a consumer wants to suspend the workflow durably while waiting for an external resolution.

## What turnlock is NOT

- **Not a distributed workflow engine** — Temporal does that better at scale, with a server. turnlock runs where Temporal cannot: CI runners, laptops, inside agent sessions.
- **Not an LLM router** — if you only need to chain a few LLM calls across providers, an AI SDK in a plain Node script is simpler. turnlock is worth it when you're orchestrating multiple phases, some mechanical and some agent-delegated, with reliability and audit guarantees.
- **Not an in-process FSM library** — if neither reliability nor auditability matters, a state-machine lib in a long-running process is simpler.
- **Not an agent framework** — turnlock doesn't decide anything. It constrains *when* and *how* the agent is invoked; the agent still does the work.

One nice consequence: **testability comes for free.** Phases are pure TypeScript functions with declarative delegations, trivially unit-testable in isolation. Transition graphs can be property-tested with `fast-check` (see `tests/`).

---

## Getting started

### Prerequisites

- Bun ≥ 1.1 (or Node ≥ 22)

### Install

```bash
git clone git@github.com:fanilosendrison/turnlock.git
cd turnlock
bun install
```

### Verify

```bash
bun test          # unit + integration + property tests
bun run typecheck # strict tsc --noEmit
bun run lint      # biome check src/ tests/
```

### Build

```bash
bun run build     # emit ./dist from src/
```

---

## Documentation

| Resource | Description |
|----------|-------------|
| [`docs/NX-TURNLOCK.md`](docs/NX-TURNLOCK.md) | Full architectural concept: invariants, layer model, contract, protocol |
| [`docs/SEPARATION.md`](docs/SEPARATION.md) | Runtime / consumer architecture separation |
| [`docs/consumers/claude-code/`](docs/consumers/claude-code/) | Claude Code integration (reference consumer) |
| [`specs/briefs/`](specs/briefs/) | Immutable historical briefs documenting the original implementation intent; the current code is authoritative |

---

## License

MIT
