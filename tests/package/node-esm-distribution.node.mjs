import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const REPO_ROOT = resolve(dirname(import.meta.filename), "../..");
const packageEntryPointUrl = pathToFileURL(
	resolve(REPO_ROOT, "dist/index.js"),
).href;

test("the built package entry point imports with Node ESM", () => {
	const result = spawnSync(
		process.execPath,
		[
			"--input-type=module",
			"--eval",
			`await import(${JSON.stringify(packageEntryPointUrl)})`,
		],
		{ encoding: "utf8" },
	);

	assert.equal(result.signal, null);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stdout, "");
	assert.equal(result.stderr, "");
});

test("the packed artifact contains the consumer-facing documentation", () => {
	// `--config.ignore-scripts=true` avoids re-running this test suite via
	// the prepack lifecycle. `--dry-run --json` lists the packed contents
	// without writing a tarball.
	const result = spawnSync(
		"pnpm",
		["--config.ignore-scripts=true", "pack", "--dry-run", "--json"],
		{ cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
	);
	assert.equal(result.status, 0, result.stderr);
	/** @type {{ version: string; files: Array<{ path: string }> }} */
	const packed = JSON.parse(result.stdout);
	assert.equal(packed.version, "0.11.0");
	const paths = new Set(packed.files.map((f) => f.path));
	for (const expected of [
		"README.md",
		"dist/index.js",
		"dist/index.d.ts",
		"docs/sqlite-ownership-migration.md",
		"docs/adr/0001-logical-delegation-targets.md",
		"docs/adr/README.md",
		"docs/architecture/delegation-model.md",
	]) {
		assert.equal(
			paths.has(expected),
			true,
			`packed artifact must include ${expected}`,
		);
	}
});
