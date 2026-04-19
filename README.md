# cc-orchestrator-runtime

TypeScript infrastructure package providing a normalized execution engine for phase-structured orchestrators inside Claude Code sessions. Driven by an in-band stdout protocol (`@@CC_ORCH@@`) with snapshot-authoritative state (`state.json`) and append-only audit events (`events.ndjson`).

Currently at specification stage — see `specs/` for normative briefs (NIBs) and `docs/NX-CC-ORCHESTRATOR-RUNTIME.md` for the consolidated design.
