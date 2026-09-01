import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
// TL-F-001 point 2 — Artifact fencing tests
//
// Validates the immutable-blob-first publication protocol:
//   blob immuable → commit fenced de la référence → projection canonique
//
// Critical scenarios from review:
//   - terminalResult present in run_state after handleDone
//   - migration v3→v4 installs blob, is idempotent, persists in SQLite
//   - wrong ArtifactKind rejected at state boundary
//   - path traversal rejected by artifact-store validation
import { describe, test } from "node:test";
import { STATE_SCHEMA_VERSION } from "../../src/constants.js";
import { ArtifactIntegrityError, StateCorruptedError, StateMigrationBlockedError, } from "../../src/errors/concrete.js";
import { nodeSqliteDriver } from "../../src/persistence/sqlite/node-sqlite-driver.js";
import { acquireOwnership } from "../../src/persistence/sqlite/ownership.js";
import { openRunDatabase } from "../../src/persistence/sqlite/run-database.js";
import { readAuthoritativeState } from "../../src/persistence/sqlite/run-state-store.js";
import { installPreparedArtifact, prepareJsonArtifact, readAndVerifyArtifact, validateArtifactRef, } from "../../src/services/artifact-store.js";
import { contentDigest } from "../../src/services/content-digest.js";
import { readState } from "../../src/services/state-io.js";
import { cleanupTempDir, makeTempDir } from "../helpers/temp-run-dir.js";
import { unsafeEnsureInitialStateRow } from "../helpers/unsafe-state-seed.js";
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function sha256(content) {
    return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}
// ---------------------------------------------------------------------------
// 1. terminalResult present in run_state after handleDone
// ---------------------------------------------------------------------------
describe("terminalResult in authoritative state", () => {
    test("terminalResult is committed to SQLite and readable back", () => {
        const dir = makeTempDir();
        try {
            const dbPath = path.join(dir, "test.sqlite3");
            const runDb = openRunDatabase({
                driver: nodeSqliteDriver,
                dbPath,
                busyTimeoutMs: 2000,
            });
            try {
                const acquireResult = acquireOwnership({
                    db: runDb.connection,
                    runId: "R1",
                    orchestratorName: "test",
                    nowEpochMs: 1,
                    nowIso: "2026-01-01T00:00:00.000Z",
                    leaseDurationMs: 60000,
                    contentionDeadlineMs: 2000,
                });
                if (acquireResult.kind !== "ACQUIRED") {
                    throw new Error(`acquire failed: ${acquireResult.kind}`);
                }
                // Prepare terminal artifact
                const prepared = prepareJsonArtifact(dir, "terminal-output", {
                    result: "ok",
                });
                installPreparedArtifact(dir, prepared);
                // Build state with terminalResult
                const stateRecord = {
                    schemaVersion: STATE_SCHEMA_VERSION,
                    runId: "R1",
                    orchestratorName: "test",
                    startedAt: "2026-01-01T00:00:00.000Z",
                    startedAtEpochMs: 1,
                    lastTransitionAt: "2026-01-01T00:00:01.000Z",
                    lastTransitionAtEpochMs: 1000,
                    currentPhase: "done",
                    phasesExecuted: 1,
                    accumulatedDurationMs: 100,
                    data: { stage: "finished" },
                    usedLabels: [],
                    terminalResult: {
                        kind: "done",
                        outputArtifact: prepared.ref,
                        completedAt: "2026-01-01T00:00:01.000Z",
                        completedAtEpochMs: 1000,
                    },
                    runIncarnationId: acquireResult.handle.incarnationId,
                    stateRevision: "0",
                    committedFenceToken: "0",
                };
                const stateJson = JSON.stringify(stateRecord);
                unsafeEnsureInitialStateRow(runDb.connection, acquireResult.handle.incarnationId, STATE_SCHEMA_VERSION, stateJson, 1, "2026-01-01T00:00:00.000Z");
                // Read back
                const read = readAuthoritativeState(runDb.connection);
                assert.notStrictEqual(read.state, null);
                assert.notStrictEqual(read.state.terminalResult, undefined);
                assert.strictEqual(read.state.terminalResult.kind, "done");
                assert.strictEqual(read.state.terminalResult.outputArtifact.kind, "terminal-output");
                assert.strictEqual(read.state.terminalResult.outputArtifact.digest, prepared.ref.digest);
            }
            finally {
                runDb.close();
            }
        }
        finally {
            cleanupTempDir(dir);
        }
    });
});
// ---------------------------------------------------------------------------
// 2. Wrong ArtifactKind rejected by state validation
// ---------------------------------------------------------------------------
describe("ArtifactKind enforcement", () => {
    test("pendingDelegation.manifestArtifact with wrong kind is rejected", () => {
        const dir = makeTempDir();
        try {
            const state = {
                schemaVersion: STATE_SCHEMA_VERSION,
                runId: "R1",
                orchestratorName: "test",
                startedAt: "2026-01-01T00:00:00.000Z",
                startedAtEpochMs: 1,
                lastTransitionAt: "2026-01-01T00:00:01.000Z",
                lastTransitionAtEpochMs: 1000,
                currentPhase: "a",
                phasesExecuted: 1,
                accumulatedDurationMs: 100,
                data: {},
                usedLabels: ["rev"],
                pendingDelegation: {
                    label: "rev",
                    kind: "prompt",
                    resumeAt: "b",
                    manifestArtifact: {
                        kind: "terminal-output", // WRONG: should be delegation-manifest
                        digestAlgorithm: "sha256",
                        digest: sha256("x"),
                        relativePath: `artifacts/sha256/${sha256("x").slice(7, 9)}/${sha256("x").slice(9)}.json`,
                        mediaType: "application/json",
                        sizeBytes: 1,
                    },
                    emittedAtEpochMs: 1,
                    deadlineAtEpochMs: 2,
                    attempt: 0,
                    effectiveRetryPolicy: {
                        maxAttempts: 3,
                        backoffBaseMs: 1000,
                        maxBackoffMs: 30000,
                    },
                },
            };
            fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify(state));
            assert.throws(() => readState(dir), StateCorruptedError);
        }
        finally {
            cleanupTempDir(dir);
        }
    });
    test("pendingExternalRequest.manifestArtifact with wrong kind is rejected", () => {
        const dir = makeTempDir();
        const digest = sha256("x");
        try {
            const state = {
                schemaVersion: STATE_SCHEMA_VERSION,
                runId: "R1",
                orchestratorName: "test",
                startedAt: "2026-01-01T00:00:00.000Z",
                startedAtEpochMs: 1,
                lastTransitionAt: "2026-01-01T00:00:01.000Z",
                lastTransitionAtEpochMs: 1000,
                currentPhase: "a",
                phasesExecuted: 1,
                accumulatedDurationMs: 100,
                data: {},
                usedLabels: ["push"],
                pendingExternalRequest: {
                    requestId: "R1/push",
                    label: "push",
                    requestType: "git.push",
                    resumeAt: "b",
                    manifestArtifact: {
                        kind: "delegation-manifest", // WRONG: should be external-request-manifest
                        digestAlgorithm: "sha256",
                        digest,
                        relativePath: `artifacts/sha256/${digest.slice(7, 9)}/${digest.slice(9)}.json`,
                        mediaType: "application/json",
                        sizeBytes: 1,
                    },
                    resultPath: "/tmp/results/push.json",
                    emittedAt: "2026-01-01T00:00:01.000Z",
                    emittedAtEpochMs: 1000,
                },
            };
            fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify(state));
            assert.throws(() => readState(dir), StateCorruptedError);
        }
        finally {
            cleanupTempDir(dir);
        }
    });
    test("terminalResult.outputArtifact with wrong kind is rejected", () => {
        const dir = makeTempDir();
        const digest = sha256("x");
        try {
            const state = {
                schemaVersion: STATE_SCHEMA_VERSION,
                runId: "R1",
                orchestratorName: "test",
                startedAt: "2026-01-01T00:00:00.000Z",
                startedAtEpochMs: 1,
                lastTransitionAt: "2026-01-01T00:00:01.000Z",
                lastTransitionAtEpochMs: 1000,
                currentPhase: "a",
                phasesExecuted: 1,
                accumulatedDurationMs: 100,
                data: {},
                usedLabels: [],
                terminalResult: {
                    kind: "done",
                    outputArtifact: {
                        kind: "delegation-manifest", // WRONG: should be terminal-output
                        digestAlgorithm: "sha256",
                        digest,
                        relativePath: `artifacts/sha256/${digest.slice(7, 9)}/${digest.slice(9)}.json`,
                        mediaType: "application/json",
                        sizeBytes: 1,
                    },
                    completedAt: "2026-01-01T00:00:01.000Z",
                    completedAtEpochMs: 1000,
                },
            };
            fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify(state));
            assert.throws(() => readState(dir), StateCorruptedError);
        }
        finally {
            cleanupTempDir(dir);
        }
    });
});
// ---------------------------------------------------------------------------
// 3. Path traversal rejected by artifact-store validation
// ---------------------------------------------------------------------------
describe("artifact-store path confinement", () => {
    test("ArtifactRef with ../ in relativePath is rejected", () => {
        const ref = {
            kind: "terminal-output",
            digestAlgorithm: "sha256",
            digest: "sha256:0000000000000000000000000000000000000000000000000000000000000001",
            relativePath: "artifacts/sha256/00/../outside.json",
            mediaType: "application/json",
            sizeBytes: 2,
        };
        assert.throws(() => {
            validateArtifactRef(ref, "terminal-output");
        }, ArtifactIntegrityError);
    });
    test("ArtifactRef with absolute relativePath is rejected", () => {
        const ref = {
            kind: "delegation-manifest",
            digestAlgorithm: "sha256",
            digest: "sha256:0000000000000000000000000000000000000000000000000000000000000001",
            relativePath: "/etc/passwd",
            mediaType: "application/json",
            sizeBytes: 2,
        };
        assert.throws(() => {
            validateArtifactRef(ref, "delegation-manifest");
        }, ArtifactIntegrityError);
    });
    test("ArtifactRef whose relativePath does not match digest is rejected", () => {
        const ref = {
            kind: "external-request-manifest",
            digestAlgorithm: "sha256",
            digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            relativePath: "artifacts/sha256/bb/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.json",
            mediaType: "application/json",
            sizeBytes: 2,
        };
        assert.throws(() => {
            validateArtifactRef(ref, "external-request-manifest");
        }, ArtifactIntegrityError);
    });
});
// ---------------------------------------------------------------------------
// 4. v3→v4 migration installs blob and is idempotent
// ---------------------------------------------------------------------------
describe("v3→v4 migration durability", () => {
    test("migration installs blob and produces valid v4 state", () => {
        const dir = makeTempDir();
        try {
            // Write a legacy manifest file
            const delegDir = path.join(dir, "delegations");
            fs.mkdirSync(delegDir, { recursive: true });
            const legacyManifest = { kind: "prompt", label: "rev", attempt: 0 };
            const legacyPath = path.join(delegDir, "rev-0.json");
            fs.writeFileSync(legacyPath, JSON.stringify(legacyManifest));
            // Build a v3 state with manifestPath pointing to the legacy file
            const v3State = {
                schemaVersion: 3,
                runId: "R1",
                orchestratorName: "test",
                startedAt: "2026-01-01T00:00:00.000Z",
                startedAtEpochMs: 1,
                lastTransitionAt: "2026-01-01T00:00:01.000Z",
                lastTransitionAtEpochMs: 1000,
                currentPhase: "a",
                phasesExecuted: 1,
                accumulatedDurationMs: 100,
                data: {},
                usedLabels: ["rev"],
                pendingDelegation: {
                    label: "rev",
                    kind: "prompt",
                    resumeAt: "b",
                    manifestPath: legacyPath,
                    emittedAtEpochMs: 1,
                    deadlineAtEpochMs: 2,
                    attempt: 0,
                    effectiveRetryPolicy: {
                        maxAttempts: 3,
                        backoffBaseMs: 1000,
                        maxBackoffMs: 30000,
                    },
                },
            };
            fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify(v3State));
            // Migrate
            const result = readState(dir);
            assert.notStrictEqual(result, null);
            assert.strictEqual(result.schemaVersion, 4);
            assert.notStrictEqual(result.pendingDelegation, undefined);
            assert.notStrictEqual(result.pendingDelegation.manifestArtifact, undefined);
            const artifact = result.pendingDelegation.manifestArtifact;
            assert.strictEqual(artifact.kind, "delegation-manifest");
            assert.match(artifact.relativePath, /^artifacts\/sha256\//);
            // Verify the blob was actually installed
            const blobPath = path.join(dir, artifact.relativePath);
            assert.strictEqual(fs.existsSync(blobPath), true);
            // Verify blob content matches
            const blobContent = JSON.parse(fs.readFileSync(blobPath, "utf-8"));
            assert.deepStrictEqual(blobContent, legacyManifest);
            // Verify digest matches
            const digest = contentDigest(Buffer.from(JSON.stringify(legacyManifest), "utf-8"));
            assert.strictEqual(artifact.digest, digest);
        }
        finally {
            cleanupTempDir(dir);
        }
    });
    test("migration is idempotent — re-running with blob already installed succeeds", () => {
        const dir = makeTempDir();
        try {
            const delegDir = path.join(dir, "delegations");
            fs.mkdirSync(delegDir, { recursive: true });
            const legacyManifest = { kind: "prompt", label: "rev", attempt: 0 };
            const legacyPath = path.join(delegDir, "rev-0.json");
            fs.writeFileSync(legacyPath, JSON.stringify(legacyManifest));
            const v3State = {
                schemaVersion: 3,
                runId: "R1",
                orchestratorName: "test",
                startedAt: "2026-01-01T00:00:00.000Z",
                startedAtEpochMs: 1,
                lastTransitionAt: "2026-01-01T00:00:01.000Z",
                lastTransitionAtEpochMs: 1000,
                currentPhase: "a",
                phasesExecuted: 1,
                accumulatedDurationMs: 100,
                data: {},
                usedLabels: ["rev"],
                pendingDelegation: {
                    label: "rev",
                    kind: "prompt",
                    resumeAt: "b",
                    manifestPath: legacyPath,
                    emittedAtEpochMs: 1,
                    deadlineAtEpochMs: 2,
                    attempt: 0,
                    effectiveRetryPolicy: {
                        maxAttempts: 3,
                        backoffBaseMs: 1000,
                        maxBackoffMs: 30000,
                    },
                },
            };
            // First migration
            fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify(v3State));
            const first = readState(dir);
            assert.notStrictEqual(first.pendingDelegation.manifestArtifact, undefined);
            // Delete the in-memory migrated state and re-read — simulates
            // a second resume where SQLite still has v3
            const blobPath = path.join(dir, first.pendingDelegation.manifestArtifact.relativePath);
            assert.strictEqual(fs.existsSync(blobPath), true);
            // Second migration — blob already exists
            const second = readState(dir);
            assert.notStrictEqual(second.pendingDelegation.manifestArtifact, undefined);
            assert.strictEqual(second.pendingDelegation.manifestArtifact.digest, first.pendingDelegation.manifestArtifact.digest);
            // Blob still exists and is unchanged
            assert.strictEqual(fs.existsSync(blobPath), true);
        }
        finally {
            cleanupTempDir(dir);
        }
    });
    test("migration with ../ in legacy absolute path is rejected gracefully", () => {
        const dir = makeTempDir();
        try {
            const v3State = {
                schemaVersion: 3,
                runId: "R1",
                orchestratorName: "test",
                startedAt: "2026-01-01T00:00:00.000Z",
                startedAtEpochMs: 1,
                lastTransitionAt: "2026-01-01T00:00:01.000Z",
                lastTransitionAtEpochMs: 1000,
                currentPhase: "a",
                phasesExecuted: 1,
                accumulatedDurationMs: 100,
                data: {},
                usedLabels: ["rev"],
                pendingDelegation: {
                    label: "rev",
                    kind: "prompt",
                    resumeAt: "b",
                    manifestPath: path.join(dir, "..", "outside.json"),
                    emittedAtEpochMs: 1,
                    deadlineAtEpochMs: 2,
                    attempt: 0,
                    effectiveRetryPolicy: {
                        maxAttempts: 3,
                        backoffBaseMs: 1000,
                        maxBackoffMs: 30000,
                    },
                },
            };
            fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify(v3State));
            // Migration blocked: path escapes RUN_DIR, should throw
            // StateMigrationBlockedError with MANIFEST_OUTSIDE_RUN_DIR.
            assert.throws(() => readState(dir), StateMigrationBlockedError);
            try {
                readState(dir);
            }
            catch (err) {
                assert.ok(err instanceof StateMigrationBlockedError);
                assert.strictEqual(err.reason, "MANIFEST_OUTSIDE_RUN_DIR");
            }
        }
        finally {
            cleanupTempDir(dir);
        }
    });
});
// ---------------------------------------------------------------------------
// 5. readAndVerifyArtifact digest verification
// ---------------------------------------------------------------------------
describe("readAndVerifyArtifact", () => {
    test("returns bytes for valid artifact", () => {
        const dir = makeTempDir();
        try {
            const prepared = prepareJsonArtifact(dir, "terminal-output", {
                x: 1,
            });
            installPreparedArtifact(dir, prepared);
            const bytes = readAndVerifyArtifact(dir, prepared.ref);
            assert.deepStrictEqual(JSON.parse(Buffer.from(bytes).toString("utf-8")), {
                x: 1,
            });
        }
        finally {
            cleanupTempDir(dir);
        }
    });
    test("throws on tampered blob (content changed but path same)", () => {
        const dir = makeTempDir();
        try {
            const prepared = prepareJsonArtifact(dir, "terminal-output", {
                x: 1,
            });
            installPreparedArtifact(dir, prepared);
            // Tamper with the blob
            const blobPath = path.join(dir, prepared.ref.relativePath);
            fs.writeFileSync(blobPath, '{"x":2}');
            assert.throws(() => {
                readAndVerifyArtifact(dir, prepared.ref);
            }, ArtifactIntegrityError);
        }
        finally {
            cleanupTempDir(dir);
        }
    });
    test("throws when sizeBytes mismatches", () => {
        const dir = makeTempDir();
        try {
            const prepared = prepareJsonArtifact(dir, "delegation-manifest", {
                a: 1,
            });
            installPreparedArtifact(dir, prepared);
            // Corrupt sizeBytes
            const badRef = {
                ...prepared.ref,
                sizeBytes: 99999,
            };
            assert.throws(() => {
                readAndVerifyArtifact(dir, badRef);
            }, ArtifactIntegrityError);
        }
        finally {
            cleanupTempDir(dir);
        }
    });
});
//# sourceMappingURL=artifact-fencing.test.js.map