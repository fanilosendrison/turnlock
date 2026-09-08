import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { nodeSqliteDriver } from "../../src/persistence/sqlite/node-sqlite-driver.js";
import { readJsonFile } from "./e2e-process.js";

/**
 * Replace an emitted manifest with a digest-consistent legacy v2 snapshot.
 * Both the immutable artifact and the authoritative SQLite reference are
 * updated so resume exercises the real compatibility path.
 */
export function rewriteStoredManifestAsV2(
	runDir: string,
	label: string,
	options: { readonly worker: string | undefined },
): void {
	const statePath = join(runDir, "state.json");
	const state = readJsonFile<{
		pendingDelegation?: {
			manifestArtifact?: {
				digest: string;
				relativePath: string;
				sizeBytes: number;
			};
		};
	}>(statePath);
	const artifact = state.pendingDelegation?.manifestArtifact;
	if (artifact === undefined) {
		assert.fail("expected a manifestArtifact in the initial state");
	}
	const current = readJsonFile<Record<string, unknown>>(
		join(runDir, "delegations", `${label}-0.json`),
	);
	const legacy: Record<string, unknown> = {
		...current,
		manifestVersion: 2,
	};
	delete legacy.target;
	if (options.worker !== undefined) {
		legacy.worker = options.worker;
	}
	const bytes = Buffer.from(JSON.stringify(legacy), "utf-8");
	const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
	const hex = digest.slice(7);
	const relativePath = `artifacts/sha256/${hex.slice(0, 2)}/${hex.slice(2)}.json`;
	const newRef = {
		kind: "delegation-manifest",
		digestAlgorithm: "sha256",
		digest,
		relativePath,
		mediaType: "application/json",
		sizeBytes: bytes.length,
	};
	mkdirSync(join(runDir, "artifacts", "sha256", hex.slice(0, 2)), {
		recursive: true,
	});
	writeFileSync(join(runDir, relativePath), bytes);
	writeFileSync(
		join(runDir, "delegations", `${label}-0.json`),
		JSON.stringify(legacy, null, "\t"),
	);

	const db = nodeSqliteDriver.open(join(runDir, "turnlock.sqlite3"));
	try {
		const row = db
			.prepare("SELECT state_json FROM run_state WHERE singleton = 1")
			.get<{ readonly state_json: string }>();
		if (row === undefined) assert.fail("expected run_state row");
		const parsed = JSON.parse(row.state_json) as Record<string, unknown>;
		const pending = parsed.pendingDelegation as Record<string, unknown>;
		pending.manifestArtifact = newRef;
		const newJson = JSON.stringify(parsed);
		const newDigest = `sha256:${createHash("sha256").update(newJson).digest("hex")}`;
		db.prepare(
			"UPDATE run_state SET state_json = ?, state_digest = ? WHERE singleton = 1",
		).run(newJson, newDigest);
	} finally {
		db.close();
	}
	rmSync(statePath, { force: true });
}
