import assert from "node:assert/strict";
import { readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { installImmutableFileAtomic, readRegularFileBytes, } from "../../src/services/immutable-file.js";
import { cleanupTempDir, makeTempDir } from "../helpers/temp-run-dir.js";
describe("immutable file installation", () => {
    test("publishes exact bytes atomically and removes the temporary file", () => {
        const dir = makeTempDir();
        const target = join(dir, "accepted.json");
        try {
            assert.strictEqual(installImmutableFileAtomic(target, Buffer.from('{"value":"A"}')), "created");
            assert.deepStrictEqual(readFileSync(target), Buffer.from('{"value":"A"}'));
            assert.deepStrictEqual(readdirSync(dir).filter((name) => name.startsWith("accepted.json.tmp-")), []);
        }
        finally {
            cleanupTempDir(dir);
        }
    });
    test("never overwrites an already accepted artifact", () => {
        const dir = makeTempDir();
        const target = join(dir, "accepted.json");
        try {
            installImmutableFileAtomic(target, Buffer.from('{"value":"A"}'));
            assert.strictEqual(installImmutableFileAtomic(target, Buffer.from('{"value":"B"}')), "existing");
            assert.deepStrictEqual(readRegularFileBytes(target), Buffer.from('{"value":"A"}'));
            assert.deepStrictEqual(readdirSync(dir).filter((name) => name.startsWith("accepted.json.tmp-")), []);
        }
        finally {
            cleanupTempDir(dir);
        }
    });
    test("never replaces a pre-existing target symlink", () => {
        const dir = makeTempDir();
        const target = join(dir, "accepted.json");
        const outside = join(dir, "outside.json");
        try {
            writeFileSync(outside, '{"value":"outside"}');
            symlinkSync(outside, target);
            assert.strictEqual(installImmutableFileAtomic(target, Buffer.from('{"value":"accepted"}')), "existing");
            assert.strictEqual(readFileSync(outside, "utf-8"), '{"value":"outside"}');
            assert.throws(() => readRegularFileBytes(target));
        }
        finally {
            cleanupTempDir(dir);
        }
    });
    test("never follows a pre-created temporary-file symlink", () => {
        const dir = makeTempDir();
        const target = join(dir, "accepted.json");
        const outside = join(dir, "outside.json");
        try {
            writeFileSync(outside, '{"value":"outside"}');
            symlinkSync(outside, `${target}.tmp`);
            assert.strictEqual(installImmutableFileAtomic(target, Buffer.from('{"value":"accepted"}')), "created");
            assert.strictEqual(readFileSync(outside, "utf-8"), '{"value":"outside"}');
            assert.deepStrictEqual(readRegularFileBytes(target), Buffer.from('{"value":"accepted"}'));
        }
        finally {
            cleanupTempDir(dir);
        }
    });
});
//# sourceMappingURL=immutable-file.test.js.map