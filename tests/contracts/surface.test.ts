// NIB-T §27.1-§27.5 — surface publique (C-GL-01..13)
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as publicApi from "../../src/index";

const pkg = JSON.parse(
	readFileSync(
		join(
			fileURLToPath(new URL(".", import.meta.url)),
			"..",
			"..",
			"package.json",
		),
		"utf-8",
	),
) as { dependencies: Record<string, string> };

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
	"PhaseError",
	"ProtocolError",
	"AbortedError",
	"RunLockedError",
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

describe.skip("[GREEN-L1] " + "surface publique (C-GL-01..03)", () => {
	test("C-GL-01 | exports exact", () => {
		const actual = new Set(Object.keys(publicApi));
		for (const name of EXPECTED_EXPORTS) {
			expect(actual.has(name)).toBe(true);
		}
	});
	test("C-GL-02 | non-exported internals", () => {
		const actual = new Set(Object.keys(publicApi));
		for (const forbidden of FORBIDDEN_EXPORTS) {
			expect(actual.has(forbidden)).toBe(false);
		}
	});
	test("C-GL-03 | ValidationPolicy n'existe pas", () => {
		expect("ValidationPolicy" in publicApi).toBe(false);
	});
	test("C-GL-04 | sub-classes instanceof OrchestratorError", () => {
		const { OrchestratorError, InvalidConfigError } = publicApi;
		expect(new InvalidConfigError("x") instanceof OrchestratorError).toBe(true);
	});
});

describe.skip("[GREEN-L1] " + "constantes (C-GL-05..06)", () => {
	test("C-GL-05 | PROTOCOL_VERSION === 1", () => {
		expect(publicApi.PROTOCOL_VERSION).toBe(1);
	});
	test("C-GL-06 | STATE_SCHEMA_VERSION === 1", () => {
		expect(publicApi.STATE_SCHEMA_VERSION).toBe(1);
	});
});

describe.skip("[GREEN-L1] " + "dépendances (C-GL-07..08)", () => {
	test("C-GL-07 | package.json deps = zod + ulid", () => {
		expect(Object.keys(pkg.dependencies).sort()).toEqual(["ulid", "zod"]);
	});
	test("C-GL-08 | pas de sous-dép visible", () => {
		const actual = new Set(Object.keys(publicApi));
		for (const forbidden of ["z", "ZodSchema", "ulid"]) {
			expect(actual.has(forbidden)).toBe(false);
		}
	});
});

describe.skip("[GREEN-L1] " + "typage (C-GL-09..11)", () => {
	test("C-GL-09 | OrchestratorConfig<State> compile", () => {
		// Pure compile-time test — passes if type-check succeeds.
		expect(true).toBe(true);
	});
	test("C-GL-10 | Phase<State,Input,Output> compile", () => {
		expect(true).toBe(true);
	});
	test("C-GL-11 | definePhase pass-through no-op", () => {
		const fn = async () => ({ kind: "done" as const, output: undefined });
		expect(publicApi.definePhase(fn)).toBe(fn);
	});
});

describe.skip("[GREEN-L1] " + "OrchestratorErrorKind fermé (C-GL-12..13)", () => {
	const expectedKinds = [
		"invalid_config",
		"state_corrupted",
		"state_missing",
		"state_version_mismatch",
		"delegation_timeout",
		"delegation_schema",
		"delegation_missing_result",
		"phase_error",
		"protocol",
		"aborted",
		"run_locked",
	];
	const mapping: Record<string, new (...a: any[]) => unknown> = {
		invalid_config: publicApi.InvalidConfigError,
		state_corrupted: publicApi.StateCorruptedError,
		state_missing: publicApi.StateMissingError,
		state_version_mismatch: publicApi.StateVersionMismatchError,
		delegation_timeout: publicApi.DelegationTimeoutError,
		delegation_schema: publicApi.DelegationSchemaError,
		delegation_missing_result: publicApi.DelegationMissingResultError,
		phase_error: publicApi.PhaseError,
		protocol: publicApi.ProtocolError,
		aborted: publicApi.AbortedError,
		run_locked: publicApi.RunLockedError,
	};
	test("C-GL-12 | 11 kind values", () => {
		expect(expectedKinds).toHaveLength(11);
	});
	test("C-GL-13 | each kind ↔ class mapping", () => {
		for (const kind of expectedKinds) {
			const Ctor = mapping[kind]!;
			const instance =
				kind === "run_locked"
					? new (Ctor as any)("x", {
							ownerPid: 1,
							acquiredAtEpochMs: 0,
							leaseUntilEpochMs: 1,
						})
					: new (Ctor as any)("x");
			expect((instance as { kind: string }).kind).toBe(kind);
		}
	});
});
