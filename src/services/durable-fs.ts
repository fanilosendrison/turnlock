// Small durable-filesystem primitives shared by the retention protocol
// and the retirement READY journal.
//
// `fsyncDirectory` is the cross-platform (macOS/Linux) way to make a
// directory ENTRY durable: open the directory O_RDONLY, fsync the file
// descriptor, close it.  After an atomic rename into a directory, the
// parent directory must be fsynced for the rename itself to survive
// power loss — fsyncing only the file is not enough.
import * as fs from "node:fs";
import * as path from "node:path";

/** Durably persist the directory entries of `directoryPath`.
 *
 *  Compatible with the macOS/Linux CI platforms:
 *    open directory O_RDONLY → fsync(fd) → close
 *
 *  Throws on failure — callers decide how to fail closed (the retention
 *  protocol treats a failed directory fsync as NO READY, NO DELETE). */
export function fsyncDirectory(directoryPath: string): void {
	const fd = fs.openSync(directoryPath, fs.constants.O_RDONLY);
	try {
		fs.fsyncSync(fd);
	} finally {
		fs.closeSync(fd);
	}
}

/** Ensure a directory path exists without traversing a symbolic link.
 *
 * Recursive `mkdir` follows an existing symlink in any parent component.
 * Retention and artifact paths are derived from protocol identities, so
 * silently following such a link could move writes or deletion outside the
 * intended namespace.  Every existing component is lstat-checked and a
 * component created during this call is checked again immediately. */
export function ensureDirectoryPathWithoutSymlinks(
	directoryPath: string,
	protectedFrom?: string,
): void {
	const absolutePath = path.resolve(directoryPath);
	const root = path.parse(absolutePath).root;
	const protectedPath = path.resolve(protectedFrom ?? absolutePath);
	if (
		protectedPath !== absolutePath &&
		!absolutePath.startsWith(`${protectedPath}${path.sep}`)
	) {
		throw new Error(
			`protected directory is not an ancestor of target: ${protectedPath}`,
		);
	}
	const components = absolutePath
		.slice(root.length)
		.split(path.sep)
		.filter(Boolean);
	const protectedComponents = protectedPath
		.slice(root.length)
		.split(path.sep)
		.filter(Boolean);
	const firstProtectedIndex = Math.max(0, protectedComponents.length - 1);
	let current = root;
	for (const [index, component] of components.entries()) {
		current = path.join(current, component);
		let stat: fs.Stats;
		try {
			stat = fs.lstatSync(current);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			fs.mkdirSync(current);
			stat = fs.lstatSync(current);
		}
		// Platform aliases such as macOS /var → /private/var are permitted
		// before the caller's semantic namespace.  Every component at and
		// below that boundary must be a real directory.
		if (
			index >= firstProtectedIndex &&
			(stat.isSymbolicLink() || !stat.isDirectory())
		) {
			throw new Error(
				`directory path component is not a real directory: ${current}`,
			);
		}
	}
}
