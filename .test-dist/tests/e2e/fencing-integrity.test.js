import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
// TL-F-001 point 2 — Process-level integrity tests.
//
// Uses the real runOrchestrator (child process) to validate:
//   1. Incomplete bootstrap recovery: DB exists with schema but no state row
//      → resume succeeds via legacy seed path
//   2. Corrupted digest → ownership released immediately
import { describe, test } from "node:test";
import { nodeSqliteDriver } from "../../src/persistence/sqlite/node-sqlite-driver.js";
import { parseProtocolBlock, } from "../../src/services/protocol.js";
import { buildEntrypointSource, createE2EWorkspace, } from "../helpers/e2e-process.js";
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function countProtocolBlocks(stdout) {
    const matches = stdout.match(/@@TURNLOCK@@/g);
    return matches ? matches.length : 0;
}
function parseSingleBlock(stdout) {
    const idx = stdout.indexOf("@@TURNLOCK@@");
    if (idx === -1)
        return null;
    const endIdx = stdout.indexOf("@@END@@", idx);
    if (endIdx === -1)
        return null;
    const block = stdout.slice(idx, endIdx + "@@END@@".length);
    return parseProtocolBlock(block);
}
function expectProtocol(stdout, action, runId) {
    assert.strictEqual(countProtocolBlocks(stdout), 1);
    const block = parseSingleBlock(stdout);
    if (block === null)
        throw new Error("Failed to parse protocol block");
    assert.strictEqual(block.action, action);
    if (runId !== null)
        assert.strictEqual(block.runId, runId);
    return { fields: block.fields };
}
function readStateFile(runDir) {
    return JSON.parse(readFileSync(join(runDir, "state.json"), "utf-8"));
}
const RUN_IDS = {
    bootstrap: "01HX000000000000000FTEST01",
    corrupted: "01HX000000000000000FTEST03",
};
// ---------------------------------------------------------------------------
// Entrypoint template — a simple delegate-then-done orchestrator
// ---------------------------------------------------------------------------
function delegateThenDoneEntrypoint(orchestratorName) {
    return buildEntrypointSource(`
interface State { step: number }

await runOrchestrator<State>({
  name: ${JSON.stringify(orchestratorName)},
  initial: "emit",
  initialState: { step: 0 },
  resumeCommand: (id) => \`node \${import.meta.filename} --run-id \${id} --resume\`,
  phases: {
    emit: definePhase<State>(async (_state, io) => {
      return io.delegate({ kind: "prompt", prompt: "verify", label: "rev" }, "consume", { step: 1 });
    }),
    consume: definePhase<State>(async (_state, io) => {
      await io.consumePendingResult(z.object({ verify: z.string() }));
      return io.done({ step: 2 });
    }),
  },
});
`);
}
// ---------------------------------------------------------------------------
// DB helpers (run on a closed DB, after the child process exits)
// ---------------------------------------------------------------------------
function openDb(runDir) {
    return nodeSqliteDriver.open(join(runDir, "turnlock.sqlite3"));
}
/** Delete the state row while keeping the schema — simulates a crash
 *  after schema creation but before initial state establishment. */
function deleteStateRow(runDir) {
    const db = openDb(runDir);
    db.exec("DELETE FROM run_state WHERE singleton = 1");
    // Also set ownership to FREE so the next process can acquire.
    db.exec("UPDATE run_ownership SET ownership_status = 'FREE', owner_token = NULL, owner_pid = NULL WHERE singleton = 1");
    db.close();
}
/** Corrupt the state_digest in an otherwise valid DB. */
function corruptDigest(runDir) {
    const db = openDb(runDir);
    db.exec("UPDATE run_state SET state_digest = 'sha256:0000000000000000000000000000000000000000000000000000000000000000' WHERE singleton = 1");
    db.close();
}
// ---------------------------------------------------------------------------
// Test 1 — Incomplete bootstrap recovery
// ---------------------------------------------------------------------------
describe("process-level fencing integrity", () => {
    test("incomplete bootstrap (schema, no state row) → legacy seed → DONE", {
        timeout: 30000,
    }, async () => {
        const workspace = createE2EWorkspace("fencing-bootstrap-");
        const entrypoint = workspace.writeEntrypoint("bootstrap.ts", delegateThenDoneEntrypoint("fencing-bootstrap"));
        try {
            const runDir = workspace.runDir("fencing-bootstrap", RUN_IDS.bootstrap);
            mkdirSync(runDir, { recursive: true });
            mkdirSync(join(runDir, "delegations"), { recursive: true });
            mkdirSync(join(runDir, "results"), { recursive: true });
            mkdirSync(join(runDir, "artifacts", "sha256"), {
                recursive: true,
            });
            // 1. Run initial DONE to create the full DB + state.
            //    Use a simple one-phase entrypoint for the initial run.
            const initEntrypoint = workspace.writeEntrypoint("init.ts", buildEntrypointSource(`
interface State { step: number }
await runOrchestrator<State>({
  name: "fencing-bootstrap",
  initial: "first",
  initialState: { step: 0 },
  resumeCommand: (id) => \`node \${import.meta.filename} --run-id \${id} --resume\`,
  phases: {
    first: definePhase<State>(async (_state, io) => {
      return io.done({ step: 1 });
    }),
  },
});
`));
            const initial = await workspace.runEntrypoint(initEntrypoint, [
                "--run-id",
                RUN_IDS.bootstrap,
            ]);
            assert.strictEqual(initial.exitCode, 0);
            // 2. Delete the state row (but keep schema + incarnation +
            //    ownership reset).  Also delete state.json so the legacy
            //    seed path is forced.
            deleteStateRow(runDir);
            rmSync(join(runDir, "state.json"));
            // Write a legacy state.json WITH a pending delegation
            // (simulates crash after delegation was emitted).
            const legacyState = {
                schemaVersion: 4,
                runId: RUN_IDS.bootstrap,
                orchestratorName: "fencing-bootstrap",
                startedAt: "2024-01-01T00:00:00.000Z",
                startedAtEpochMs: 1704067200000,
                lastTransitionAt: "2024-01-01T00:00:10.000Z",
                lastTransitionAtEpochMs: 1704067210000,
                currentPhase: "emit",
                phasesExecuted: 0,
                accumulatedDurationMs: 0,
                data: { step: 0 },
                usedLabels: ["rev"],
                pendingDelegation: {
                    label: "rev",
                    kind: "prompt",
                    resumeAt: "consume",
                    manifestPath: "delegations/rev-0.json",
                    emittedAtEpochMs: 1704067210000,
                    deadlineAtEpochMs: 1704067210000 + 3600000,
                    attempt: 0,
                    effectiveRetryPolicy: {
                        maxAttempts: 1,
                        backoffBaseMs: 100,
                        maxBackoffMs: 300,
                    },
                },
            };
            writeFileSync(join(runDir, "state.json"), JSON.stringify(legacyState));
            // Write the expected result for the pending delegation.
            writeFileSync(join(runDir, "results", "rev-0.json"), JSON.stringify({ verify: "ok" }));
            // Write a delegation manifest at the path referenced by the legacy state.
            writeFileSync(join(runDir, "delegations", "rev-0.json"), JSON.stringify({ kind: "prompt", prompt: "verify", label: "rev" }));
            // 3. Resume with the delegate-then-done entrypoint.
            //    The runtime will see a DB with schema but no state row,
            //    fall back to seedLegacyStateToSqlite, and continue.
            const result = await workspace.runEntrypoint(entrypoint, [
                "--resume",
                "--run-id",
                RUN_IDS.bootstrap,
            ]);
            // 4. Must emit DONE (consumed the delegation and finished).
            assert.strictEqual(result.exitCode, 0);
            expectProtocol(result.stdout, "DONE", RUN_IDS.bootstrap);
            // 5. state.json must have been projected from SQLite.
            const projected = readStateFile(runDir);
            assert.notStrictEqual(projected.stateRevision, undefined);
            assert.notStrictEqual(projected.runIncarnationId, undefined);
            if (typeof projected.stateDigest !== "string") {
                assert.fail("expected the projected state digest");
            }
            assert.match(projected.stateDigest, /^sha256:/);
        }
        finally {
            workspace.cleanup();
        }
    });
    // -----------------------------------------------------------------------
    // Test 2 — Corrupted digest → ownership released immediately
    // -----------------------------------------------------------------------
    test("corrupted state_digest → ownership released before throw", {
        timeout: 30000,
    }, async () => {
        const workspace = createE2EWorkspace("fencing-corrupted-");
        const entrypoint = workspace.writeEntrypoint("corrupted.ts", delegateThenDoneEntrypoint("fencing-corrupted"));
        try {
            const runDir = workspace.runDir("fencing-corrupted", RUN_IDS.corrupted);
            mkdirSync(runDir, { recursive: true });
            mkdirSync(join(runDir, "delegations"), { recursive: true });
            mkdirSync(join(runDir, "results"), { recursive: true });
            mkdirSync(join(runDir, "artifacts", "sha256"), {
                recursive: true,
            });
            // 1. Run initial to create a valid DB with a delegation.
            const initial = await workspace.runEntrypoint(entrypoint, [
                "--run-id",
                RUN_IDS.corrupted,
            ]);
            assert.strictEqual(initial.exitCode, 0);
            expectProtocol(initial.stdout, "DELEGATE", RUN_IDS.corrupted);
            // 2. Corrupt the digest.
            corruptDigest(runDir);
            // 3. Resume — must detect corruption, release ownership, emit ERROR.
            const resumed = await workspace.runEntrypoint(entrypoint, [
                "--resume",
                "--run-id",
                RUN_IDS.corrupted,
            ]);
            // 4. Must fail with ERROR protocol block.
            assert.strictEqual(resumed.exitCode, 1);
            expectProtocol(resumed.stdout, "ERROR", null);
            const block = parseSingleBlock(resumed.stdout);
            assert.strictEqual(block.fields.errorKind, "state_corrupted");
            // 5. Ownership must be released.
            const db = openDb(runDir);
            const ownRow = db
                .prepare("SELECT ownership_status FROM run_ownership WHERE singleton = 1")
                .get();
            assert.strictEqual(ownRow.ownership_status, "FREE");
            db.close();
        }
        finally {
            workspace.cleanup();
        }
    });
});
//# sourceMappingURL=fencing-integrity.test.js.map