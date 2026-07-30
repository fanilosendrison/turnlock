import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
	type ExternalRequestContext,
	externalRequestBinding,
} from "../../src/bindings/external-request";
import { EXTERNAL_REQUEST_MANIFEST_VERSION } from "../../src/constants";
import { parseProtocolBlock } from "../../src/services/protocol";

const RUN_ID = "01HX0000000000000000000001";
const RUN_DIR = "/tmp/turnlock/external-request-test";
const CONTEXT: ExternalRequestContext = {
	runId: RUN_ID,
	orchestratorName: "external-test",
	phase: "push",
	resumeAt: "after-push",
	emittedAt: "2026-04-19T12:00:00.000Z",
	emittedAtEpochMs: 1_745_062_800_000,
	runDir: RUN_DIR,
};

describe("external request manifest binding", () => {
	test("builds a versioned opaque manifest with stable identity and paths", () => {
		const manifest = externalRequestBinding.buildManifest(
			{
				label: "push-repo-a",
				requestType: "git.push",
				payload: {
					repository: "/repo-a",
					remote: "origin",
					branch: "main",
					targetSha: "abc123",
				},
				metadata: { requestedBy: "pipeline" },
			},
			CONTEXT,
		);

		expect(manifest).toEqual({
			manifestVersion: EXTERNAL_REQUEST_MANIFEST_VERSION,
			kind: "external-request",
			requestId: `${RUN_ID}/push-repo-a`,
			runId: RUN_ID,
			orchestratorName: "external-test",
			phase: "push",
			resumeAt: "after-push",
			label: "push-repo-a",
			requestType: "git.push",
			payload: {
				repository: "/repo-a",
				remote: "origin",
				branch: "main",
				targetSha: "abc123",
			},
			metadata: { requestedBy: "pipeline" },
			emittedAt: CONTEXT.emittedAt,
			emittedAtEpochMs: CONTEXT.emittedAtEpochMs,
			resultPath: join(RUN_DIR, "external-results", "push-repo-a.json"),
		});
		expect(manifest).not.toHaveProperty("attempt");
		expect(manifest).not.toHaveProperty("retry");
		expect(manifest).not.toHaveProperty("workerLease");
	});

	test("omits metadata when it was not supplied", () => {
		const manifest = externalRequestBinding.buildManifest(
			{
				label: "notify",
				requestType: "notification.send",
				payload: null,
			},
			CONTEXT,
		);

		expect("metadata" in manifest).toBe(false);
	});

	test("is pure for the same request and context", () => {
		const request = {
			label: "push-repo-a",
			requestType: "git.push",
			payload: { targetSha: "abc123" },
		} as const;
		expect(externalRequestBinding.buildManifest(request, CONTEXT)).toEqual(
			externalRequestBinding.buildManifest(request, CONTEXT),
		);
	});
});

describe("external request protocol binding", () => {
	test("emits REQUEST_EXTERNAL with the manifest and resolution paths", () => {
		const manifest = externalRequestBinding.buildManifest(
			{
				label: "push-repo-a",
				requestType: "git.push",
				payload: { targetSha: "abc123" },
			},
			CONTEXT,
		);
		const manifestPath = join(RUN_DIR, "external-requests", "push-repo-a.json");
		const block = externalRequestBinding.buildProtocolBlock(
			manifest,
			manifestPath,
			`bun main.ts --run-id ${RUN_ID} --resume`,
		);
		const parsed = parseProtocolBlock(block);

		expect(parsed?.action).toBe("REQUEST_EXTERNAL");
		expect(parsed?.runId).toBe(RUN_ID);
		expect(parsed?.fields.requestId).toBe(`${RUN_ID}/push-repo-a`);
		expect(parsed?.fields.requestType).toBe("git.push");
		expect(parsed?.fields.manifest).toBe(manifestPath);
		expect(parsed?.fields.result).toBe(manifest.resultPath);
	});
});
