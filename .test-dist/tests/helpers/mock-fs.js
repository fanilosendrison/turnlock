import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
/**
 * MockFs is backed by a real temp dir so that sync fs primitives (openSync with
 * O_EXCL, writeFileSync, renameSync, readFileSync) exercise the real POSIX
 * semantics. Cleanup happens via reset().
 */
export function createMockFs() {
    let root = mkdtempSync(join(tmpdir(), "turnlock-test-"));
    const errorInjections = new Map();
    const ensureDir = (filePath) => {
        mkdirSync(dirname(filePath), { recursive: true });
    };
    const self = {
        get root() {
            return root;
        },
        writeFile(path, content) {
            const injected = errorInjections.get(path);
            if (injected !== undefined) {
                errorInjections.delete(path);
                throw injected;
            }
            ensureDir(path);
            writeFileSync(path, content, { encoding: "utf-8" });
        },
        readFile(path) {
            return readFileSync(path, { encoding: "utf-8" });
        },
        exists(path) {
            return existsSync(path);
        },
        list(path) {
            if (!existsSync(path))
                return [];
            return readdirSync(path);
        },
        rm(path) {
            if (existsSync(path)) {
                const stat = statSync(path);
                if (stat.isDirectory()) {
                    rmSync(path, { recursive: true, force: true });
                }
                else {
                    rmSync(path, { force: true });
                }
            }
        },
        injectWriteError(path, error) {
            errorInjections.set(path, error);
        },
        reset() {
            rmSync(root, { recursive: true, force: true });
            errorInjections.clear();
            root = mkdtempSync(join(tmpdir(), "turnlock-test-"));
        },
    };
    return self;
}
//# sourceMappingURL=mock-fs.js.map