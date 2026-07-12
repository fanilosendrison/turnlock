# turnlock

> **turnlock gives your scripts a new superpower: calling Claude Code back.**
> It lets your scripts pause, delegate work back to Claude Code, Codex, or any coding harness — inside of the main agent session — then resume automatically.
>
> Write a pipeline where code handles the mechanical steps and the agent handles the rest.
> No manual handoff, no polling, no restart from scratch — your script controls the flow, the agent only intervenes where it's needed.

---

## The problem

In Claude Code (or Codex, or Cursor), you can invoke a script from a skill:

```
User types /lint-fix  →  skill launches lint-fix.sh  →  script runs
```

But what about the reverse? **A script cannot invoke a skill or spawn an agent.** Once you're in a Bash script, you've left the agent session behind.

```
Without turnlock:
  ┌─────────────┐                          ┌──────────┐
  │  Claude Code │────── launches ────────▶│ script.sh │
  └─────────────┘                          └──────────┘
         ▲                                       │
         │                                       │  needs agent work
         │                  ❌                    │  (review, fix, decide)
         └───────────────────────────────────────┘
              script can't call Claude Code back

With turnlock:
  ┌─────────────┐                          ┌──────────┐
  │  Claude Code │────── launches ────────▶│ script.ts │
  └─────────────┘                          └──────────┘
         ▲                                       │
         │               ┌──────────┐            │
         └───────────────│ turnlock │◀───────────┘
                         └──────────┘
                           ✅
                 script calls /<your-skill-name>
```

And **leaving the orchestration to the agent is the problem**:

| Issue | Consequence |
|-------|-------------|
| **LLMs are non-deterministic** | Same input → different output. The agent might skip a step, reorder phases, or improvise. You can't guarantee the same pipeline runs the same way twice. |
| **Context pollution** | The agent carries the entire pipeline logic in its context window — consuming tokens on mechanical decisions (retry? next phase? validate schema?) that code should handle. |
| **Token waste** | Every mechanical decision the agent makes is a billed token. A 3-step pipeline with retries can burn thousands of tokens on flow control alone. |

**turnlock solves this by inverting control.** You write a TypeScript pipeline where *you* decide when the agent is invoked. The pipeline is deterministic. Mechanical steps are code. Agent steps are delegated through a clean protocol. If the process crashes mid-pipeline, `--resume` picks up exactly where it stopped.

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
      return io.transition("write-commit", state);
    },
    "write-commit": async (state, io) => {
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

1. `verify` runs in-process. Checks pass → transition to `write-commit`.
2. `write-commit` calls `io.delegate(...)`. The runtime snapshots state to disk, prints a `@@TURNLOCK@@` protocol block on stdout, and **exits**.
3. The parent agent (Claude Code) reads the protocol block, invokes the `commit-msg` skill, waits for completion, then relaunches the binary with `--resume --run-id <id>`.
4. On resume, `state.json` is loaded. `commit` runs, consumes the skill's result, commits with the agent-written message, and emits `DONE`.

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

**The key insight:** turnlock doesn't run a persistent server. It starts, executes phases until it hits a delegation, snapshots state, and **exits**. The parent agent does the actual work, then relaunches. This means there's nothing running between phases — no memory leaks, no dangling processes, no port conflicts.

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

**Determinism.** The orchestration logic lives in your TypeScript code, not in the agent's judgment. Given the same state, turnlock always picks the same next transition. State is deep-frozen before each phase — no accidental mutation.

**Reliability.** Every stable transition snapshots state to disk atomically (`tmp + rename`). If the process dies — session close, OS reboot, API outage — `--resume` picks up from the last snapshot. Nothing is lost.

**Auditability.** Each run produces a `state.json` snapshot, an append-only `events.ndjson` log, and JSON manifests for every delegation — all correlated by `run_id`. You can reconstruct exactly what happened after the fact.

**Host-agnostic.** Delegation requests travel over stdout in a neutral protocol (`@@TURNLOCK@@ ... @@END@@`). Any host that can read them, execute the request, and relaunch the binary is a valid consumer. Claude Code is the reference integration; Codex, Cursor, and custom scripts are all valid.

---

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
| [`specs/`](specs/) | Normative Interface Briefs (NIBs) — the spec-driven source of truth |

---

## License

MIT
