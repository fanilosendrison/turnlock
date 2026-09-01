import {
	existsSync,
	readdirSync,
	readFileSync,
	realpathSync,
	statSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const BUN_REFERENCE_PATTERN =
	/(?:\bbun(?:x)?\b|\bBun\.|bun:test|bun:sqlite|bun\.lockb?)/iu;

const DEFAULT_POLICY_PATH = "docs/migrations/node-pnpm/bun-allowlist.json";
const EXCLUDED_ROOTS = new Set([".git", "node_modules", "dist", ".test-dist"]);

function normalizePath(path) {
	return path.split(sep).join("/");
}

function listFiles(repositoryRoot, directory = repositoryRoot) {
	const files = [];
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		if (directory === repositoryRoot && EXCLUDED_ROOTS.has(entry.name)) {
			continue;
		}
		const absolutePath = join(directory, entry.name);
		if (entry.isSymbolicLink()) {
			throw new Error(
				`retired-runtime policy rejects symlinks: ${absolutePath}`,
			);
		}
		if (entry.isDirectory()) {
			files.push(...listFiles(repositoryRoot, absolutePath));
		} else if (entry.isFile()) {
			files.push(absolutePath);
		}
	}
	return files;
}

function isExcluded(relativePath) {
	return relativePath.startsWith("docs/migrations/node-pnpm/archive/");
}

export function validateBunPolicy(
	repositoryRoot,
	policyPath = DEFAULT_POLICY_PATH,
) {
	const root = realpathSync(repositoryRoot);
	const absolutePolicyPath = resolve(root, policyPath);
	if (!existsSync(absolutePolicyPath)) {
		throw new Error(`Bun policy not found: ${absolutePolicyPath}`);
	}
	const policy = JSON.parse(readFileSync(absolutePolicyPath, "utf8"));
	if (
		policy.version !== 1 ||
		policy.status !== "active" ||
		policy.default !== "deny" ||
		!Array.isArray(policy.permanentExceptions)
	) {
		throw new Error("Bun policy has an unsupported shape");
	}

	const exceptions = new Map();
	for (const exception of policy.permanentExceptions) {
		if (
			typeof exception.path !== "string" ||
			!Array.isArray(exception.requiredLiterals) ||
			exceptions.has(exception.path)
		) {
			throw new Error("Bun policy contains an invalid or duplicate exception");
		}
		exceptions.set(exception.path, exception);
	}

	const findings = [];
	const observedExceptions = new Set();
	for (const absolutePath of listFiles(root)) {
		const relativePath = normalizePath(relative(root, absolutePath));
		if (relativePath === policyPath || isExcluded(relativePath)) continue;
		const realPath = realpathSync(absolutePath);
		if (!realPath.startsWith(`${root}${sep}`) || !statSync(realPath).isFile()) {
			throw new Error(`policy path escapes repository: ${relativePath}`);
		}
		let content;
		try {
			content = readFileSync(realPath, "utf8");
		} catch {
			continue;
		}
		if (!BUN_REFERENCE_PATTERN.test(content)) continue;
		const exception = exceptions.get(relativePath);
		if (exception === undefined) {
			findings.push(`${relativePath}: unexpected Bun reference`);
			continue;
		}
		observedExceptions.add(relativePath);
		for (const literal of exception.requiredLiterals) {
			if (typeof literal !== "string" || !content.includes(literal)) {
				findings.push(
					`${relativePath}: missing required literal ${JSON.stringify(literal)}`,
				);
			}
		}
	}

	for (const [relativePath] of exceptions) {
		if (!observedExceptions.has(relativePath)) {
			findings.push(`${relativePath}: stale Bun policy exception`);
		}
	}
	if (findings.length > 0) {
		throw new Error(findings.sort().join("\n"));
	}
	return {
		checkedFiles: listFiles(root).length,
		exceptions: observedExceptions.size,
	};
}

const invokedPath =
	process.argv[1] === undefined ? "" : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
	const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
	const result = validateBunPolicy(repositoryRoot);
	process.stderr.write(
		`retired-runtime policy: ${result.checkedFiles} files, ${result.exceptions} exceptions\n`,
	);
}
