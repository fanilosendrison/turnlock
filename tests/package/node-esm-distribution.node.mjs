import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const REPOSITORY_ROOT = resolve(dirname(import.meta.filename), "../..");
const TYPESCRIPT_ENTRYPOINT = join(
	REPOSITORY_ROOT,
	"node_modules",
	"typescript",
	"bin",
	"tsc",
);

function run(command, arguments_, options = {}) {
	const result = spawnSync(command, arguments_, {
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024,
		shell: false,
		...options,
	});
	assert.equal(result.signal, null);
	assert.equal(result.status, 0, result.stderr || result.stdout);
	return result;
}

test("the packed package resolves runtime and types from an isolated consumer", () => {
	const root = mkdtempSync(join(tmpdir(), "turnlock-package-consumer-"));
	const packDirectory = join(root, "packed");
	const consumerDirectory = join(root, "consumer");
	try {
		writeFileSync(
			join(root, "package.json"),
			JSON.stringify({ private: true, type: "module" }),
		);
		run(
			"pnpm",
			[
				"--config.ignore-scripts=true",
				"pack",
				"--pack-destination",
				packDirectory,
			],
			{ cwd: REPOSITORY_ROOT },
		);
		const archives = readdirSync(packDirectory).filter((name) =>
			name.endsWith(".tgz"),
		);
		assert.deepEqual(archives, ["turnlock-0.12.0.tgz"]);
		const archivePath = join(packDirectory, archives[0]);

		writeFileSync(
			join(root, "pnpm-workspace.yaml"),
			"packages:\n  - consumer\n",
		);
		mkdirSync(consumerDirectory);
		writeFileSync(
			join(consumerDirectory, "package.json"),
			JSON.stringify({ private: true, type: "module" }),
			{ flag: "wx" },
		);
		run(
			"pnpm",
			[
				"add",
				"--offline",
				"--ignore-scripts",
				"--dir",
				consumerDirectory,
				archivePath,
			],
			{ cwd: root },
		);

		const runtimePath = join(consumerDirectory, "runtime.mjs");
		writeFileSync(
			runtimePath,
			[
				'import { PROTOCOL_VERSION } from "turnlock";',
				'if (PROTOCOL_VERSION !== 3) throw new Error("unexpected protocol version");',
				'process.stdout.write(import.meta.resolve("turnlock"));',
			].join("\n"),
		);
		const runtime = run(process.execPath, [runtimePath], {
			cwd: consumerDirectory,
		});
		const resolvedEntrypoint = runtime.stdout;
		assert.ok(
			resolvedEntrypoint.startsWith(pathToFileURL(realpathSync(root)).href),
			resolvedEntrypoint,
		);
		assert.ok(
			resolvedEntrypoint.includes("/node_modules/.pnpm/turnlock@file+"),
		);
		assert.ok(resolvedEntrypoint.endsWith("/dist/index.js"));
		assert.equal(
			resolvedEntrypoint.includes(pathToFileURL(REPOSITORY_ROOT).href),
			false,
		);

		const fixtureSource = readFileSync(
			join(
				REPOSITORY_ROOT,
				"tests",
				"package",
				"fixtures",
				"node-esm-consumer.mts",
			),
			"utf8",
		);
		writeFileSync(join(consumerDirectory, "consumer.mts"), fixtureSource);
		writeFileSync(
			join(consumerDirectory, "tsconfig.json"),
			JSON.stringify({
				compilerOptions: {
					target: "ES2022",
					module: "NodeNext",
					moduleResolution: "NodeNext",
					strict: true,
					noEmit: true,
					types: [],
					skipLibCheck: true,
				},
				include: ["consumer.mts"],
			}),
		);
		run(process.execPath, [TYPESCRIPT_ENTRYPOINT, "-p", "tsconfig.json"], {
			cwd: consumerDirectory,
		});

		for (const relativePath of [
			"README.md",
			"dist/index.js",
			"dist/index.d.ts",
			"docs/sqlite-ownership-migration.md",
			"docs/adr/0001-logical-delegation-targets.md",
			"docs/adr/README.md",
			"docs/architecture/delegation-model.md",
		]) {
			assert.equal(
				existsSync(
					join(consumerDirectory, "node_modules", "turnlock", relativePath),
				),
				true,
				`installed package must include ${relativePath}`,
			);
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
