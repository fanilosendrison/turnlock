import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
// Authority: src/index.ts public surface + ADR-0001.
import { describe, test } from "node:test";
import type {
	ExternalRequest,
	JsonValue,
	OrchestratorConfig,
	Phase,
	PhaseIO,
	PhaseResult,
} from "../../src/index.js";
import * as publicApi from "../../src/index.js";

const pkg = JSON.parse(
	readFileSync(join(process.cwd(), "package.json"), "utf-8"),
) as {
	version: string;
	dependencies: Record<string, string>;
};
const EXPECTED_EXPORTS = new Set([
	"runOrchestrator",
	"definePhase",
	"OrchestratorError",
	"InvalidConfigError",
	"StateCorruptedError",
	"StateMissingError",
	"StateVersionMismatchError",
	"DelegationTimeoutError",
	"DelegationSchemaError",
	"DelegationMissingResultError",
	"ExternalResolutionMissingError",
	"ExternalResolutionSchemaError",
	"ExternalResolutionMalformedError",
	"PhaseError",
	"ProtocolError",
	"AbortedError",
	"RunLockedError",
	"AuthorityLostError",
	"PersistenceFailureError",
	"StateRevisionConflictError",
	"MixedOwnershipProtocolError",
	"IndeterminatePhaseExecutionError",
	"InitialDispatchAlreadyClaimedError",
	"AmbiguousLegacyDelegationTargetError",
	"PROTOCOL_VERSION",
	"STATE_SCHEMA_VERSION",
]);
const FORBIDDEN_EXPORTS = new Set([
	"executeCall",
	"SkillBinding",
	"AgentBinding",
	"AgentBatchBinding",
	"clock",
	"readState",
	"writeStateAtomic",
	"validateResult",
	"resolveRetryDecision",
	"classify",
	"createLogger",
	"acquireLock",
	"refreshLock",
	"releaseLock",
	"writeProtocolBlock",
	"parseProtocolBlock",
	"generateRunId",
	"abortableSleep",
	"resolveRunDir",
	"cleanupOldRuns",
	"ValidationPolicy",
]);
describe("[GREEN-L1] " + "surface publique (C-GL-01..03)", () => {
	test("C-GL-01 | exports exact", () => {
		const actual = new Set(Object.keys(publicApi));
		for (const name of EXPECTED_EXPORTS) {
			assert.strictEqual(actual.has(name), true);
		}
	});
	test("C-GL-02 | non-exported internals", () => {
		const actual = new Set(Object.keys(publicApi));
		for (const forbidden of FORBIDDEN_EXPORTS) {
			assert.strictEqual(actual.has(forbidden), false);
		}
	});
	test("C-GL-03 | ValidationPolicy n'existe pas", () => {
		assert.strictEqual("ValidationPolicy" in publicApi, false);
	});
	test("C-GL-04 | sub-classes instanceof OrchestratorError", () => {
		const { OrchestratorError, InvalidConfigError } = publicApi;
		assert.strictEqual(
			new InvalidConfigError("x") instanceof OrchestratorError,
			true,
		);
	});
});
describe("[GREEN-L1] " + "constantes (C-GL-05..06)", () => {
	test("C-GL-05 | PROTOCOL_VERSION === 3", () => {
		assert.strictEqual(publicApi.PROTOCOL_VERSION, 3);
	});
	test("C-GL-06 | STATE_SCHEMA_VERSION === 4", () => {
		assert.strictEqual(publicApi.STATE_SCHEMA_VERSION, 4);
	});
	test("package version is 0.11.0", () => {
		assert.strictEqual(pkg.version, "0.11.0");
	});
});
describe("[GREEN-L1] " + "dépendances (C-GL-07..08)", () => {
	test("C-GL-07 | package.json deps = zod + ulid", () => {
		assert.deepStrictEqual(Object.keys(pkg.dependencies).sort(), [
			"ulid",
			"zod",
		]);
	});
	test("C-GL-08 | pas de sous-dép visible", () => {
		const actual = new Set(Object.keys(publicApi));
		for (const forbidden of ["z", "ZodSchema", "ulid"]) {
			assert.strictEqual(actual.has(forbidden), false);
		}
	});
});
describe("[GREEN-L1] " + "typage (C-GL-09..11)", () => {
	test("C-GL-09 | OrchestratorConfig<State> compile", () => {
		const config: OrchestratorConfig<{
			count: number;
		}> = {
			name: "typed-orch",
			initial: "start",
			initialState: { count: 0 },
			resumeCommand: (runId) => `node ./main.js --run-id ${runId} --resume`,
			phases: {
				start: publicApi.definePhase<{
					count: number;
				}>(async (_state, io) => io.done({ ok: true })),
			},
		};
		assert.strictEqual(config.initialState.count, 0);
		assert.deepStrictEqual(Object.keys(config.phases), ["start"]);
	});
	test("C-GL-10 | Phase<State,Output> compile", () => {
		const phase: Phase<
			{
				count: number;
			},
			{
				ok: boolean;
			}
		> = publicApi.definePhase(async (_state, io) => io.done({ ok: true }));
		assert.strictEqual(typeof phase, "function");
	});
	test("C-GL-10b | PhaseIO has no transition", () => {
		const assertNoTransition = (
			io: PhaseIO<{
				count: number;
			}>,
		) => {
			// @ts-expect-error transition was removed from the public PhaseIO API.
			io.transition("next", { count: 1 });
		};
		assert.strictEqual(typeof assertNoTransition, "function");
	});
	test("ExternalRequest, JsonValue, and external PhaseResult compile", () => {
		const payload: JsonValue = {
			repository: "/repo",
			tags: ["release", null],
		};
		const request: ExternalRequest = {
			label: "push-repo",
			requestType: "git.push",
			payload,
		};
		const result: PhaseResult<{
			count: number;
		}> = {
			kind: "external-request",
			request,
			resumeAt: "after-push",
			nextState: { count: 1 },
		};
		assert.strictEqual(result.kind, "external-request");
	});
	test("C-GL-11 | definePhase pass-through no-op", () => {
		const fn = async () => ({ kind: "done" as const, output: undefined });
		assert.strictEqual(publicApi.definePhase(fn), fn);
	});
});
describe("[GREEN-L1] " + "OrchestratorErrorKind fermé (C-GL-12..13)", () => {
	const errorCases = [
		["invalid_config", () => new publicApi.InvalidConfigError("x")],
		["state_corrupted", () => new publicApi.StateCorruptedError("x")],
		["state_missing", () => new publicApi.StateMissingError("x")],
		[
			"state_version_mismatch",
			() => new publicApi.StateVersionMismatchError("x"),
		],
		["delegation_timeout", () => new publicApi.DelegationTimeoutError("x")],
		["delegation_schema", () => new publicApi.DelegationSchemaError("x")],
		[
			"delegation_missing_result",
			() => new publicApi.DelegationMissingResultError("x"),
		],
		[
			"external_resolution_missing",
			() => new publicApi.ExternalResolutionMissingError("x"),
		],
		[
			"external_resolution_schema",
			() => new publicApi.ExternalResolutionSchemaError("x"),
		],
		[
			"external_resolution_malformed",
			() => new publicApi.ExternalResolutionMalformedError("x"),
		],
		["phase_error", () => new publicApi.PhaseError("x")],
		["protocol", () => new publicApi.ProtocolError("x")],
		["aborted", () => new publicApi.AbortedError("x")],
		[
			"run_locked",
			() =>
				new publicApi.RunLockedError("x", {
					ownerPid: 1,
					acquiredAtEpochMs: 0,
					leaseUntilEpochMs: 1,
				}),
		],
		[
			"authority_lost",
			() =>
				new publicApi.AuthorityLostError("x", {
					operation: "state_commit",
					reason: "STALE_HANDLE",
				}),
		],
		[
			"state_revision_conflict",
			() => new publicApi.StateRevisionConflictError("x"),
		],
		[
			"persistence_failure",
			() =>
				new publicApi.PersistenceFailureError("x", {
					operation: "state_commit",
				}),
		],
		["artifact_integrity", () => new publicApi.ArtifactIntegrityError("x")],
		[
			"state_migration_blocked",
			() =>
				new publicApi.StateMigrationBlockedError("x", {
					reason: "MANIFEST_MISSING",
				}),
		],
		[
			"legacy_lock_migration_blocked",
			() => new publicApi.LegacyLockMigrationBlockedError("x"),
		],
		[
			"mixed_ownership_protocol_detected",
			() => new publicApi.MixedOwnershipProtocolError("x"),
		],
		[
			"ambiguous_legacy_delegation_target",
			() => new publicApi.AmbiguousLegacyDelegationTargetError("x"),
		],
	] as const;
	test("C-GL-12 | 22 kind values", () => {
		assert.strictEqual(errorCases.length, 22);
	});
	test("C-GL-13 | each kind ↔ class mapping", () => {
		for (const [kind, buildError] of errorCases) {
			assert.strictEqual(buildError().kind, kind);
		}
	});
});
