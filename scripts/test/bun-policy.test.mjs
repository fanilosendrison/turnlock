import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { validateBunPolicy } from "../validate-bun-policy.mjs";

function createFixture() {
	const root = mkdtempSync(join(tmpdir(), "turnlock-bun-policy-"));
	mkdirSync(join(root, "docs", "migrations", "node-pnpm"), {
		recursive: true,
	});
	mkdirSync(join(root, "src"), { recursive: true });
	writeFileSync(join(root, "src", "clean.ts"), "export const clean = true;\n");
	return root;
}

function writePolicy(root, exceptions = []) {
	writeFileSync(
		join(root, "docs", "migrations", "node-pnpm", "bun-allowlist.json"),
		JSON.stringify({
			version: 1,
			status: "active",
			default: "deny",
			permanentExceptions: exceptions,
		}),
	);
}

test("accepts a repository without retired-runtime references", () => {
	const root = createFixture();
	try {
		writePolicy(root);
		assert.equal(validateBunPolicy(root).exceptions, 0);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("rejects an unexpected bun:test import", () => {
	const root = createFixture();
	try {
		writePolicy(root);
		writeFileSync(join(root, "src", "bad.ts"), 'import "bun:test";\n');
		assert.throws(() => validateBunPolicy(root), /unexpected Bun reference/u);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("requires every literal in an exact exception", () => {
	const root = createFixture();
	try {
		writePolicy(root, [
			{
				path: "src/external-command.ts",
				requiredLiterals: ["bun run test", "opaque consumer command"],
			},
		]);
		writeFileSync(
			join(root, "src", "external-command.ts"),
			'export const command = "bun run test";\n',
		);
		assert.throws(() => validateBunPolicy(root), /missing required literal/u);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
