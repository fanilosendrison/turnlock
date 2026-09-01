import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
export interface MockFs {
	readonly root: string;
	writeFile(path: string, content: string): void;
	readFile(path: string): string;
	exists(path: string): boolean;
	list(path: string): string[];
	rm(path: string): void;
	injectWriteError(path: string, error: Error): void;
	reset(): void;
}
/**
 * MockFs is backed by a real temp dir so that sync fs primitives (openSync with
 * O_EXCL, writeFileSync, renameSync, readFileSync) exercise the real POSIX
 * semantics. Cleanup happens via reset().
 */
export function createMockFs(): MockFs {
	let root = mkdtempSync(join(tmpdir(), "turnlock-test-"));
	const errorInjections = new Map<string, Error>();
	const ensureDir = (filePath: string): void => {
		mkdirSync(dirname(filePath), { recursive: true });
	};
	const self: MockFs = {
		get root() {
			return root;
		},
		writeFile(path: string, content: string): void {
			const injected = errorInjections.get(path);
			if (injected !== undefined) {
				errorInjections.delete(path);
				throw injected;
			}
			ensureDir(path);
			writeFileSync(path, content, { encoding: "utf-8" });
		},
		readFile(path: string): string {
			return readFileSync(path, { encoding: "utf-8" });
		},
		exists(path: string): boolean {
			return existsSync(path);
		},
		list(path: string): string[] {
			if (!existsSync(path)) return [];
			return readdirSync(path);
		},
		rm(path: string): void {
			if (existsSync(path)) {
				const stat = statSync(path);
				if (stat.isDirectory()) {
					rmSync(path, { recursive: true, force: true });
				} else {
					rmSync(path, { force: true });
				}
			}
		},
		injectWriteError(path: string, error: Error): void {
			errorInjections.set(path, error);
		},
		reset(): void {
			rmSync(root, { recursive: true, force: true });
			errorInjections.clear();
			root = mkdtempSync(join(tmpdir(), "turnlock-test-"));
		},
	};
	return self;
}
