// NIB-T §7 — run-dir (T-RD-01..08, P-RD-a/b)
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { InvalidConfigError } from "../../src/errors/concrete";
import { cleanupOldRuns, resolveRunDir } from "../../src/services/run-dir";
import { cleanupTempDir, makeTempDir } from "../helpers/temp-run-dir";

describe("resolveRunDir (T-RD-01..03)", () => {
	test("T-RD-01 | composes canonical path", () => {
		expect(resolveRunDir("/repo", "senior-review", "01HX")).toBe(
			"/repo/.claude/run/cc-orch/senior-review/01HX",
		);
	});
	test("T-RD-02 | cwd with spaces", () => {
		expect(resolveRunDir("/my repo", "foo", "01H")).toBe(
			"/my repo/.claude/run/cc-orch/foo/01H",
		);
	});
	test("T-RD-03 | empty cwd → InvalidConfigError", () => {
		expect(() => resolveRunDir("", "x", "y")).toThrow(InvalidConfigError);
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
			const base = join(dir, ".claude", "run", "cc-orch", "orch");
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
			const base = join(dir, ".claude", "run", "cc-orch", "orch");
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
			const base = join(dir, ".claude", "run", "cc-orch", "orch");
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
			const base = join(dir, ".claude", "run", "cc-orch", "orch");
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
			const other = join(dir, ".claude", "run", "cc-orch", "other", "run-x");
			mkdirSync(other, { recursive: true });
			touch(other, 100);
			cleanupOldRuns(dir, "orch", 7, "current");
			expect(existsSync(other)).toBe(true);
		} finally {
			cleanupTempDir(dir);
		}
	});
});

describe("run-dir properties (P-RD-a/b)", () => {
	test("P-RD-a | currentRunId protected over 20 scenarios", () => {
		const dir = makeTempDir();
		try {
			const base = join(dir, ".claude", "run", "cc-orch", "orch");
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
