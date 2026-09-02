import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, utimesSync } from "node:fs";
import { join } from "node:path";
// NIB-T §7 — run-dir (T-RD-01..12, P-RD-a/b)
import { afterEach, beforeEach, describe, test } from "node:test";
import { InvalidConfigError } from "../../src/errors/concrete.js";
import {
	cleanupOldRuns,
	type RunDirRetirement,
	resolveRunDir,
} from "../../src/services/run-dir.js";
import { cleanupTempDir, makeTempDir } from "../helpers/temp-run-dir.js";

const DEFAULT_ROOT = join(".turnlock", "runs");
// Pure filesystem tests: the candidate directories contain no SQLite
// database, so the retirement delegate is a test double that performs the
// physical deletion and reports DELETED (the durable claim + rename
// behavior itself is covered by the retention-cleanup integration tests).
function deleteForReal(runDir: string): void {
	rmSync(runDir, { recursive: true, force: true });
}
const alwaysDeleted: RunDirRetirement = {
	retireRunDirectory: (runDir) => {
		deleteForReal(runDir);
		return { kind: "DELETED" };
	},
	sweepRetiredDirectories: () => 0,
};
// Env var must not leak across tests — cleared before every test in this file.
beforeEach(() => {
	delete process.env.TURNLOCK_RUN_DIR_ROOT;
});
afterEach(() => {
	delete process.env.TURNLOCK_RUN_DIR_ROOT;
});
describe("resolveRunDir (T-RD-01..03, T-RD-09..12)", () => {
	test("T-RD-01 | composes canonical path with default root", () => {
		assert.strictEqual(
			resolveRunDir("/repo", "senior-review", "01HX"),
			join("/repo", DEFAULT_ROOT, "senior-review", "01HX"),
		);
	});
	test("T-RD-02 | cwd with spaces", () => {
		assert.strictEqual(
			resolveRunDir("/my repo", "workflow", "01H"),
			join("/my repo", DEFAULT_ROOT, "workflow", "01H"),
		);
	});
	test("T-RD-03 | empty cwd → InvalidConfigError", () => {
		assert.throws(() => resolveRunDir("", "x", "y"), InvalidConfigError);
	});
	test("T-RD-09 | relative runDirRoot is joined to cwd", () => {
		assert.strictEqual(
			resolveRunDir("/repo", "orch", "id", ".claude/run/cc-orch"),
			"/repo/.claude/run/cc-orch/orch/id",
		);
	});
	test("T-RD-10 | absolute runDirRoot ignores cwd prefix", () => {
		assert.strictEqual(
			resolveRunDir("/repo", "orch", "id", "/abs/path"),
			"/abs/path/orch/id",
		);
	});
	test("T-RD-11 | env var overrides config argument", () => {
		process.env.TURNLOCK_RUN_DIR_ROOT = ".envroot";
		assert.strictEqual(
			resolveRunDir("/repo", "orch", "id", ".configroot"),
			join("/repo", ".envroot", "orch", "id"),
		);
	});
	test("T-RD-12 | empty env var falls back to config/default", () => {
		process.env.TURNLOCK_RUN_DIR_ROOT = "";
		assert.strictEqual(
			resolveRunDir("/repo", "orch", "id"),
			join("/repo", DEFAULT_ROOT, "orch", "id"),
		);
		assert.strictEqual(
			resolveRunDir("/repo", "orch", "id", ".custom"),
			join("/repo", ".custom", "orch", "id"),
		);
	});
	test("T-RD-14 | empty config runDirRoot falls back to default", () => {
		assert.strictEqual(
			resolveRunDir("/repo", "orch", "id", ""),
			join("/repo", DEFAULT_ROOT, "orch", "id"),
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
			cleanupOldRuns(dir, "orch", 7, "current", alwaysDeleted);
			assert.strictEqual(existsSync(current), true);
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
			cleanupOldRuns(dir, "orch", 7, "current", alwaysDeleted);
			assert.strictEqual(existsSync(old), false);
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
			cleanupOldRuns(dir, "orch", 7, "current", alwaysDeleted);
			assert.strictEqual(existsSync(edge), true);
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
			const count = cleanupOldRuns(dir, "orch", 7, "current", alwaysDeleted);
			assert.strictEqual(count, 3);
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
			cleanupOldRuns(dir, "orch", 7, "current", alwaysDeleted);
			assert.strictEqual(existsSync(other), true);
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
			cleanupOldRuns(dir, "orch", 7, "current", alwaysDeleted, customRoot);
			assert.strictEqual(existsSync(old), false);
		} finally {
			cleanupTempDir(dir);
		}
	});
	test("T-RD-15 | retirement delegate decides deletion — KEPT keeps the directory", () => {
		const dir = makeTempDir();
		try {
			const base = join(dir, DEFAULT_ROOT, "orch");
			mkdirSync(base, { recursive: true });
			const old = join(base, "live-owner");
			mkdirSync(old);
			touch(old, 20);
			const seen: Array<{ runId: string }> = [];
			const count = cleanupOldRuns(dir, "orch", 7, "current", {
				retireRunDirectory: (_runDir, runId) => {
					seen.push({ runId });
					return { kind: "KEPT", reason: "LIVE_OWNER" };
				},
				sweepRetiredDirectories: () => 0,
			});
			assert.strictEqual(existsSync(old), true);
			assert.strictEqual(count, 0);
			// The delegate must receive the candidate directory name.
			assert.deepStrictEqual(seen, [{ runId: "live-owner" }]);
		} finally {
			cleanupTempDir(dir);
		}
	});
	test("T-RD-16 | retirement delegate failure fails closed (directory kept)", () => {
		const dir = makeTempDir();
		try {
			const base = join(dir, DEFAULT_ROOT, "orch");
			mkdirSync(base, { recursive: true });
			const old = join(base, "ambiguous-old");
			mkdirSync(old);
			touch(old, 20);
			const count = cleanupOldRuns(dir, "orch", 7, "current", {
				retireRunDirectory: () => {
					throw new Error("retirement unavailable");
				},
				sweepRetiredDirectories: () => 0,
			});
			assert.strictEqual(existsSync(old), true);
			assert.strictEqual(count, 0);
		} finally {
			cleanupTempDir(dir);
		}
	});
	test("T-RD-17 | KEPT (unknown) retirement outcome keeps the directory", () => {
		const dir = makeTempDir();
		try {
			const base = join(dir, DEFAULT_ROOT, "orch");
			mkdirSync(base, { recursive: true });
			const old = join(base, "unknown-old");
			mkdirSync(old);
			touch(old, 20);
			const count = cleanupOldRuns(dir, "orch", 7, "current", {
				retireRunDirectory: () => ({ kind: "KEPT", reason: "UNKNOWN" }),
				sweepRetiredDirectories: () => 0,
			});
			assert.strictEqual(existsSync(old), true);
			assert.strictEqual(count, 0);
		} finally {
			cleanupTempDir(dir);
		}
	});
	test("T-RD-18 | DELETED retirement outcome counts and removes the directory", () => {
		const dir = makeTempDir();
		try {
			const base = join(dir, DEFAULT_ROOT, "orch");
			mkdirSync(base, { recursive: true });
			const old = join(base, "already-retiring");
			mkdirSync(old);
			touch(old, 20);
			const count = cleanupOldRuns(dir, "orch", 7, "current", {
				retireRunDirectory: (runDir) => {
					deleteForReal(runDir);
					return { kind: "DELETED" };
				},
				sweepRetiredDirectories: () => 0,
			});
			assert.strictEqual(existsSync(old), false);
			assert.strictEqual(count, 1);
		} finally {
			cleanupTempDir(dir);
		}
	});
	test("T-RD-19 | current run is never presented to the retirement delegate", () => {
		const dir = makeTempDir();
		try {
			const base = join(dir, DEFAULT_ROOT, "orch");
			mkdirSync(base, { recursive: true });
			const current = join(base, "current");
			mkdirSync(current);
			touch(current, 100);
			let retirements = 0;
			const count = cleanupOldRuns(dir, "orch", 7, "current", {
				retireRunDirectory: (runDir) => {
					retirements++;
					deleteForReal(runDir);
					return { kind: "DELETED" };
				},
				sweepRetiredDirectories: () => 0,
			});
			assert.strictEqual(retirements, 0);
			assert.strictEqual(count, 0);
			assert.strictEqual(existsSync(current), true);
		} finally {
			cleanupTempDir(dir);
		}
	});
	test("T-RD-20 | .retired area is swept with the retired root and never treated as a candidate", () => {
		const dir = makeTempDir();
		try {
			const base = join(dir, DEFAULT_ROOT, "orch");
			const retiredRoot = join(base, ".retired");
			mkdirSync(retiredRoot, { recursive: true });
			const retiredEntry = join(retiredRoot, "stale-entry");
			mkdirSync(retiredEntry);
			touch(retiredEntry, 100);
			const oldCandidate = join(base, "old-run");
			mkdirSync(oldCandidate);
			touch(oldCandidate, 20);
			const sweptRoots: string[] = [];
			let candidateRetirements = 0;
			const count = cleanupOldRuns(dir, "orch", 7, "current", {
				retireRunDirectory: (runDir) => {
					candidateRetirements++;
					deleteForReal(runDir);
					return { kind: "DELETED" };
				},
				sweepRetiredDirectories: (retiredRootPath) => {
					sweptRoots.push(retiredRootPath);
					return 2;
				},
			});
			// The .retired directory itself was never a run candidate.
			assert.strictEqual(candidateRetirements, 1);
			// The sweep received the retired root and its count was added.
			assert.deepStrictEqual(sweptRoots, [retiredRoot]);
			assert.strictEqual(count, 3);
			assert.strictEqual(existsSync(oldCandidate), false);
			// The sweep delegate owns .retired deletion semantics.
			assert.strictEqual(existsSync(retiredEntry), true);
		} finally {
			cleanupTempDir(dir);
		}
	});
	test("T-RD-21 | sweep delegate failure is best-effort (candidates unaffected)", () => {
		const dir = makeTempDir();
		try {
			const base = join(dir, DEFAULT_ROOT, "orch");
			mkdirSync(base, { recursive: true });
			const old = join(base, "old-run");
			mkdirSync(old);
			touch(old, 20);
			const count = cleanupOldRuns(dir, "orch", 7, "current", {
				retireRunDirectory: (runDir) => {
					deleteForReal(runDir);
					return { kind: "DELETED" };
				},
				sweepRetiredDirectories: () => {
					throw new Error("sweep unavailable");
				},
			});
			assert.strictEqual(count, 1);
			assert.strictEqual(existsSync(old), false);
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
				cleanupOldRuns(dir, "orch", 7, `c${i}`, alwaysDeleted);
				assert.strictEqual(existsSync(current), true);
			}
		} finally {
			cleanupTempDir(dir);
		}
	});
	test("P-RD-b | disjoint paths across orchestratorName", () => {
		const a = resolveRunDir("/r", "orchA", "id");
		const b = resolveRunDir("/r", "orchB", "id");
		assert.strictEqual(a.startsWith(b), false);
		assert.strictEqual(b.startsWith(a), false);
	});
});
