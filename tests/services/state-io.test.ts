// NIB-T §6 — state-io (T-SI-01..12, P-SI-a/b/c)
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { STATE_SCHEMA_VERSION } from "../../src/constants";
import {
	StateCorruptedError,
	StateVersionMismatchError,
} from "../../src/errors/concrete";
import {
	readState,
	type StateFile,
	writeStateAtomic,
} from "../../src/services/state-io";
import { loadFixture } from "../helpers/fixture-loader";
import { cleanupTempDir, makeTempDir } from "../helpers/temp-run-dir";

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
			expect(readState(dir)).toBeNull();
		} finally {
			cleanupTempDir(dir);
		}
	});
	test("T-SI-02 | valid v2 → typed StateFile", () => {
		const dir = makeTempDir();
		try {
			writeFileSync(
				join(dir, "state.json"),
				loadFixture("states/initial-empty.json"),
			);
			const state = readState(dir);
			expect(state).not.toBeNull();
			expect(state?.schemaVersion).toBe(STATE_SCHEMA_VERSION);
		} finally {
			cleanupTempDir(dir);
		}
	});
	test("T-SI-03 | JSON invalide → StateCorruptedError", () => {
		const dir = makeTempDir();
		try {
			writeFileSync(join(dir, "state.json"), "{invalid json");
			expect(() => readState(dir)).toThrow(StateCorruptedError);
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
			expect(() => readState(dir)).toThrow(StateVersionMismatchError);
		} finally {
			cleanupTempDir(dir);
		}
	});
	test("T-SI-05 | missing schemaVersion → StateCorruptedError", () => {
		const dir = makeTempDir();
		try {
			writeFileSync(join(dir, "state.json"), JSON.stringify({ runId: "x" }));
			expect(() => readState(dir)).toThrow(StateCorruptedError);
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
			expect(read).not.toBeNull();
			expect(read?.data.count).toBe(5);
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
			expect(() => readState(dir, schema)).toThrow(StateCorruptedError);
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
			expect(existsSync(join(dir, "state.json"))).toBe(true);
			expect(existsSync(join(dir, "state.json.tmp"))).toBe(false);
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
			expect(raw).toContain('"a":2');
			expect(existsSync(join(dir, "state.json.tmp"))).toBe(false);
		} finally {
			cleanupTempDir(dir);
		}
	});
	test("T-SI-10 | schema fail → no write at all", () => {
		const dir = makeTempDir();
		try {
			const schema = z.object({ count: z.number() });
			const bad = buildState<{ count: number }>({
				count: "bad" as unknown as number,
			});
			expect(() => writeStateAtomic(dir, bad, schema)).toThrow(
				StateCorruptedError,
			);
			expect(existsSync(join(dir, "state.json"))).toBe(false);
			expect(existsSync(join(dir, "state.json.tmp"))).toBe(false);
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
			const read = readState<{ a: number }>(dir);
			expect(read).not.toBeNull();
			expect(read?.data).toEqual({ a: 1 });
		} finally {
			cleanupTempDir(dir);
		}
	});
	test("T-SI-12 | pendingDelegation undefined → field absent in JSON", () => {
		const dir = makeTempDir();
		try {
			writeStateAtomic(dir, buildState({ a: 1 }));
			const raw = readFileSync(join(dir, "state.json"), "utf-8");
			expect(raw.includes("pendingDelegation")).toBe(false);
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
			const read = readState<{ x: string; arr: number[] }>(dir);
			expect(read).toEqual(s);
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
					expect(read).not.toBeNull();
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
				expect(existsSync(join(dir, "state.json.tmp"))).toBe(false);
			}
		} finally {
			cleanupTempDir(dir);
		}
	});
});
