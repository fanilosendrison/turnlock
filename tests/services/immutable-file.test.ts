import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
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
			expect(
				readdirSync(dir).filter((name) =>
					name.startsWith("accepted.json.tmp-"),
				),
			).toEqual([]);
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
			expect(
				readdirSync(dir).filter((name) =>
					name.startsWith("accepted.json.tmp-"),
				),
			).toEqual([]);
		} finally {
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

			expect(
				installImmutableFileAtomic(target, Buffer.from('{"value":"accepted"}')),
			).toBe("existing");
			expect(readFileSync(outside, "utf-8")).toBe('{"value":"outside"}');
			expect(() => readRegularFileBytes(target)).toThrow();
		} finally {
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

			expect(
				installImmutableFileAtomic(target, Buffer.from('{"value":"accepted"}')),
			).toBe("created");
			expect(readFileSync(outside, "utf-8")).toBe('{"value":"outside"}');
			expect(readRegularFileBytes(target)).toEqual(
				Buffer.from('{"value":"accepted"}'),
			);
		} finally {
			cleanupTempDir(dir);
		}
	});
});
