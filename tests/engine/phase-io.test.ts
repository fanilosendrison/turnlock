import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { z } from "zod";
import type { DispatchContext, LoadedResults } from "../../src/engine/context";
import { buildPhaseIO, type PhaseIOGuards } from "../../src/engine/phase-io";
import {
	ExternalResolutionMissingError,
	ExternalResolutionSchemaError,
	ProtocolError,
} from "../../src/errors/concrete";
import type {
	PendingDelegationRecord,
	PendingExternalRequestRecord,
} from "../../src/services/state-io";
import type { JsonValue } from "../../src/types/external-request";
import { createMockLogger } from "../helpers/mock-logger";
import { cleanupTempDir, makeTempDir } from "../helpers/temp-run-dir";

interface TestState {
	readonly count: number;
}

const RUN_ID = "01HX0000000000000000000001";

function makeGuards(): PhaseIOGuards {
	return {
		committed: { value: false },
		committedResult: { value: null },
		consumedCount: { value: 0 },
	};
}

function makePendingExternal(runDir: string): PendingExternalRequestRecord {
	return {
		requestId: `${RUN_ID}/push-repo`,
		label: "push-repo",
		requestType: "git.push",
		resumeAt: "resume",
		manifestPath: join(runDir, "external-requests", "push-repo.json"),
		manifestDigest:
			"sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
		resultPath: join(runDir, "external-results", "push-repo.json"),
		emittedAt: "2026-04-19T12:00:00.000Z",
		emittedAtEpochMs: 1_745_062_800_000,
	};
}

function makePendingDelegation(): PendingDelegationRecord {
	return {
		label: "review",
		kind: "prompt",
		resumeAt: "resume",
		manifestPath: "/tmp/delegations/review-0.json",
		emittedAtEpochMs: 1_745_062_800_000,
		deadlineAtEpochMs: 1_745_063_400_000,
		attempt: 0,
		effectiveRetryPolicy: {
			maxAttempts: 3,
			backoffBaseMs: 1000,
			maxBackoffMs: 30_000,
		},
	};
}

function buildIO(options: {
	readonly runDir: string;
	readonly pendingDelegation?: PendingDelegationRecord;
	readonly pendingExternalRequest?: PendingExternalRequestRecord;
	readonly loadedResults?: LoadedResults;
	readonly usedLabels?: readonly string[];
	readonly guards?: PhaseIOGuards;
}) {
	const logger = createMockLogger();
	const ctx: DispatchContext<TestState> = {
		config: {
			name: "phase-io-test",
			initial: "start",
			initialState: { count: 0 },
			resumeCommand: (runId) => `bun main.ts --run-id ${runId} --resume`,
			phases: {
				start: async (_state, io) => io.done({ ok: true }),
				resume: async (_state, io) => io.done({ ok: true }),
			},
		},
		runId: RUN_ID,
		runDir: options.runDir,
		lockPath: join(options.runDir, ".lock"),
		handle: { ownerToken: "owner", lockPath: join(options.runDir, ".lock") },
		logger,
		abortController: new AbortController(),
		currentPhase: "resume",
		phasesExecuted: 0,
		accumulatedDurationMs: 0,
	};
	const guards = options.guards ?? makeGuards();
	const io = buildPhaseIO({
		ctx,
		currentPhase: "resume",
		loadedResults: options.loadedResults,
		pendingAtEntry: options.pendingDelegation,
		pendingExternalAtEntry: options.pendingExternalRequest,
		usedLabelsAtEntry: options.usedLabels ?? [],
		guards,
	});
	return { io, guards, logger };
}

describe("PhaseIO external request creation", () => {
	test("requestExternal commits the expected PhaseResult", () => {
		const runDir = makeTempDir();
		try {
			const { io, guards } = buildIO({ runDir });
			const result = io.requestExternal(
				{
					label: "push-repo",
					requestType: "git.push",
					payload: { repository: "/repo", force: false },
					metadata: { source: "test" },
				},
				"resume",
				{ count: 1 },
			);

			expect(result).toEqual({
				kind: "external-request",
				request: {
					label: "push-repo",
					requestType: "git.push",
					payload: { repository: "/repo", force: false },
					metadata: { source: "test" },
				},
				resumeAt: "resume",
				nextState: { count: 1 },
			});
			expect(guards.committed.value).toBe(true);
		} finally {
			cleanupTempDir(runDir);
		}
	});

	test("requestExternal rejects labels already used by any yield kind", () => {
		const runDir = makeTempDir();
		try {
			const { io } = buildIO({ runDir, usedLabels: ["push-repo"] });
			expect(() =>
				io.requestExternal(
					{ label: "push-repo", requestType: "git.push", payload: null },
					"resume",
					{ count: 1 },
				),
			).toThrow(ProtocolError);
		} finally {
			cleanupTempDir(runDir);
		}
	});

	test("requestExternal obeys the existing single-commit guard", () => {
		const runDir = makeTempDir();
		try {
			const { io } = buildIO({ runDir });
			io.done({ ok: true });
			expect(() =>
				io.requestExternal(
					{ label: "push-repo", requestType: "git.push", payload: null },
					"resume",
					{ count: 1 },
				),
			).toThrow(ProtocolError);
		} finally {
			cleanupTempDir(runDir);
		}
	});

	test("requestExternal rejects invalid labels, request types, payloads, and metadata", () => {
		const runDir = makeTempDir();
		try {
			const invalidRequests = [
				{ label: "Invalid_Label", requestType: "git.push", payload: null },
				{ label: "push-repo", requestType: "", payload: null },
				{ label: "push-repo", requestType: "   ", payload: null },
				{ label: "push-repo", requestType: "git.push\nnext", payload: null },
				{
					label: "push-repo",
					requestType: "git.push",
					payload: (() => "value") as unknown as JsonValue,
				},
				{
					label: "push-repo",
					requestType: "git.push",
					payload: 1n as unknown as JsonValue,
				},
				{
					label: "push-repo",
					requestType: "git.push",
					payload: { missing: undefined } as unknown as JsonValue,
				},
				{
					label: "push-repo",
					requestType: "git.push",
					payload: null,
					metadata: { missing: undefined } as unknown as JsonValue,
				},
			];

			for (const request of invalidRequests) {
				const { io } = buildIO({ runDir });
				expect(() =>
					io.requestExternal(request, "resume", { count: 1 }),
				).toThrow(ProtocolError);
			}
		} finally {
			cleanupTempDir(runDir);
		}
	});
});

describe("PhaseIO external resolution consumption", () => {
	test("consume without an external pending record fails", () => {
		const runDir = makeTempDir();
		try {
			const { io } = buildIO({ runDir });
			expect(() => io.consumePendingExternalResolution(z.unknown())).toThrow(
				ExternalResolutionMissingError,
			);
		} finally {
			cleanupTempDir(runDir);
		}
	});

	test("consume refuses a pending delegation in place of an external request", () => {
		const runDir = makeTempDir();
		try {
			const { io } = buildIO({
				runDir,
				pendingDelegation: makePendingDelegation(),
			});
			expect(() => io.consumePendingExternalResolution(z.unknown())).toThrow(
				ProtocolError,
			);
		} finally {
			cleanupTempDir(runDir);
		}
	});

	test("consume refuses a missing loaded resolution", () => {
		const runDir = makeTempDir();
		try {
			const { io } = buildIO({
				runDir,
				pendingExternalRequest: makePendingExternal(runDir),
			});
			expect(() => io.consumePendingExternalResolution(z.unknown())).toThrow(
				ExternalResolutionMissingError,
			);
		} finally {
			cleanupTempDir(runDir);
		}
	});

	test("consume validates one opaque resolution exactly once", () => {
		const runDir = makeTempDir();
		try {
			const pending = makePendingExternal(runDir);
			const { io, guards, logger } = buildIO({
				runDir,
				pendingExternalRequest: pending,
				loadedResults: {
					label: pending.label,
					kind: "external-request",
					data: { outcome: "PUSHED", remoteSha: "abc123" },
				},
			});
			const schema = z.object({
				outcome: z.enum(["PUSHED", "REJECTED", "UNKNOWN"]),
				remoteSha: z.string().optional(),
			});

			expect(io.consumePendingExternalResolution(schema)).toEqual({
				outcome: "PUSHED",
				remoteSha: "abc123",
			});
			expect(guards.consumedCount.value).toBe(1);
			expect(logger.eventTypes()).toContain("external_resolution_validated");
			expect(() => io.consumePendingExternalResolution(schema)).toThrow(
				ProtocolError,
			);
		} finally {
			cleanupTempDir(runDir);
		}
	});

	test("consume distinguishes a valid null JSON resolution from a missing file", () => {
		const runDir = makeTempDir();
		try {
			const pending = makePendingExternal(runDir);
			const { io } = buildIO({
				runDir,
				pendingExternalRequest: pending,
				loadedResults: {
					label: pending.label,
					kind: "external-request",
					data: null,
				},
			});

			expect(io.consumePendingExternalResolution(z.null())).toBeNull();
		} finally {
			cleanupTempDir(runDir);
		}
	});

	test("consume rejects a schema-incompatible resolution without delegation retry semantics", () => {
		const runDir = makeTempDir();
		try {
			const pending = makePendingExternal(runDir);
			const { io, logger } = buildIO({
				runDir,
				pendingExternalRequest: pending,
				loadedResults: {
					label: pending.label,
					kind: "external-request",
					data: { outcome: 42 },
				},
			});

			expect(() =>
				io.consumePendingExternalResolution(z.object({ outcome: z.string() })),
			).toThrow(ExternalResolutionSchemaError);
			expect(logger.eventTypes()).toContain(
				"external_resolution_validation_failed",
			);
			expect(logger.eventTypes()).not.toContain("retry_scheduled");
		} finally {
			cleanupTempDir(runDir);
		}
	});

	test("delegation consume methods refuse an external pending record", () => {
		const runDir = makeTempDir();
		try {
			const pending = makePendingExternal(runDir);
			const { io } = buildIO({
				runDir,
				pendingExternalRequest: pending,
				loadedResults: {
					label: pending.label,
					kind: "external-request",
					data: null,
				},
			});
			expect(() => io.consumePendingResult(z.unknown())).toThrow(ProtocolError);
		} finally {
			cleanupTempDir(runDir);
		}
	});
});
