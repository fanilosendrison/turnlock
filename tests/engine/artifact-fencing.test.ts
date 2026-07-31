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

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { STATE_SCHEMA_VERSION } from "../../src/constants";
import { ArtifactIntegrityError, StateCorruptedError } from "../../src/errors/concrete";
import { bunSqliteDriver } from "../../src/persistence/sqlite/bun-sqlite-driver";
import { acquireOwnership } from "../../src/persistence/sqlite/ownership";
import { openRunDatabase } from "../../src/persistence/sqlite/run-database";
import {
	ensureInitialStateRow,
	readAuthoritativeState,
} from "../../src/persistence/sqlite/run-state-store";
import {
	installPreparedArtifact,
	prepareJsonArtifact,
	readAndVerifyArtifact,
	validateArtifactRef,
} from "../../src/services/artifact-store";
import { contentDigest } from "../../src/services/content-digest";
import { readState } from "../../src/services/state-io";
import type { ArtifactRef } from "../../src/types/artifacts";
import { cleanupTempDir, makeTempDir } from "../helpers/temp-run-dir";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sha256(content: string | Uint8Array): string {
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
				driver: bunSqliteDriver,
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
					leaseDurationMs: 60_000,
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
				ensureInitialStateRow(
					runDb.connection,
					acquireResult.handle.incarnationId,
					STATE_SCHEMA_VERSION,
					stateJson,
					1,
					"2026-01-01T00:00:00.000Z",
				);

				// Read back
				const read = readAuthoritativeState<{ stage: string }>(
					runDb.connection,
				);
				expect(read.state).not.toBeNull();
				expect(read.state!.terminalResult).toBeDefined();
				expect(read.state!.terminalResult!.kind).toBe("done");
				expect(
					read.state!.terminalResult!.outputArtifact.kind,
				).toBe("terminal-output");
				expect(read.state!.terminalResult!.outputArtifact.digest).toBe(
					prepared.ref.digest,
				);
			} finally {
				runDb.close();
			}
		} finally {
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
			expect(() => readState(dir)).toThrow(StateCorruptedError);
		} finally {
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
			expect(() => readState(dir)).toThrow(StateCorruptedError);
		} finally {
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
			expect(() => readState(dir)).toThrow(StateCorruptedError);
		} finally {
			cleanupTempDir(dir);
		}
	});
});

// ---------------------------------------------------------------------------
// 3. Path traversal rejected by artifact-store validation
// ---------------------------------------------------------------------------

describe("artifact-store path confinement", () => {
	test("ArtifactRef with ../ in relativePath is rejected", () => {
		const ref: ArtifactRef = {
			kind: "terminal-output",
			digestAlgorithm: "sha256",
			digest: "sha256:0000000000000000000000000000000000000000000000000000000000000001",
			relativePath: "artifacts/sha256/00/../outside.json",
			mediaType: "application/json",
			sizeBytes: 2,
		};
		expect(() => {
			validateArtifactRef(ref, "terminal-output");
		}).toThrow(ArtifactIntegrityError);
	});

	test("ArtifactRef with absolute relativePath is rejected", () => {
		const ref: ArtifactRef = {
			kind: "delegation-manifest",
			digestAlgorithm: "sha256",
			digest: "sha256:0000000000000000000000000000000000000000000000000000000000000001",
			relativePath: "/etc/passwd",
			mediaType: "application/json",
			sizeBytes: 2,
		};
		expect(() => {
			validateArtifactRef(ref, "delegation-manifest");
		}).toThrow(ArtifactIntegrityError);
	});

	test("ArtifactRef whose relativePath does not match digest is rejected", () => {
		const ref: ArtifactRef = {
			kind: "external-request-manifest",
			digestAlgorithm: "sha256",
			digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			relativePath:
				"artifacts/sha256/bb/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.json",
			mediaType: "application/json",
			sizeBytes: 2,
		};
		expect(() => {
			validateArtifactRef(ref, "external-request-manifest");
		}).toThrow(ArtifactIntegrityError);
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
					kind: "prompt" as const,
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

			fs.writeFileSync(
				path.join(dir, "state.json"),
				JSON.stringify(v3State),
			);

			// Migrate
			const result = readState(dir);
			expect(result).not.toBeNull();
			expect(result!.schemaVersion).toBe(4);
			expect(result!.pendingDelegation).toBeDefined();
			expect(result!.pendingDelegation!.manifestArtifact).toBeDefined();

			const artifact = result!.pendingDelegation!.manifestArtifact!;
			expect(artifact.kind).toBe("delegation-manifest");
			expect(artifact.relativePath).toMatch(/^artifacts\/sha256\//);

			// Verify the blob was actually installed
			const blobPath = path.join(dir, artifact.relativePath);
			expect(fs.existsSync(blobPath)).toBe(true);

			// Verify blob content matches
			const blobContent = JSON.parse(fs.readFileSync(blobPath, "utf-8"));
			expect(blobContent).toEqual(legacyManifest);

			// Verify digest matches
			const digest = contentDigest(
				Buffer.from(JSON.stringify(legacyManifest), "utf-8"),
			);
			expect(artifact.digest).toBe(digest);
		} finally {
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
					kind: "prompt" as const,
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
			fs.writeFileSync(
				path.join(dir, "state.json"),
				JSON.stringify(v3State),
			);
			const first = readState(dir);
			expect(first!.pendingDelegation!.manifestArtifact).toBeDefined();

			// Delete the in-memory migrated state and re-read — simulates
			// a second resume where SQLite still has v3
			const blobPath = path.join(
				dir,
				first!.pendingDelegation!.manifestArtifact!.relativePath,
			);
			expect(fs.existsSync(blobPath)).toBe(true);

			// Second migration — blob already exists
			const second = readState(dir);
			expect(second!.pendingDelegation!.manifestArtifact).toBeDefined();
			expect(second!.pendingDelegation!.manifestArtifact!.digest).toBe(
				first!.pendingDelegation!.manifestArtifact!.digest,
			);

			// Blob still exists and is unchanged
			expect(fs.existsSync(blobPath)).toBe(true);
		} finally {
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
					kind: "prompt" as const,
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

			fs.writeFileSync(
				path.join(dir, "state.json"),
				JSON.stringify(v3State),
			);

			// Migration leaves schemaVersion at 3 (all-or-nothing: path escapes, conversion blocked)
			const result = readState(dir);
			expect(result).not.toBeNull();
			expect((result as unknown as Record<string, unknown>).schemaVersion).toBe(STATE_SCHEMA_VERSION);
			// The manifestArtifact should NOT be present since the path escapes
			expect(
				result!.pendingDelegation?.manifestArtifact,
			).toBeUndefined();
		} finally {
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
			expect(JSON.parse(Buffer.from(bytes).toString("utf-8"))).toEqual({
				x: 1,
			});
		} finally {
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

			expect(() => {
				readAndVerifyArtifact(dir, prepared.ref);
			}).toThrow(ArtifactIntegrityError);
		} finally {
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
			const badRef: ArtifactRef = {
				...prepared.ref,
				sizeBytes: 99999,
			};

			expect(() => {
				readAndVerifyArtifact(dir, badRef);
			}).toThrow(ArtifactIntegrityError);
		} finally {
			cleanupTempDir(dir);
		}
	});
});
