import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const packageEntryPointUrl = pathToFileURL(
	resolve(import.meta.dirname, "../../dist/index.js"),
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
