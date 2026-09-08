import assert from "node:assert/strict";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, test } from "node:test";
import { nodeSqliteDriver } from "../../src/persistence/sqlite/node-sqlite-driver.js";
import { cleanupOldRuns } from "../../src/services/run-dir.js";
import {
	deleteRetiredRunDirectory,
	renameRunDirectoryToRetired,
} from "../../src/services/run-retirement.js";
import { cleanupTempDir, makeTempDir } from "../helpers/temp-run-dir.js";
import {
	acquireB,
	ageDir,
	bootstrapForeignRun,
	claimB,
	expireLease,
	ORCHESTRATOR_NAME,
	productionRetirement,
	RUN_A,
	RUN_B,
	resetRetentionTestEnvironment,
} from "./retention-cleanup-scenario-setup.js";

// Physical deletion is confined to the identity-verified retired pathname.
beforeEach(resetRetentionTestEnvironment);

describe("canonical namespace identity", () => {
	test("new incarnation created at the canonical path during the retirement window must not be destroyed", () => {
		const root = makeTempDir();
		try {
			const runDirRoot = join(root, "runs");
			const runBDir = join(runDirRoot, ORCHESTRATOR_NAME, RUN_B);
			bootstrapForeignRun(runBDir, RUN_B);
			expireLease(runBDir);
			ageDir(runBDir, 100);
			// Barrier delegate: the REAL durable claim wins, then the
			// deletion window is simulated — the old authority's files
			// disappear and a NEW incarnation is bootstrapped at the SAME
			// canonical pathname with the production primitives.
			let newIncarnationBootstrapped = false;
			const windowDelegate: typeof productionRetirement = {
				retireRunDirectory: (runDir, runId) => {
					const claim = claimB(runDir, runId);
					assert.strictEqual(claim.kind, "CLAIMED");
					for (const entry of readdirSync(runDir)) {
						rmSync(join(runDir, entry), { recursive: true, force: true });
					}
					const fresh = bootstrapForeignRun(runDir, runId);
					assert.strictEqual(fresh.kind, "BOOTSTRAPPED");
					if (fresh.kind === "BOOTSTRAPPED") {
						assert.ok(fresh.handle.leaseUntilEpochMs > Date.now());
					}
					newIncarnationBootstrapped = true;
					// Hand over to the REAL production flow: it must refuse
					// to act on the new incarnation.
					return productionRetirement.retireRunDirectory(runDir, runId);
				},
				sweepRetiredDirectories: (retiredRoot, orchestratorName) =>
					productionRetirement.sweepRetiredDirectories(
						retiredRoot,
						orchestratorName,
					),
			};
			const deleted = cleanupOldRuns(
				root,
				ORCHESTRATOR_NAME,
				7,
				RUN_A,
				windowDelegate,
				runDirRoot,
			);
			console.error(
				`filesystem-window proof: newIncarnationBootstrapped=${newIncarnationBootstrapped} deleted=${deleted}`,
			);
			assert.strictEqual(
				existsSync(runBDir),
				true,
				"expected: new incarnation survives; actual: canonical pathname was removed by the cleanup",
			);
			assert.strictEqual(
				existsSync(join(runBDir, "turnlock.sqlite3")),
				true,
				"expected: new incarnation SQLite authority survives; actual: turnlock.sqlite3 was removed",
			);
			// The new incarnation remains fully authoritative: its bootstrap
			// owner is still HELD with a live lease, so a takeover attempt
			// must report ACTIVE_CONFLICT (a live owner exists).
			const takeover = acquireB(runBDir);
			assert.strictEqual(takeover.kind, "ACTIVE_CONFLICT");
			if (takeover.kind === "ACTIVE_CONFLICT") {
				assert.ok(takeover.leaseUntilEpochMs > Date.now());
			}
		} finally {
			cleanupTempDir(root);
		}
	});

	test("canonical pathname replaced after claim must not be renamed/deleted", () => {
		const root = makeTempDir();
		try {
			const runDirRoot = join(root, "runs");
			const runBDir = join(runDirRoot, ORCHESTRATOR_NAME, RUN_B);
			bootstrapForeignRun(runBDir, RUN_B);
			expireLease(runBDir);
			ageDir(runBDir, 100);
			let newIncarnationBootstrapped = false;
			const swapDelegate: typeof productionRetirement = {
				retireRunDirectory: (runDir, runId) => {
					const claim = claimB(runDir, runId);
					assert.strictEqual(claim.kind, "CLAIMED");
					// Pathname substitution: the whole directory object the
					// claim referred to is replaced by a brand-new one.
					rmSync(runDir, { recursive: true, force: true });
					const fresh = bootstrapForeignRun(runDir, runId);
					assert.strictEqual(fresh.kind, "BOOTSTRAPPED");
					if (fresh.kind === "BOOTSTRAPPED") {
						assert.ok(fresh.handle.leaseUntilEpochMs > Date.now());
					}
					newIncarnationBootstrapped = true;
					return productionRetirement.retireRunDirectory(runDir, runId);
				},
				sweepRetiredDirectories: (retiredRoot, orchestratorName) =>
					productionRetirement.sweepRetiredDirectories(
						retiredRoot,
						orchestratorName,
					),
			};
			const deleted = cleanupOldRuns(
				root,
				ORCHESTRATOR_NAME,
				7,
				RUN_A,
				swapDelegate,
				runDirRoot,
			);
			console.error(
				`pathname-replacement proof: newIncarnationBootstrapped=${newIncarnationBootstrapped} deleted=${deleted}`,
			);
			assert.strictEqual(
				existsSync(runBDir),
				true,
				"expected: replacement incarnation survives; actual: canonical pathname was removed after the swap",
			);
			assert.strictEqual(existsSync(join(runBDir, "turnlock.sqlite3")), true);
			const takeover = acquireB(runBDir);
			assert.strictEqual(takeover.kind, "ACTIVE_CONFLICT");
			if (takeover.kind === "ACTIVE_CONFLICT") {
				assert.ok(takeover.leaseUntilEpochMs > Date.now());
			}
		} finally {
			cleanupTempDir(root);
		}
	});

	test("filesystem protocol: new canonical incarnation survives deletion of the retired path", () => {
		const root = makeTempDir();
		try {
			const runDir = join(root, "runs", ORCHESTRATOR_NAME, RUN_B);
			bootstrapForeignRun(runDir, RUN_B);
			expireLease(runDir);
			ageDir(runDir, 100);
			// 1. Retirement claimed on the OLD incarnation.
			const claim = claimB(runDir);
			assert.strictEqual(claim.kind, "CLAIMED");
			if (claim.kind !== "CLAIMED") throw new Error("setup");
			// 2. Atomic rename: old incarnation leaves the canonical path.
			const rename = renameRunDirectoryToRetired({
				driver: nodeSqliteDriver,
				runDir,
				runId: RUN_B,
				retirementToken: claim.retirementToken,
				incarnationId: claim.incarnationId,
				databaseIdentity: claim.databaseIdentity,
			});
			assert.strictEqual(rename.kind, "RENAMED");
			if (rename.kind !== "RENAMED") throw new Error("setup");
			assert.strictEqual(existsSync(runDir), false);
			// 3. A NEW incarnation bootstraps at the canonical pathname.
			const fresh = bootstrapForeignRun(runDir, RUN_B);
			assert.strictEqual(fresh.kind, "BOOTSTRAPPED");
			// 4. Deletion of the retired path runs to completion.
			const deletion = deleteRetiredRunDirectory(rename.retiredPath);
			assert.strictEqual(deletion.kind, "DELETED");
			assert.strictEqual(existsSync(rename.retiredPath), false);
			// 5. The new incarnation is completely untouched and still
			//    authoritative (live HELD ownership from its bootstrap).
			assert.strictEqual(existsSync(runDir), true);
			assert.strictEqual(existsSync(join(runDir, "turnlock.sqlite3")), true);
			const takeover = acquireB(runDir);
			assert.strictEqual(takeover.kind, "ACTIVE_CONFLICT");
			if (takeover.kind === "ACTIVE_CONFLICT") {
				assert.ok(takeover.leaseUntilEpochMs > Date.now());
			}
		} finally {
			cleanupTempDir(root);
		}
	});

	test("pathname replacement before rename: identity verification refuses to move the new incarnation", () => {
		const root = makeTempDir();
		try {
			const runDir = join(root, "runs", ORCHESTRATOR_NAME, RUN_B);
			bootstrapForeignRun(runDir, RUN_B);
			expireLease(runDir);
			const claim = claimB(runDir);
			assert.strictEqual(claim.kind, "CLAIMED");
			if (claim.kind !== "CLAIMED") throw new Error("setup");
			// Swap the canonical path with a brand-new incarnation BEFORE
			// the filesystem phase.
			rmSync(runDir, { recursive: true, force: true });
			const fresh = bootstrapForeignRun(runDir, RUN_B);
			assert.strictEqual(fresh.kind, "BOOTSTRAPPED");
			// The stale claim's identity must refuse the rename.
			const rename = renameRunDirectoryToRetired({
				driver: nodeSqliteDriver,
				runDir,
				runId: RUN_B,
				retirementToken: claim.retirementToken,
				incarnationId: claim.incarnationId,
				databaseIdentity: claim.databaseIdentity,
			});
			assert.strictEqual(rename.kind, "MISMATCH");
			// The new incarnation is untouched and still authoritative.
			assert.strictEqual(existsSync(runDir), true);
			assert.strictEqual(existsSync(join(runDir, "turnlock.sqlite3")), true);
			const takeover = acquireB(runDir);
			assert.strictEqual(takeover.kind, "ACTIVE_CONFLICT");
			if (takeover.kind === "ACTIVE_CONFLICT") {
				assert.ok(takeover.leaseUntilEpochMs > Date.now());
			}
		} finally {
			cleanupTempDir(root);
		}
	});
});
