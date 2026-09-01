import assert from "node:assert/strict";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
// NIB-T §6 — state-io (T-SI-01..12, P-SI-a/b/c)
import { describe, test } from "node:test";
import { z } from "zod";
import { STATE_SCHEMA_VERSION } from "../../src/constants.js";
import {
	StateCorruptedError,
	StateMigrationBlockedError,
	StateVersionMismatchError,
} from "../../src/errors/concrete.js";
import {
	readState,
	readStateSnapshot,
	type StateFile,
	writeStateAtomic,
} from "../../src/services/state-io.js";
import { loadFixture } from "../helpers/fixture-loader.js";
import { cleanupTempDir, makeTempDir } from "../helpers/temp-run-dir.js";

const VALID_DIGEST =
	"sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
function buildState<S>(data: S): StateFile<S> {
	return {
		schemaVersion: STATE_SCHEMA_VERSION,
		runId: "01HX0000000000000000000001",
		orchestratorName: "x",
		startedAt: "2026-04-19T12:00:00.000Z",
		startedAtEpochMs: 0,
		lastTransitionAt: "2026-04-19T12:00:00.000Z",
		lastTransitionAtEpochMs: 0,
		currentPhase: "a",
		phasesExecuted: 0,
		accumulatedDurationMs: 0,
		data,
		usedLabels: [],
	};
}
describe("readState (T-SI-01..07)", () => {
	test("T-SI-01 | absent → null", () => {
		const dir = makeTempDir();
		try {
			assert.strictEqual(readState(dir), null);
		} finally {
			cleanupTempDir(dir);
		}
	});
	test("T-SI-02 | valid v2 → migrated typed StateFile", () => {
		const dir = makeTempDir();
		try {
			writeFileSync(
				join(dir, "state.json"),
				loadFixture("states/initial-empty.json"),
			);
			const state = readState(dir);
			assert.notStrictEqual(state, null);
			if (state === null) return;
			assert.ok(state.schemaVersion >= 3);
			assert.strictEqual(
				JSON.parse(readFileSync(join(dir, "state.json"), "utf-8"))
					.schemaVersion,
				2,
			);
		} finally {
			cleanupTempDir(dir);
		}
	});
	test("T-SI-03 | JSON invalide → StateCorruptedError", () => {
		const dir = makeTempDir();
		try {
			writeFileSync(join(dir, "state.json"), "{invalid json");
			assert.throws(() => readState(dir), StateCorruptedError);
		} finally {
			cleanupTempDir(dir);
		}
	});
	test("T-SI-04 | schemaVersion 1 → StateVersionMismatchError", () => {
		const dir = makeTempDir();
		try {
			writeFileSync(
				join(dir, "state.json"),
				loadFixture("states/version-mismatch.json"),
			);
			assert.throws(() => readState(dir), StateVersionMismatchError);
		} finally {
			cleanupTempDir(dir);
		}
	});
	test("T-SI-05 | missing schemaVersion → StateCorruptedError", () => {
		const dir = makeTempDir();
		try {
			writeFileSync(join(dir, "state.json"), JSON.stringify({ runId: "x" }));
			assert.throws(() => readState(dir), StateCorruptedError);
		} finally {
			cleanupTempDir(dir);
		}
	});
	test("T-SI-06 | valid + schema conforme", () => {
		const dir = makeTempDir();
		try {
			const state = buildState({ count: 5 });
			writeFileSync(join(dir, "state.json"), JSON.stringify(state));
			const schema = z.object({ count: z.number() });
			const read = readState(dir, schema);
			assert.notStrictEqual(read, null);
			assert.strictEqual(read?.data.count, 5);
		} finally {
			cleanupTempDir(dir);
		}
	});
	test("T-SI-07 | schema non-conforme → StateCorruptedError", () => {
		const dir = makeTempDir();
		try {
			const state = buildState({ count: "oops" });
			writeFileSync(join(dir, "state.json"), JSON.stringify(state));
			const schema = z.object({ count: z.number() });
			assert.throws(() => readState(dir, schema), StateCorruptedError);
		} finally {
			cleanupTempDir(dir);
		}
	});
});
describe("state v2 to v4 migration", () => {
	test("blocks a v2 state whose manifestPath is outside RUN_DIR", () => {
		const dir = makeTempDir();
		try {
			const legacy = JSON.parse(
				loadFixture("states/mid-run-agent-pending.json"),
			) as Record<string, unknown>;
			writeFileSync(join(dir, "state.json"), JSON.stringify(legacy));
			assert.throws(() => readStateSnapshot(dir), StateMigrationBlockedError);
			try {
				readStateSnapshot(dir);
			} catch (err) {
				assert.ok(err instanceof StateMigrationBlockedError);
				assert.strictEqual(
					(err as StateMigrationBlockedError).reason,
					"MANIFEST_OUTSIDE_RUN_DIR",
				);
			}
		} finally {
			cleanupTempDir(dir);
		}
	});
	test("migrates a v2 state without any pending record (no-op)", () => {
		const dir = makeTempDir();
		try {
			writeFileSync(
				join(dir, "state.json"),
				loadFixture("states/mid-run-no-pending.json"),
			);
			const result = readStateSnapshot(dir);
			assert.strictEqual(result.migratedFromVersion, 2);
			assert.strictEqual(result.state?.schemaVersion, STATE_SCHEMA_VERSION);
			assert.ok(!("pendingDelegation" in Object(result.state)));
			assert.ok(!("pendingExternalRequest" in Object(result.state)));
		} finally {
			cleanupTempDir(dir);
		}
	});
	test("migrates a v2 initial-empty state to v4 (no-op)", () => {
		const dir = makeTempDir();
		try {
			writeFileSync(
				join(dir, "state.json"),
				loadFixture("states/initial-empty.json"),
			);
			const state = readState(dir);
			assert.notStrictEqual(state, null);
			assert.strictEqual(state?.schemaVersion, STATE_SCHEMA_VERSION);
		} finally {
			cleanupTempDir(dir);
		}
	});
	test("rejects an external pending record mislabeled as state schema v2", () => {
		const dir = makeTempDir();
		try {
			const state = {
				...buildState({ count: 1 }),
				schemaVersion: 2,
				pendingExternalRequest: {
					requestId: "01HX0000000000000000000001/push-repo",
					label: "push-repo",
					requestType: "git.push",
					resumeAt: "resume",
					manifestPath: "/tmp/external-requests/push-repo.json",
					resultPath: "/tmp/external-results/push-repo.json",
					emittedAt: "2026-04-19T12:00:00.000Z",
					emittedAtEpochMs: 1,
				},
			};
			writeFileSync(join(dir, "state.json"), JSON.stringify(state));
			assert.throws(() => readState(dir), StateCorruptedError);
		} finally {
			cleanupTempDir(dir);
		}
	});
	test("rejects a v3 state containing both pending record kinds", () => {
		const dir = makeTempDir();
		try {
			const state = {
				...buildState({ count: 1 }),
				pendingDelegation: {
					label: "review",
					kind: "prompt",
					resumeAt: "resume",
					manifestPath: "/tmp/delegations/review-0.json",
					emittedAtEpochMs: 1,
					deadlineAtEpochMs: 2,
					attempt: 0,
					effectiveRetryPolicy: {
						maxAttempts: 3,
						backoffBaseMs: 1000,
						maxBackoffMs: 30000,
					},
				},
				pendingExternalRequest: {
					requestId: "01HX0000000000000000000001/push-repo",
					label: "push-repo",
					requestType: "git.push",
					resumeAt: "resume",
					manifestPath: "/tmp/external-requests/push-repo.json",
					resultPath: "/tmp/external-results/push-repo.json",
					emittedAt: "2026-04-19T12:00:00.000Z",
					emittedAtEpochMs: 1,
				},
			};
			writeFileSync(join(dir, "state.json"), JSON.stringify(state));
			assert.throws(() => readState(dir), StateCorruptedError);
		} finally {
			cleanupTempDir(dir);
		}
	});
});
describe("v3 to v4 migration", () => {
	test("no-op: v3 with no pending records migrates to v4", () => {
		const dir = makeTempDir();
		try {
			// A v3 state that has neither pendingDelegation nor pendingExternalRequest.
			// This is a clean state with no legacy manifest fields.
			const v3State = {
				...buildState({ count: 1 }),
				schemaVersion: 3,
			};
			writeFileSync(join(dir, "state.json"), JSON.stringify(v3State));
			const result = readStateSnapshot(dir);
			assert.strictEqual(result.migratedFromVersion, 3);
			assert.strictEqual(result.state?.schemaVersion, STATE_SCHEMA_VERSION);
			assert.deepStrictEqual(result.state?.data, { count: 1 });
		} finally {
			cleanupTempDir(dir);
		}
	});
	test("blocked: MANIFEST_MISSING when file does not exist inside run dir", () => {
		const dir = makeTempDir();
		try {
			const v3State = {
				...buildState({ count: 1 }),
				schemaVersion: 3,
				pendingDelegation: {
					label: "rev",
					kind: "prompt",
					resumeAt: "b",
					manifestPath: "delegations/missing.json",
					emittedAtEpochMs: 1,
					deadlineAtEpochMs: 2,
					attempt: 0,
					effectiveRetryPolicy: {
						maxAttempts: 3,
						backoffBaseMs: 1000,
						maxBackoffMs: 30000,
					},
				},
				usedLabels: ["rev"],
			};
			writeFileSync(join(dir, "state.json"), JSON.stringify(v3State));
			assert.throws(() => readStateSnapshot(dir), StateMigrationBlockedError);
			try {
				readStateSnapshot(dir);
			} catch (err) {
				assert.ok(err instanceof StateMigrationBlockedError);
				assert.strictEqual(
					(err as StateMigrationBlockedError).reason,
					"MANIFEST_MISSING",
				);
			}
		} finally {
			cleanupTempDir(dir);
		}
	});
	test("blocked: MANIFEST_SYMLINK when manifest is a symbolic link", () => {
		const dir = makeTempDir();
		try {
			// Create delegations directory
			mkdirSync(join(dir, "delegations"), { recursive: true });
			// Create a real file targeted by the manifest path
			const realFile = join(dir, "delegations", "real.json");
			writeFileSync(realFile, JSON.stringify({ kind: "delegation-manifest" }));
			// Create a symlink at the manifest path pointing to the real file
			const symlinkPath = join(dir, "delegations", "rev-0.json");
			symlinkSync(realFile, symlinkPath);
			const v3State = {
				...buildState({ count: 1 }),
				schemaVersion: 3,
				pendingDelegation: {
					label: "rev",
					kind: "prompt",
					resumeAt: "b",
					manifestPath: "delegations/rev-0.json",
					emittedAtEpochMs: 1,
					deadlineAtEpochMs: 2,
					attempt: 0,
					effectiveRetryPolicy: {
						maxAttempts: 3,
						backoffBaseMs: 1000,
						maxBackoffMs: 30000,
					},
				},
				usedLabels: ["rev"],
			};
			writeFileSync(join(dir, "state.json"), JSON.stringify(v3State));
			assert.throws(() => readStateSnapshot(dir), StateMigrationBlockedError);
			try {
				readStateSnapshot(dir);
			} catch (err) {
				assert.ok(err instanceof StateMigrationBlockedError);
				assert.strictEqual(
					(err as StateMigrationBlockedError).reason,
					"MANIFEST_SYMLINK",
				);
			}
		} finally {
			cleanupTempDir(dir);
		}
	});
	test("blocked: MANIFEST_NOT_REGULAR when manifest is a directory", () => {
		const dir = makeTempDir();
		try {
			// Create a directory at the manifest path instead of a file
			const manifestDir = join(dir, "delegations", "rev-0.json");
			mkdirSync(manifestDir, { recursive: true });
			const v3State = {
				...buildState({ count: 1 }),
				schemaVersion: 3,
				pendingDelegation: {
					label: "rev",
					kind: "prompt",
					resumeAt: "b",
					manifestPath: "delegations/rev-0.json",
					emittedAtEpochMs: 1,
					deadlineAtEpochMs: 2,
					attempt: 0,
					effectiveRetryPolicy: {
						maxAttempts: 3,
						backoffBaseMs: 1000,
						maxBackoffMs: 30000,
					},
				},
				usedLabels: ["rev"],
			};
			writeFileSync(join(dir, "state.json"), JSON.stringify(v3State));
			assert.throws(() => readStateSnapshot(dir), StateMigrationBlockedError);
			try {
				readStateSnapshot(dir);
			} catch (err) {
				assert.ok(err instanceof StateMigrationBlockedError);
				assert.strictEqual(
					(err as StateMigrationBlockedError).reason,
					"MANIFEST_NOT_REGULAR",
				);
			}
		} finally {
			cleanupTempDir(dir);
		}
	});
	test("blocked: MANIFEST_DIGEST_MISMATCH for external request", () => {
		const dir = makeTempDir();
		try {
			// Create a valid external request manifest with known content
			mkdirSync(join(dir, "external-requests"), { recursive: true });
			const manifestPath = join(dir, "external-requests", "push-repo.json");
			const manifestContent = JSON.stringify({
				kind: "external-request-manifest",
			});
			writeFileSync(manifestPath, manifestContent);
			const v3State = {
				...buildState({ count: 1 }),
				schemaVersion: 3,
				pendingExternalRequest: {
					requestId: "01HX0000000000000000000001/push-repo",
					label: "push-repo",
					requestType: "git.push",
					resumeAt: "resume",
					manifestPath: "external-requests/push-repo.json",
					manifestDigest:
						"sha256:0000000000000000000000000000000000000000000000000000000000000000",
					resultPath: "external-results/push-repo.json",
					emittedAt: "2026-04-19T12:00:00.000Z",
					emittedAtEpochMs: 1,
				},
				usedLabels: ["push-repo"],
			};
			writeFileSync(join(dir, "state.json"), JSON.stringify(v3State));
			assert.throws(() => readStateSnapshot(dir), StateMigrationBlockedError);
			try {
				readStateSnapshot(dir);
			} catch (err) {
				assert.ok(err instanceof StateMigrationBlockedError);
				assert.strictEqual(
					(err as StateMigrationBlockedError).reason,
					"MANIFEST_DIGEST_MISMATCH",
				);
			}
		} finally {
			cleanupTempDir(dir);
		}
	});
	test("successful: v3 delegation manifestPath converted to manifestArtifact", () => {
		const dir = makeTempDir();
		try {
			// Create a real manifest file inside the run dir
			mkdirSync(join(dir, "delegations"), { recursive: true });
			const manifestContent = JSON.stringify({
				kind: "delegation-manifest",
				skill: "test",
			});
			writeFileSync(join(dir, "delegations", "rev-0.json"), manifestContent);
			const v3State = {
				...buildState({ count: 1 }),
				schemaVersion: 3,
				pendingDelegation: {
					label: "rev",
					kind: "prompt",
					resumeAt: "b",
					manifestPath: "delegations/rev-0.json",
					emittedAtEpochMs: 1,
					deadlineAtEpochMs: 2,
					attempt: 0,
					effectiveRetryPolicy: {
						maxAttempts: 3,
						backoffBaseMs: 1000,
						maxBackoffMs: 30000,
					},
				},
				usedLabels: ["rev"],
			};
			writeFileSync(join(dir, "state.json"), JSON.stringify(v3State));
			const result = readStateSnapshot(dir);
			assert.strictEqual(result.migratedFromVersion, 3);
			assert.strictEqual(result.state?.schemaVersion, STATE_SCHEMA_VERSION);
			// Verify manifestArtifact was created and manifestPath removed
			const pd = (result.state as unknown as Record<string, unknown>)
				.pendingDelegation as Record<string, unknown>;
			assert.ok(!("manifestPath" in Object(pd)));
			assert.notStrictEqual(pd.manifestArtifact, undefined);
			const artifact = pd.manifestArtifact as Record<string, unknown>;
			assert.strictEqual(artifact.kind, "delegation-manifest");
			assert.strictEqual(artifact.digestAlgorithm, "sha256");
			assert.strictEqual(typeof artifact.digest, "string");
			assert.strictEqual(artifact.mediaType, "application/json");
			if (typeof artifact.relativePath !== "string") {
				assert.fail("expected the immutable artifact relative path");
			}
			assert.ok(artifact.relativePath.includes("artifacts/sha256/"));
			assert.strictEqual(
				artifact.sizeBytes,
				Buffer.byteLength(manifestContent),
			);
			// Verify the immutable blob was installed
			assert.strictEqual(existsSync(join(dir, artifact.relativePath)), true);
		} finally {
			cleanupTempDir(dir);
		}
	});
});
describe("writeStateAtomic (T-SI-08..12)", () => {
	test("T-SI-08 | first write → state.json present, tmp absent", () => {
		const dir = makeTempDir();
		try {
			const s = buildState({ a: 1 });
			writeStateAtomic(dir, s);
			assert.strictEqual(existsSync(join(dir, "state.json")), true);
			assert.strictEqual(existsSync(join(dir, "state.json.tmp")), false);
		} finally {
			cleanupTempDir(dir);
		}
	});
	test("T-SI-09 | replaces existing", () => {
		const dir = makeTempDir();
		try {
			writeStateAtomic(dir, buildState({ a: 1 }));
			writeStateAtomic(dir, buildState({ a: 2 }));
			const raw = readFileSync(join(dir, "state.json"), "utf-8");
			assert.ok(raw.includes('"a":2'));
			assert.strictEqual(existsSync(join(dir, "state.json.tmp")), false);
		} finally {
			cleanupTempDir(dir);
		}
	});
	test("T-SI-10 | schema fail → no write at all", () => {
		const dir = makeTempDir();
		try {
			const schema = z.object({ count: z.number() });
			const bad = buildState<{
				count: number;
			}>({
				count: "bad" as unknown as number,
			});
			assert.throws(
				() => writeStateAtomic(dir, bad, schema),
				StateCorruptedError,
			);
			assert.strictEqual(existsSync(join(dir, "state.json")), false);
			assert.strictEqual(existsSync(join(dir, "state.json.tmp")), false);
		} finally {
			cleanupTempDir(dir);
		}
	});
	test("T-SI-11 | tmp file left by interrupted write preserves previous state", () => {
		const dir = makeTempDir();
		try {
			writeStateAtomic(dir, buildState({ a: 1 }));
			writeFileSync(
				join(dir, "state.json.tmp"),
				JSON.stringify(buildState({ a: 2 })),
			);
			const read = readState<{
				a: number;
			}>(dir);
			assert.notStrictEqual(read, null);
			assert.deepStrictEqual(read?.data, { a: 1 });
		} finally {
			cleanupTempDir(dir);
		}
	});
	test("T-SI-12 | absent pending records stay absent in JSON", () => {
		const dir = makeTempDir();
		try {
			writeStateAtomic(dir, buildState({ a: 1 }));
			const raw = readFileSync(join(dir, "state.json"), "utf-8");
			assert.strictEqual(raw.includes("pendingDelegation"), false);
			assert.strictEqual(raw.includes("pendingExternalRequest"), false);
		} finally {
			cleanupTempDir(dir);
		}
	});
	test("writes and reads one pending external request", () => {
		const dir = makeTempDir();
		try {
			const state: StateFile<{
				a: number;
			}> = {
				...buildState({ a: 1 }),
				pendingExternalRequest: {
					requestId: "01HX0000000000000000000001/push-repo",
					label: "push-repo",
					requestType: "git.push",
					resumeAt: "resume",
					manifestPath: "/tmp/external-requests/push-repo.json",
					resultPath: "/tmp/external-results/push-repo.json",
					emittedAt: "2026-04-19T12:00:00.000Z",
					emittedAtEpochMs: 1,
					manifestDigest: VALID_DIGEST,
				},
				usedLabels: ["push-repo"],
			};
			writeStateAtomic(dir, state);
			assert.deepStrictEqual(
				readState(dir)?.pendingExternalRequest,
				state.pendingExternalRequest,
			);
		} finally {
			cleanupTempDir(dir);
		}
	});
	test("rejects a pending external request without a manifest digest", () => {
		const dir = makeTempDir();
		try {
			const state = {
				...buildState({ a: 1 }),
				pendingExternalRequest: {
					requestId: "01HX0000000000000000000001/push-repo",
					label: "push-repo",
					requestType: "git.push",
					resumeAt: "resume",
					manifestPath: "/tmp/external-requests/push-repo.json",
					resultPath: "/tmp/external-results/push-repo.json",
					emittedAt: "2026-04-19T12:00:00.000Z",
					emittedAtEpochMs: 1,
				},
				usedLabels: ["push-repo"],
			};
			writeFileSync(join(dir, "state.json"), JSON.stringify(state));
			assert.throws(() => readState(dir), StateCorruptedError);
		} finally {
			cleanupTempDir(dir);
		}
	});
	test("requires accepted resolution metadata to be all-or-none", () => {
		const dir = makeTempDir();
		try {
			const state = {
				...buildState({ a: 1 }),
				pendingExternalRequest: {
					requestId: "01HX0000000000000000000001/push-repo",
					label: "push-repo",
					requestType: "git.push",
					resumeAt: "resume",
					manifestPath: "/tmp/external-requests/push-repo.json",
					manifestDigest: VALID_DIGEST,
					resultPath: "/tmp/external-results/push-repo.json",
					emittedAt: "2026-04-19T12:00:00.000Z",
					emittedAtEpochMs: 1,
					acceptedResolutionPath:
						"/tmp/accepted-external-resolutions/push-repo.json",
				},
				usedLabels: ["push-repo"],
			};
			writeFileSync(join(dir, "state.json"), JSON.stringify(state));
			assert.throws(() => readState(dir), StateCorruptedError);
		} finally {
			cleanupTempDir(dir);
		}
	});
	test("round-trips a fully accepted external resolution descriptor", () => {
		const dir = makeTempDir();
		try {
			const state: StateFile<{
				a: number;
			}> = {
				...buildState({ a: 1 }),
				pendingExternalRequest: {
					requestId: "01HX0000000000000000000001/push-repo",
					label: "push-repo",
					requestType: "git.push",
					resumeAt: "resume",
					manifestPath: "/tmp/external-requests/push-repo.json",
					manifestDigest: VALID_DIGEST,
					resultPath: "/tmp/external-results/push-repo.json",
					emittedAt: "2026-04-19T12:00:00.000Z",
					emittedAtEpochMs: 1,
					acceptedResolutionPath:
						"/tmp/accepted-external-resolutions/push-repo.json",
					acceptedResolutionDigest: VALID_DIGEST,
					acceptedAt: "2026-04-19T12:01:00.000Z",
				},
				usedLabels: ["push-repo"],
			};
			writeStateAtomic(dir, state);
			assert.deepStrictEqual(
				readState(dir)?.pendingExternalRequest,
				state.pendingExternalRequest,
			);
		} finally {
			cleanupTempDir(dir);
		}
	});
});
describe("state-io properties (P-SI-a/b/c)", () => {
	test("P-SI-a | round-trip structural identity", () => {
		const dir = makeTempDir();
		try {
			const s = buildState({ x: "y", arr: [1, 2] });
			writeStateAtomic(dir, s);
			const read = readState<{
				x: string;
				arr: number[];
			}>(dir);
			assert.deepStrictEqual(read, s);
		} finally {
			cleanupTempDir(dir);
		}
	});
	test("P-SI-b | repeated reads observe only complete state files", () => {
		const dir = makeTempDir();
		try {
			writeStateAtomic(dir, buildState({ n: 0 }));
			for (let i = 0; i < 10; i++) {
				writeStateAtomic(dir, buildState({ n: i }));
				for (let r = 0; r < 5; r++) {
					const read = readState(dir);
					assert.notStrictEqual(read, null);
				}
			}
		} finally {
			cleanupTempDir(dir);
		}
	});
	test("P-SI-c | no tmp residual after successful write", () => {
		const dir = makeTempDir();
		try {
			for (let i = 0; i < 20; i++) {
				writeStateAtomic(dir, buildState({ i }));
				assert.strictEqual(existsSync(join(dir, "state.json.tmp")), false);
			}
		} finally {
			cleanupTempDir(dir);
		}
	});
});
