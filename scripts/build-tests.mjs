import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = join(repositoryRoot, ".test-dist");
const sourceTestsRoot = join(repositoryRoot, "tests");
const outputTestsRoot = join(outputRoot, "tests");

rmSync(outputRoot, { recursive: true, force: true });
const typecheck = spawnSync(
	process.execPath,
	[
		join(repositoryRoot, "node_modules", "typescript", "bin", "tsc"),
		"-p",
		join(repositoryRoot, "tsconfig.test.json"),
	],
	{ cwd: repositoryRoot, encoding: "utf8" },
);
if (typecheck.status !== 0) {
	process.stderr.write(typecheck.stdout);
	process.stderr.write(typecheck.stderr);
	process.exit(typecheck.status ?? 1);
}

function copyTestAssets(directory) {
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const sourcePath = join(directory, entry.name);
		if (entry.isSymbolicLink()) {
			throw new Error(`test assets must not contain symlinks: ${sourcePath}`);
		}
		if (entry.isDirectory()) {
			if (entry.name !== "package") copyTestAssets(sourcePath);
			continue;
		}
		if (!entry.isFile() || entry.name.endsWith(".ts")) continue;
		const destinationPath = join(
			outputTestsRoot,
			relative(sourceTestsRoot, sourcePath),
		);
		mkdirSync(dirname(destinationPath), { recursive: true });
		cpSync(sourcePath, destinationPath, {
			dereference: false,
			errorOnExist: true,
		});
	}
}

copyTestAssets(sourceTestsRoot);
if (!existsSync(join(outputRoot, "src", "index.js"))) {
	throw new Error("test build did not emit the compiled runtime entry point");
}
