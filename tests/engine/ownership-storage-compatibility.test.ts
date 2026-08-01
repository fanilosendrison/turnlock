// Ownership storage compatibility guard tests.
//
// Covers the assertOwnershipStorageCompatibility matrix:
//   SQLite    | .lock   | Result
//   ----------|---------|------------------------------------------
//   absent    | absent  | no error (legacy migration potentially allowed)
//   absent    | present | LegacyLockMigrationBlockedError
//   present   | absent  | no error (normal SQLite protocol)
//   present   | present | MixedOwnershipProtocolError
//
// Also verifies that errors do NOT mutate .lock (no automatic cleanup).

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertOwnershipStorageCompatibility } from "../../src/engine/ownership-storage-compatibility";
import {
	LegacyLockMigrationBlockedError,
	MixedOwnershipProtocolError,
} from "../../src/errors/concrete";
import { cleanupTempDir, makeTempDir } from "../helpers/temp-run-dir";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setup(lockExists: boolean, dbExists: boolean) {
	const dir = makeTempDir();
	const runDir = join(
		dir,
		".turnlock",
		"runs",
		"test-orch",
		"01HX00000000000000000000T1",
	);
	mkdirSync(runDir, { recursive: true });

	if (lockExists) {
		writeFileSync(
			join(runDir, ".lock"),
			"pid=99999\ntimestamp=1704067200000\n",
		);
	}

	if (dbExists) {
		// Just create an empty file to simulate DB presence — the guard
		// only checks existsSync, not DB validity.
		writeFileSync(join(runDir, "turnlock.sqlite3"), "");
	}

	return {
		dir,
		runDir,
		cleanup: () => cleanupTempDir(dir),
	};
}

// ---------------------------------------------------------------------------
// Matrix tests
// ---------------------------------------------------------------------------

describe("assertOwnershipStorageCompatibility", () => {
	test("SQLite absent, .lock absent → no error (migration potentially allowed)", () => {
		const ctx = setup(false, false);
		try {
			expect(() =>
				assertOwnershipStorageCompatibility({
					runDir: ctx.runDir,
					sqliteDatabaseExists: false,
					mode: "resume",
					runId: "01HX00000000000000000000T2",
					orchestratorName: "test-orch",
				}),
			).not.toThrow();
		} finally {
			ctx.cleanup();
		}
	});

	test("SQLite absent, .lock present → LegacyLockMigrationBlockedError", () => {
		const ctx = setup(true, false);
		try {
			let err: unknown;
			try {
				assertOwnershipStorageCompatibility({
					runDir: ctx.runDir,
					sqliteDatabaseExists: false,
					mode: "resume",
					runId: "01HX00000000000000000000T2",
					orchestratorName: "test-orch",
				});
			} catch (e) {
				err = e;
			}

			expect(err).toBeDefined();
			expect(err).toBeInstanceOf(LegacyLockMigrationBlockedError);
			const typedErr = err as LegacyLockMigrationBlockedError;
			expect(typedErr.kind).toBe("legacy_lock_migration_blocked");
			expect(typedErr.message).toContain("Legacy ownership lock");
			expect(typedErr.runId).toBe("01HX00000000000000000000T2");
			expect(typedErr.orchestratorName).toBe("test-orch");
		} finally {
			ctx.cleanup();
		}
	});

	test("SQLite present, .lock absent → no error (normal SQLite protocol)", () => {
		const ctx = setup(false, true);
		try {
			expect(() =>
				assertOwnershipStorageCompatibility({
					runDir: ctx.runDir,
					sqliteDatabaseExists: true,
					mode: "resume",
					runId: "01HX00000000000000000000T2",
					orchestratorName: "test-orch",
				}),
			).not.toThrow();
		} finally {
			ctx.cleanup();
		}
	});

	test("SQLite present, .lock present → MixedOwnershipProtocolError (fail-closed)", () => {
		const ctx = setup(true, true);
		try {
			let err: unknown;
			try {
				assertOwnershipStorageCompatibility({
					runDir: ctx.runDir,
					sqliteDatabaseExists: true,
					mode: "resume",
					runId: "01HX00000000000000000000T2",
					orchestratorName: "test-orch",
				});
			} catch (e) {
				err = e;
			}

			expect(err).toBeDefined();
			expect(err).toBeInstanceOf(MixedOwnershipProtocolError);
			const typedErr = err as MixedOwnershipProtocolError;
			expect(typedErr.kind).toBe("mixed_ownership_protocol_detected");
			expect(typedErr.message).toContain("coexist");
			expect(typedErr.message).toContain("deployment or downgrade contract");
			expect(typedErr.runId).toBe("01HX00000000000000000000T2");
			expect(typedErr.orchestratorName).toBe("test-orch");
		} finally {
			ctx.cleanup();
		}
	});

	// -------------------------------------------------------------------
	// No automatic cleanup
	// -------------------------------------------------------------------

	test(".lock file is never modified, removed, or rewritten on error", () => {
		const lockContent = "pid=99999\ntimestamp=1704067200000\n";

		// Legacy lock migration blocked
		{
			const ctx = setup(true, false);
			try {
				try {
					assertOwnershipStorageCompatibility({
						runDir: ctx.runDir,
						sqliteDatabaseExists: false,
						mode: "resume",
						runId: "01HX00000000000000000000T2",
						orchestratorName: "test-orch",
					});
				} catch {
					// expected
				}

				// .lock must still exist with original content.
				const lockPath = join(ctx.runDir, ".lock");
				expect(existsSync(lockPath)).toBe(true);
				expect(readFileSync(lockPath, "utf-8")).toBe(lockContent);
			} finally {
				ctx.cleanup();
			}
		}

		// Mixed ownership detected
		{
			const ctx = setup(true, true);
			try {
				try {
					assertOwnershipStorageCompatibility({
						runDir: ctx.runDir,
						sqliteDatabaseExists: true,
						mode: "resume",
						runId: "01HX00000000000000000000T2",
						orchestratorName: "test-orch",
					});
				} catch {
					// expected
				}

				const lockPath = join(ctx.runDir, ".lock");
				expect(existsSync(lockPath)).toBe(true);
				expect(readFileSync(lockPath, "utf-8")).toBe(lockContent);
			} finally {
				ctx.cleanup();
			}
		}
	});

	// -------------------------------------------------------------------
	// Mode parameter does not change behavior
	// -------------------------------------------------------------------

	test("same matrix results for initial and resume modes", () => {
		// Mixed state + initial mode
		const ctx = setup(true, true);
		try {
			let err: unknown;
			try {
				assertOwnershipStorageCompatibility({
					runDir: ctx.runDir,
					sqliteDatabaseExists: true,
					mode: "initial",
					runId: "01HX00000000000000000000T2",
					orchestratorName: "test-orch",
				});
			} catch (e) {
				err = e;
			}
			expect(err).toBeInstanceOf(MixedOwnershipProtocolError);
		} finally {
			ctx.cleanup();
		}

		// Legacy lock + initial mode
		const ctx2 = setup(true, false);
		try {
			let err: unknown;
			try {
				assertOwnershipStorageCompatibility({
					runDir: ctx2.runDir,
					sqliteDatabaseExists: false,
					mode: "initial",
					runId: "01HX00000000000000000000T2",
					orchestratorName: "test-orch",
				});
			} catch (e) {
				err = e;
			}
			expect(err).toBeInstanceOf(LegacyLockMigrationBlockedError);
		} finally {
			ctx2.cleanup();
		}
	});
});
