import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	installImmutableFileAtomic,
	readRegularFileBytes,
} from "../../src/services/immutable-file";
import { cleanupTempDir, makeTempDir } from "../helpers/temp-run-dir";

describe("immutable file installation", () => {
	test("publishes exact bytes atomically and removes the temporary file", () => {
		const dir = makeTempDir();
		const target = join(dir, "accepted.json");
		try {
			expect(
				installImmutableFileAtomic(target, Buffer.from('{"value":"A"}')),
			).toBe("created");
			expect(readFileSync(target)).toEqual(Buffer.from('{"value":"A"}'));
			expect(existsSync(`${target}.tmp`)).toBe(false);
		} finally {
			cleanupTempDir(dir);
		}
	});

	test("never overwrites an already accepted artifact", () => {
		const dir = makeTempDir();
		const target = join(dir, "accepted.json");
		try {
			installImmutableFileAtomic(target, Buffer.from('{"value":"A"}'));
			expect(
				installImmutableFileAtomic(target, Buffer.from('{"value":"B"}')),
			).toBe("existing");
			expect(readRegularFileBytes(target)).toEqual(
				Buffer.from('{"value":"A"}'),
			);
			expect(existsSync(`${target}.tmp`)).toBe(false);
		} finally {
			cleanupTempDir(dir);
		}
	});
});
