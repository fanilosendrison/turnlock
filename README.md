# turnlock

**A deterministic, reliable, auditable, host-agnostic runtime for orchestrating mixed mechanical and agent-delegated steps from a TypeScript script.**

> In Claude Code, you can make an agent launch a script. Can you make a script launch an agent?

`turnlock` was built for a concrete need: when Claude Code generates code that ships to production, you need stronger guarantees than "the agent said it's done". The review-fix-verify loop that enforces those guarantees must be orchestrated from outside the agent — because the agent cannot reliably police its own work across long iterations. Most of that loop — linters, structural checks, spec-drift detection — is better done by deterministic code than by an expensive and fallible agent call. `turnlock` runs the whole pipeline as a deterministic TypeScript FSM from inside the agent session itself (Claude Code, Codex), executing mechanical phases directly and delegating only the agent-worthy ones back to the host. It lets you choose, phase by phase, when to run a deterministic script and when to invoke the agent. The four requirements below emerged from that problem, not from an abstract design exercise.

`turnlock` satisfies four non-negotiable requirements simultaneously:

1. **Determinism** — the orchestration logic lives in your TypeScript FSM, not in the agent's judgment. Mechanical phases execute in-process; agent-delegated phases are invoked only where they're genuinely needed. Given the same state, `turnlock` always picks the same next transition. No drift, no skipped steps, no silent reordering.
2. **Reliability** — state survives anything that kills the process: session close, OS reboot, network outage, provider overload, rate limit exhaustion, or crash mid-phase. Every stable transition is atomically snapshotted to disk; resume picks up exactly where it stopped, so you never lose work to an API blip.
3. **Auditability** — every run leaves a structured trace on disk: ordered snapshots, append-only event log, JSON manifests for each delegation. You can reconstruct what happened, in what order, with which inputs and outputs, after the fact.
4. **Host-agnosticism at the protocol layer** — delegation requests travel over stdout in a neutral, SDK-agnostic format. Any agent-capable host that can read them, execute the requested primitive, and relaunch the binary is a valid consumer. Claude Code is the reference integration ([`docs/consumers/claude-code/`](docs/consumers/claude-code/)); Codex, Cursor, opencode, Aider, and custom scripts are all valid consumers.

Under the hood: mechanical phases execute in-process. For agent-delegated phases, the runtime **yields control** — it writes the delegation request to stdout, snapshots state to disk, and self-terminates. The host executes the primitive with its full session context, then relaunches the binary with `--resume --run-id <id>`. Nothing persistent runs between phases; no server, no worker pool.

**What `turnlock` is not:**
- Not a generic distributed workflow engine — Temporal does that better at scale, with a server. Conversely, `turnlock` runs in environments where Temporal cannot exist at all: CI runners without infrastructure, long-lived laptop workflows, and notably **inside agent sessions (Claude Code, Codex, Cursor) where no workflow engine can deploy a server**.
- Not a multi-LLM router — if you only need to chain a few LLM calls across providers, an AI SDK in a plain Node script is simpler. `turnlock` is worth its weight when you're orchestrating multiple phases, some mechanical and some agent-delegated, with reliability and audit guarantees.
- Not an in-process FSM library — if neither reliability nor auditability matters for your case, a state-machine lib in a long-running process is simpler.
- Not an agent framework — `turnlock` does not decide anything. It constrains when and how the agent is invoked; the agent still does the work.

One nice consequence: testability comes for free. Phases are pure TypeScript functions with declarative delegations, trivially unit-testable in isolation without host, stdout, or snapshot. Transition graphs can be property-tested with `fast-check` (see `tests/`).

See [`docs/SEPARATION.md`](docs/SEPARATION.md) for runtime / consumer architecture, `specs/` for normative briefs.

## Getting Started

### Prerequisites

- Bun >= 1.1 (or Node >= 22)

### Install

```bash
git clone git@github.com:fanilosendrison/turnlock.git
cd turnlock
bun install
```

### Verify

```bash
bun test               # run tests
bun run typecheck      # strict tsc --noEmit
bun run lint           # biome check src/ tests/
```

### Build

```bash
bun run build          # emit ./dist from src/
```
