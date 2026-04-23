// NIB-T §7 — run-dir (T-RD-01..12, P-RD-a/b)
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { InvalidConfigError } from "../../src/errors/concrete";
import { cleanupOldRuns, resolveRunDir } from "../../src/services/run-dir";
import { cleanupTempDir, makeTempDir } from "../helpers/temp-run-dir";

const DEFAULT_ROOT = join(".turnlock", "runs");

// Env var must not leak across tests — cleared before every test in this file.
beforeEach(() => {
	delete process.env.TURNLOCK_RUN_DIR_ROOT;
});
afterEach(() => {
	delete process.env.TURNLOCK_RUN_DIR_ROOT;
});

describe("resolveRunDir (T-RD-01..03, T-RD-09..12)", () => {
	test("T-RD-01 | composes canonical path with default root", () => {
		expect(resolveRunDir("/repo", "senior-review", "01HX")).toBe(
			join("/repo", DEFAULT_ROOT, "senior-review", "01HX"),
		);
	});
	test("T-RD-02 | cwd with spaces", () => {
		expect(resolveRunDir("/my repo", "foo", "01H")).toBe(
			join("/my repo", DEFAULT_ROOT, "foo", "01H"),
		);
	});
	test("T-RD-03 | empty cwd → InvalidConfigError", () => {
		expect(() => resolveRunDir("", "x", "y")).toThrow(InvalidConfigError);
	});
	test("T-RD-09 | relative runDirRoot is joined to cwd", () => {
		expect(resolveRunDir("/repo", "orch", "id", ".claude/run/cc-orch")).toBe(
			"/repo/.claude/run/cc-orch/orch/id",
		);
	});
	test("T-RD-10 | absolute runDirRoot ignores cwd prefix", () => {
		expect(resolveRunDir("/repo", "orch", "id", "/abs/path")).toBe(
			"/abs/path/orch/id",
		);
	});
	test("T-RD-11 | env var overrides config argument", () => {
		process.env.TURNLOCK_RUN_DIR_ROOT = ".envroot";
		expect(resolveRunDir("/repo", "orch", "id", ".configroot")).toBe(
			join("/repo", ".envroot", "orch", "id"),
		);
	});
	test("T-RD-12 | empty env var falls back to config/default", () => {
		process.env.TURNLOCK_RUN_DIR_ROOT = "";
		expect(resolveRunDir("/repo", "orch", "id")).toBe(
			join("/repo", DEFAULT_ROOT, "orch", "id"),
		);
		expect(resolveRunDir("/repo", "orch", "id", ".custom")).toBe(
			join("/repo", ".custom", "orch", "id"),
		);
	});
});

function touch(path: string, daysAgo: number): void {
	const d = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
	utimesSync(path, d, d);
}

describe("cleanupOldRuns (T-RD-04..08)", () => {
	test("T-RD-04 | currentRunId never deleted", () => {
		const dir = makeTempDir();
		try {
			const base = join(dir, DEFAULT_ROOT, "orch");
			mkdirSync(base, { recursive: true });
			const current = join(base, "current");
			mkdirSync(current);
			touch(current, 100);
			cleanupOldRuns(dir, "orch", 7, "current");
			expect(existsSync(current)).toBe(true);
		} finally {
			cleanupTempDir(dir);
		}
	});
	test("T-RD-05 | run > retention deleted", () => {
		const dir = makeTempDir();
		try {
			const base = join(dir, DEFAULT_ROOT, "orch");
			mkdirSync(base, { recursive: true });
			const old = join(base, "old-run");
			mkdirSync(old);
			touch(old, 10);
			cleanupOldRuns(dir, "orch", 7, "current");
			expect(existsSync(old)).toBe(false);
		} finally {
			cleanupTempDir(dir);
		}
	});
	test("T-RD-06 | run = retention kept (strict >)", () => {
		const dir = makeTempDir();
		try {
			const base = join(dir, DEFAULT_ROOT, "orch");
			mkdirSync(base, { recursive: true });
			const edge = join(base, "edge");
			mkdirSync(edge);
			// Use 6.999 days to avoid race between touch's Date.now() and
			// cleanupOldRuns's Date.now() which can shift the threshold by a few ms.
			touch(edge, 6.999);
			cleanupOldRuns(dir, "orch", 7, "current");
			expect(existsSync(edge)).toBe(true);
		} finally {
			cleanupTempDir(dir);
		}
	});
	test("T-RD-07 | returns deleted count", () => {
		const dir = makeTempDir();
		try {
			const base = join(dir, DEFAULT_ROOT, "orch");
			mkdirSync(base, { recursive: true });
			for (let i = 0; i < 3; i++) {
				const d = join(base, `r${i}`);
				mkdirSync(d);
				touch(d, 20);
			}
			const count = cleanupOldRuns(dir, "orch", 7, "current");
			expect(count).toBe(3);
		} finally {
			cleanupTempDir(dir);
		}
	});
	test("T-RD-08 | other orchestratorName not touched", () => {
		const dir = makeTempDir();
		try {
			const other = join(dir, DEFAULT_ROOT, "other", "run-x");
			mkdirSync(other, { recursive: true });
			touch(other, 100);
			cleanupOldRuns(dir, "orch", 7, "current");
			expect(existsSync(other)).toBe(true);
		} finally {
			cleanupTempDir(dir);
		}
	});
	test("T-RD-13 | cleanup honors custom runDirRoot", () => {
		const dir = makeTempDir();
		try {
			const customRoot = ".custom/runs";
			const base = join(dir, customRoot, "orch");
			mkdirSync(base, { recursive: true });
			const old = join(base, "old-run");
			mkdirSync(old);
			touch(old, 10);
			// Default root dir must NOT be touched (it doesn't exist here).
			cleanupOldRuns(dir, "orch", 7, "current", customRoot);
			expect(existsSync(old)).toBe(false);
		} finally {
			cleanupTempDir(dir);
		}
	});
});

describe("run-dir properties (P-RD-a/b)", () => {
	test("P-RD-a | currentRunId protected over 20 scenarios", () => {
		const dir = makeTempDir();
		try {
			const base = join(dir, DEFAULT_ROOT, "orch");
			mkdirSync(base, { recursive: true });
			for (let i = 0; i < 20; i++) {
				const current = join(base, `c${i}`);
				mkdirSync(current);
				touch(current, 100);
				cleanupOldRuns(dir, "orch", 7, `c${i}`);
				expect(existsSync(current)).toBe(true);
			}
		} finally {
			cleanupTempDir(dir);
		}
	});
	test("P-RD-b | disjoint paths across orchestratorName", () => {
		const a = resolveRunDir("/r", "orchA", "id");
		const b = resolveRunDir("/r", "orchB", "id");
		expect(a.startsWith(b)).toBe(false);
		expect(b.startsWith(a)).toBe(false);
	});
});
