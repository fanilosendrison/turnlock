import { describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { ProtocolAction } from "../../src/services/protocol";
import type { OrchestratorEvent } from "../../src/types/events";
import {
	buildEntrypointSource,
	countProtocolBlocks,
	createE2EWorkspace,
	parseSingleProtocolBlock,
	readEvents,
	readStateFile,
	writeExternalResolution,
	writeMalformedExternalResolution,
} from "../helpers/e2e-process";

const RUN_IDS = {
	malformed: "01HX0000000000000000000033",
	unreadable: "01HX0000000000000000000034",
	schema: "01HX0000000000000000000035",
	orphan: "01HX0000000000000000000036",
	pathEscape: "01HX0000000000000000000042",
	symlink: "01HX0000000000000000000043",
	manifestMismatch: "01HX0000000000000000000045",
	manifestPayloadTamper: "01HX0000000000000000000046",
	manifestMetadataTamper: "01HX0000000000000000000047",
	manifestRequestTypeTamper: "01HX0000000000000000000048",
	acceptedResolutionTamper: "01HX0000000000000000000050",
	acceptedResolutionRecovery: "01HX0000000000000000000051",
} as const;

function baseResumeCommandSource(): string {
	return '(runId) => "bun " + import.meta.path + " --run-id " + runId + " --resume"';
}

function expectProtocol(stdout: string, action: ProtocolAction, runId: string) {
	expect(countProtocolBlocks(stdout)).toBe(1);
	const block = parseSingleProtocolBlock(stdout);
	expect(block.action).toBe(action);
	expect(block.runId).toBe(runId);
	return block;
}

function eventTypes(events: readonly OrchestratorEvent[]): string[] {
	return events.map((event) => event.eventType);
}

function failureSource(orchestratorName: string): string {
	return buildEntrypointSource(`
interface State { stage: string }

await runOrchestrator<State>({
	name: ${JSON.stringify(orchestratorName)},
	initial: "request",
	initialState: { stage: "initial" },
	resumeCommand: ${baseResumeCommandSource()},
	phases: {
		request: definePhase<State>(async (_state, io) =>
			io.requestExternal(
				{ label: "external-work", requestType: "example.work", payload: { secret: "not-for-logs" } },
				"consume",
				{ stage: "waiting" },
			),
		),
		consume: definePhase<State>(async (_state, io) => {
			const resolution = io.consumePendingExternalResolution(
				z.object({ outcome: z.enum(["OK", "FAILED"]) }),
			);
			return io.done(resolution);
		}),
	},
});
`);
}

describe("external resolution failures are terminal and non-retrying", () => {
	test("malformed JSON fails closed without changing the manifest or creating another request", async () => {
		const workspace = createE2EWorkspace();
		const entrypoint = workspace.writeEntrypoint(
			"external-malformed.ts",
			failureSource("e2e-external-malformed"),
		);
		try {
			const initial = await workspace.runEntrypoint(entrypoint, [
				"--run-id",
				RUN_IDS.malformed,
			]);
			const request = expectProtocol(
				initial.stdout,
				"REQUEST_EXTERNAL",
				RUN_IDS.malformed,
			);
			const runDir = workspace.runDir(
				"e2e-external-malformed",
				RUN_IDS.malformed,
			);
			const manifestPath = request.fields.manifest as string;
			const manifestBefore = readFileSync(manifestPath, "utf-8");
			writeMalformedExternalResolution(runDir, "external-work", '{"outcome":');

			const resumed = await workspace.runEntrypoint(entrypoint, [
				"--resume",
				"--run-id",
				RUN_IDS.malformed,
			]);
			expect(resumed.exitCode).toBe(1);
			const error = expectProtocol(resumed.stdout, "ERROR", RUN_IDS.malformed);
			expect(error.fields.errorKind).toBe("external_resolution_malformed");
			expect(readFileSync(manifestPath, "utf-8")).toBe(manifestBefore);
			expect(readdirSync(join(runDir, "external-requests"))).toEqual([
				"external-work.json",
			]);
			expect(
				readdirSync(join(runDir, "accepted-external-resolutions")),
			).toEqual([]);
			const state = readStateFile<{ stage: string }>(runDir);
			expect(state.pendingExternalRequest?.requestId).toBe(
				`${RUN_IDS.malformed}/external-work`,
			);
			const events = readEvents(runDir);
			expect(events).toContainEqual(
				expect.objectContaining({
					eventType: "external_resolution_validation_failed",
					reason: "malformed_json",
				}),
			);
			expect(eventTypes(events)).not.toContain("retry_scheduled");
			expect(eventTypes(events)).not.toContain("external_request_reemit");
			expect(resultHasSensitiveData(events, resumed.stderr)).toBe(false);
		} finally {
			workspace.cleanup();
		}
	});

	test("an unreadable resolution path fails closed without retry", async () => {
		const workspace = createE2EWorkspace();
		const entrypoint = workspace.writeEntrypoint(
			"external-unreadable.ts",
			failureSource("e2e-external-unreadable"),
		);
		try {
			const initial = await workspace.runEntrypoint(entrypoint, [
				"--run-id",
				RUN_IDS.unreadable,
			]);
			expect(initial.exitCode).toBe(0);
			const runDir = workspace.runDir(
				"e2e-external-unreadable",
				RUN_IDS.unreadable,
			);
			mkdirSync(join(runDir, "external-results", "external-work.json"));

			const resumed = await workspace.runEntrypoint(entrypoint, [
				"--resume",
				"--run-id",
				RUN_IDS.unreadable,
			]);
			expect(resumed.exitCode).toBe(1);
			const error = expectProtocol(resumed.stdout, "ERROR", RUN_IDS.unreadable);
			expect(error.fields.errorKind).toBe("external_resolution_malformed");
			const events = readEvents(runDir);
			expect(events).toContainEqual(
				expect.objectContaining({
					eventType: "external_resolution_validation_failed",
					reason: "unreadable",
				}),
			);
			expect(eventTypes(events)).not.toContain("retry_scheduled");
		} finally {
			workspace.cleanup();
		}
	});

	test("schema-invalid JSON fails with its dedicated error and no delegation retry", async () => {
		const workspace = createE2EWorkspace();
		const entrypoint = workspace.writeEntrypoint(
			"external-schema.ts",
			failureSource("e2e-external-schema"),
		);
		try {
			const initial = await workspace.runEntrypoint(entrypoint, [
				"--run-id",
				RUN_IDS.schema,
			]);
			expect(initial.exitCode).toBe(0);
			const runDir = workspace.runDir("e2e-external-schema", RUN_IDS.schema);
			writeExternalResolution(runDir, "external-work", { outcome: 42 });

			const resumed = await workspace.runEntrypoint(entrypoint, [
				"--resume",
				"--run-id",
				RUN_IDS.schema,
			]);
			expect(resumed.exitCode).toBe(1);
			const error = expectProtocol(resumed.stdout, "ERROR", RUN_IDS.schema);
			expect(error.fields.errorKind).toBe("external_resolution_schema");
			const events = readEvents(runDir);
			expect(events).toContainEqual(
				expect.objectContaining({
					eventType: "external_resolution_validation_failed",
					reason: "schema_invalid",
				}),
			);
			expect(eventTypes(events)).not.toContain("retry_scheduled");
			expect(readdirSync(join(runDir, "external-requests"))).toEqual([
				"external-work.json",
			]);
		} finally {
			workspace.cleanup();
		}
	});

	test("an accepted schema-invalid resolution cannot be replaced or tampered with", async () => {
		const workspace = createE2EWorkspace();
		const entrypoint = workspace.writeEntrypoint(
			"external-accepted-tamper.ts",
			failureSource("e2e-external-accepted-tamper"),
		);
		try {
			const initial = await workspace.runEntrypoint(entrypoint, [
				"--run-id",
				RUN_IDS.acceptedResolutionTamper,
			]);
			expect(initial.exitCode).toBe(0);
			const runDir = workspace.runDir(
				"e2e-external-accepted-tamper",
				RUN_IDS.acceptedResolutionTamper,
			);
			writeExternalResolution(runDir, "external-work", { outcome: 42 });

			const firstResume = await workspace.runEntrypoint(entrypoint, [
				"--resume",
				"--run-id",
				RUN_IDS.acceptedResolutionTamper,
			]);
			expect(firstResume.exitCode).toBe(1);
			expect(
				expectProtocol(
					firstResume.stdout,
					"ERROR",
					RUN_IDS.acceptedResolutionTamper,
				).fields.errorKind,
			).toBe("external_resolution_schema");

			const acceptedState = readStateFile<{ stage: string }>(runDir);
			const acceptedPath =
				acceptedState.pendingExternalRequest?.acceptedResolutionPath;
			expect(acceptedPath).toBe(
				join(runDir, "accepted-external-resolutions", "external-work.json"),
			);
			const acceptedBefore = readFileSync(acceptedPath as string, "utf-8");
			expect(acceptedBefore).toBe('{"outcome":42}');

			writeExternalResolution(runDir, "external-work", { outcome: "OK" });
			const secondResume = await workspace.runEntrypoint(entrypoint, [
				"--resume",
				"--run-id",
				RUN_IDS.acceptedResolutionTamper,
			]);
			expect(secondResume.exitCode).toBe(1);
			expect(
				expectProtocol(
					secondResume.stdout,
					"ERROR",
					RUN_IDS.acceptedResolutionTamper,
				).fields.errorKind,
			).toBe("external_resolution_schema");
			expect(readFileSync(acceptedPath as string, "utf-8")).toBe(
				acceptedBefore,
			);

			writeFileSync(acceptedPath as string, '{"outcome":"OK"}');
			const tamperedResume = await workspace.runEntrypoint(entrypoint, [
				"--resume",
				"--run-id",
				RUN_IDS.acceptedResolutionTamper,
			]);
			expect(tamperedResume.exitCode).toBe(1);
			expect(
				expectProtocol(
					tamperedResume.stdout,
					"ERROR",
					RUN_IDS.acceptedResolutionTamper,
				).fields.errorKind,
			).toBe("state_corrupted");
			expect(eventTypes(readEvents(runDir))).not.toContain("retry_scheduled");
		} finally {
			workspace.cleanup();
		}
	});

	test("an accepted artifact is recovered when its state descriptor was not committed", async () => {
		const workspace = createE2EWorkspace();
		const entrypoint = workspace.writeEntrypoint(
			"external-accepted-recovery.ts",
			failureSource("e2e-external-accepted-recovery"),
		);
		try {
			const initial = await workspace.runEntrypoint(entrypoint, [
				"--run-id",
				RUN_IDS.acceptedResolutionRecovery,
			]);
			expect(initial.exitCode).toBe(0);
			const runDir = workspace.runDir(
				"e2e-external-accepted-recovery",
				RUN_IDS.acceptedResolutionRecovery,
			);
			writeExternalResolution(runDir, "external-work", { outcome: 42 });

			const accepted = await workspace.runEntrypoint(entrypoint, [
				"--resume",
				"--run-id",
				RUN_IDS.acceptedResolutionRecovery,
			]);
			expect(accepted.exitCode).toBe(1);
			const statePath = join(runDir, "state.json");
			const state = JSON.parse(readFileSync(statePath, "utf-8")) as {
				pendingExternalRequest: Record<string, unknown>;
			};
			const acceptedPath = state.pendingExternalRequest
				.acceptedResolutionPath as string;
			const acceptedBefore = readFileSync(acceptedPath, "utf-8");
			Reflect.deleteProperty(
				state.pendingExternalRequest,
				"acceptedResolutionPath",
			);
			Reflect.deleteProperty(
				state.pendingExternalRequest,
				"acceptedResolutionDigest",
			);
			Reflect.deleteProperty(state.pendingExternalRequest, "acceptedAt");
			writeFileSync(statePath, JSON.stringify(state));
			writeExternalResolution(runDir, "external-work", { outcome: "OK" });

			const recovered = await workspace.runEntrypoint(entrypoint, [
				"--resume",
				"--run-id",
				RUN_IDS.acceptedResolutionRecovery,
			]);
			expect(recovered.exitCode).toBe(1);
			expect(
				expectProtocol(
					recovered.stdout,
					"ERROR",
					RUN_IDS.acceptedResolutionRecovery,
				).fields.errorKind,
			).toBe("external_resolution_schema");
			const recoveredState = readStateFile<{ stage: string }>(runDir);
			expect(
				recoveredState.pendingExternalRequest?.acceptedResolutionPath,
			).toBe(acceptedPath);
			expect(
				recoveredState.pendingExternalRequest?.acceptedResolutionDigest,
			).toMatch(/^sha256:[0-9a-f]{64}$/);
			expect(readFileSync(acceptedPath, "utf-8")).toBe(acceptedBefore);
		} finally {
			workspace.cleanup();
		}
	});
});

function resultHasSensitiveData(
	events: readonly OrchestratorEvent[],
	stderr: string,
): boolean {
	return (
		JSON.stringify(events).includes("not-for-logs") ||
		stderr.includes("not-for-logs")
	);
}

describe("external request manifest identity", () => {
	async function expectManifestTamperRejected(
		runId: string,
		orchestratorName: string,
		mutate: (manifest: Record<string, unknown>) => Record<string, unknown>,
	): Promise<void> {
		const workspace = createE2EWorkspace();
		const entrypoint = workspace.writeEntrypoint(
			`${orchestratorName}.ts`,
			failureSource(orchestratorName),
		);
		try {
			const initial = await workspace.runEntrypoint(entrypoint, [
				"--run-id",
				runId,
			]);
			expectProtocol(initial.stdout, "REQUEST_EXTERNAL", runId);
			const runDir = workspace.runDir(orchestratorName, runId);

			// Read state to find the immutable blob path.
			const state = readStateFile<{ stage: string }>(runDir);
			const artifactRef = state.pendingExternalRequest?.manifestArtifact;
			if (!artifactRef) {
				throw new Error("manifestArtifact missing from state");
			}
			const blobPath = join(runDir, artifactRef.relativePath);

			// Tamper with the immutable blob, not the canonical projection.
			const blob = JSON.parse(readFileSync(blobPath, "utf-8")) as Record<
				string,
				unknown
			>;
			writeFileSync(blobPath, JSON.stringify(mutate(blob)));

			const resumed = await workspace.runEntrypoint(entrypoint, [
				"--resume",
				"--run-id",
				runId,
			]);
			expect(resumed.exitCode).toBe(1);
			const error = expectProtocol(resumed.stdout, "ERROR", runId);
			// Tampering with the immutable blob causes an artifact integrity error.
			expect(error.fields.errorKind).toBe("artifact_integrity");
			const types = eventTypes(readEvents(runDir));
			expect(types).not.toContain("external_request_reemit");
			expect(types).not.toContain("external_resolution_read");
		} finally {
			workspace.cleanup();
		}
	}

	test("changing manifest payload under the same requestId fails closed", async () => {
		await expectManifestTamperRejected(
			RUN_IDS.manifestPayloadTamper,
			"e2e-external-manifest-payload-tamper",
			(manifest) => ({ ...manifest, payload: { changed: true } }),
		);
	});

	test("changing manifest metadata under the same requestId fails closed", async () => {
		await expectManifestTamperRejected(
			RUN_IDS.manifestMetadataTamper,
			"e2e-external-manifest-metadata-tamper",
			(manifest) => ({ ...manifest, metadata: { changed: true } }),
		);
	});

	test("changing manifest requestType under the same requestId fails closed", async () => {
		await expectManifestTamperRejected(
			RUN_IDS.manifestRequestTypeTamper,
			"e2e-external-manifest-request-type-tamper",
			(manifest) => ({ ...manifest, requestType: "example.changed" }),
		);
	});

	test("a manifest identity mismatch fails closed even when a resolution exists", async () => {
		const workspace = createE2EWorkspace();
		const entrypoint = workspace.writeEntrypoint(
			"external-manifest-mismatch.ts",
			failureSource("e2e-external-manifest-mismatch"),
		);
		try {
			const initial = await workspace.runEntrypoint(entrypoint, [
				"--run-id",
				RUN_IDS.manifestMismatch,
			]);
			expectProtocol(
				initial.stdout,
				"REQUEST_EXTERNAL",
				RUN_IDS.manifestMismatch,
			);
			const runDir = workspace.runDir(
				"e2e-external-manifest-mismatch",
				RUN_IDS.manifestMismatch,
			);
			// Read state to find the immutable blob path.
			const state = readStateFile<{ stage: string }>(runDir);
			const artifactRef = state.pendingExternalRequest?.manifestArtifact;
			if (!artifactRef) {
				throw new Error("manifestArtifact missing from state");
			}
			const blobPath = join(runDir, artifactRef.relativePath);
			const manifest = JSON.parse(readFileSync(blobPath, "utf-8")) as Record<
				string,
				unknown
			>;
			writeFileSync(
				blobPath,
				JSON.stringify({ ...manifest, orchestratorName: "other-orchestrator" }),
			);
			writeExternalResolution(runDir, "external-work", { outcome: "OK" });

			const resumed = await workspace.runEntrypoint(entrypoint, [
				"--resume",
				"--run-id",
				RUN_IDS.manifestMismatch,
			]);
			expect(resumed.exitCode).toBe(1);
			const error = expectProtocol(
				resumed.stdout,
				"ERROR",
				RUN_IDS.manifestMismatch,
			);
			expect(error.fields.errorKind).toBe("artifact_integrity");
			const types = eventTypes(readEvents(runDir));
			expect(types).not.toContain("external_resolution_read");
			expect(types).not.toContain("retry_scheduled");
		} finally {
			workspace.cleanup();
		}
	});
});

describe("external request path confinement", () => {
	test("a persisted result path outside RUN_DIR is rejected as corrupted state", async () => {
		const workspace = createE2EWorkspace();
		const entrypoint = workspace.writeEntrypoint(
			"external-path-escape.ts",
			failureSource("e2e-external-path-escape"),
		);
		try {
			const initial = await workspace.runEntrypoint(entrypoint, [
				"--run-id",
				RUN_IDS.pathEscape,
			]);
			expect(initial.exitCode).toBe(0);
			const runDir = workspace.runDir(
				"e2e-external-path-escape",
				RUN_IDS.pathEscape,
			);

			const outsidePath = join(workspace.root, "outside-resolution.json");
			writeFileSync(outsidePath, '{"outcome":"OK","secret":"outside"}');

			// Tamper with the SQLite authoritative state, not state.json.
			const { Database } = await import("bun:sqlite");
			const dbPath = join(runDir, "turnlock.sqlite3");
			const db = new Database(dbPath);
			try {
				const row = db
					.query("SELECT state_json FROM run_state WHERE singleton = 1")
					.get() as { state_json: string } | undefined;
				if (row) {
					const parsed = JSON.parse(row.state_json) as Record<string, unknown>;
					const pending = parsed.pendingExternalRequest as Record<
						string,
						unknown
					>;
					pending.resultPath = outsidePath;
					db.run("UPDATE run_state SET state_json = ? WHERE singleton = 1", [
						JSON.stringify(parsed),
					]);
				}
			} finally {
				db.close();
			}

			const resumed = await workspace.runEntrypoint(entrypoint, [
				"--resume",
				"--run-id",
				RUN_IDS.pathEscape,
			]);
			expect(resumed.exitCode).toBe(1);
			const error = expectProtocol(resumed.stdout, "ERROR", RUN_IDS.pathEscape);
			expect(error.fields.errorKind).toBe("state_corrupted");
			expect(resumed.stderr).not.toContain("outside");
		} finally {
			workspace.cleanup();
		}
	});

	test("a symlink resolution is rejected without reading its target", async () => {
		const workspace = createE2EWorkspace();
		const entrypoint = workspace.writeEntrypoint(
			"external-symlink.ts",
			failureSource("e2e-external-symlink"),
		);
		try {
			const initial = await workspace.runEntrypoint(entrypoint, [
				"--run-id",
				RUN_IDS.symlink,
			]);
			expect(initial.exitCode).toBe(0);
			const runDir = workspace.runDir("e2e-external-symlink", RUN_IDS.symlink);
			const outsidePath = join(workspace.root, "symlink-target.json");
			writeFileSync(outsidePath, '{"outcome":"OK","secret":"target"}');
			symlinkSync(
				outsidePath,
				join(runDir, "external-results", "external-work.json"),
			);

			const resumed = await workspace.runEntrypoint(entrypoint, [
				"--resume",
				"--run-id",
				RUN_IDS.symlink,
			]);
			expect(resumed.exitCode).toBe(1);
			const error = expectProtocol(resumed.stdout, "ERROR", RUN_IDS.symlink);
			expect(error.fields.errorKind).toBe("external_resolution_malformed");
			expect(resumed.stderr).not.toContain("target");
		} finally {
			workspace.cleanup();
		}
	});
});

describe("external request local crash windows", () => {
	test("an orphan manifest is non-authoritative when state.json is absent", async () => {
		const workspace = createE2EWorkspace();
		const entrypoint = workspace.writeEntrypoint(
			"external-orphan.ts",
			failureSource("e2e-external-orphan"),
		);
		const runDir = workspace.runDir("e2e-external-orphan", RUN_IDS.orphan);
		const manifestPath = join(
			runDir,
			"external-requests",
			"external-work.json",
		);
		try {
			mkdirSync(join(runDir, "external-requests"), { recursive: true });
			writeFileSync(manifestPath, '{"kind":"external-request"}');

			const resumed = await workspace.runEntrypoint(entrypoint, [
				"--resume",
				"--run-id",
				RUN_IDS.orphan,
			]);
			expect(resumed.exitCode).toBe(1);
			const error = expectProtocol(resumed.stdout, "ERROR", RUN_IDS.orphan);
			expect(error.fields.errorKind).toBe("state_missing");
			expect(existsSync(join(runDir, "state.json"))).toBe(false);
			expect(readFileSync(manifestPath, "utf-8")).toBe(
				'{"kind":"external-request"}',
			);
		} finally {
			workspace.cleanup();
		}
	});
});
