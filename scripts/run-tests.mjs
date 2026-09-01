import { spawnSync } from "node:child_process";
import {
	existsSync,
	readdirSync,
	readFileSync,
	realpathSync,
	statSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = join(repositoryRoot, "tests", "test-manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

if (
	manifest.version !== 1 ||
	!Number.isInteger(manifest.expectedFiles) ||
	!Array.isArray(manifest.testFiles)
) {
	throw new Error("tests/test-manifest.json has an unsupported shape");
}

function discoverTests(directory) {
	const tests = [];
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const fullPath = join(directory, entry.name);
		if (entry.isSymbolicLink()) {
			throw new Error(`test discovery rejects symlinks: ${fullPath}`);
		}
		if (entry.isDirectory()) {
			if (entry.name !== "package") tests.push(...discoverTests(fullPath));
		} else if (entry.isFile() && entry.name.endsWith(".test.ts")) {
			tests.push(relative(repositoryRoot, fullPath).split(sep).join("/"));
		}
	}
	return tests.sort();
}

const declaredTests = [...manifest.testFiles].sort();
const discoveredTests = discoverTests(join(repositoryRoot, "tests"));
if (new Set(declaredTests).size !== declaredTests.length) {
	throw new Error("test manifest contains duplicate paths");
}
if (
	declaredTests.length !== manifest.expectedFiles ||
	JSON.stringify(declaredTests) !== JSON.stringify(discoveredTests)
) {
	throw new Error(
		`test manifest mismatch: expected ${manifest.expectedFiles}, declared ${declaredTests.length}, discovered ${discoveredTests.length}`,
	);
}

const repositoryPrefix = `${realpathSync(repositoryRoot)}${sep}`;
const compiledTests = declaredTests.map((testPath) => {
	const sourcePath = resolve(repositoryRoot, testPath);
	const realSourcePath = realpathSync(sourcePath);
	if (
		!realSourcePath.startsWith(repositoryPrefix) ||
		!statSync(realSourcePath).isFile()
	) {
		throw new Error(`test path escapes the repository: ${testPath}`);
	}
	const compiledPath = join(
		repositoryRoot,
		".test-dist",
		testPath.replace(/\.ts$/u, ".js"),
	);
	if (!existsSync(compiledPath)) {
		throw new Error(`compiled test is missing: ${compiledPath}`);
	}
	return compiledPath;
});

const result = spawnSync(
	process.execPath,
	["--test", "--test-concurrency=1", ...compiledTests],
	{ cwd: repositoryRoot, stdio: "inherit" },
);
if (result.error) throw result.error;
process.exit(result.status ?? 1);
