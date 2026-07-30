import { randomUUID } from "node:crypto";
import * as fs from "node:fs";

export type ImmutableFileInstallResult = "created" | "existing";

function isFileError(error: unknown, code: string): boolean {
	return (error as NodeJS.ErrnoException).code === code;
}

function pathExists(filePath: string): boolean {
	try {
		fs.lstatSync(filePath);
		return true;
	} catch (error) {
		if (isFileError(error, "ENOENT")) return false;
		throw error;
	}
}

function removeTemporaryFileBestEffort(temporaryPath: string): void {
	try {
		fs.unlinkSync(temporaryPath);
	} catch {
		// A stale uniquely named temp file is non-authoritative.
	}
}

export function installImmutableFileAtomic(
	targetPath: string,
	content: Uint8Array,
): ImmutableFileInstallResult {
	if (pathExists(targetPath)) return "existing";

	const temporaryPath = `${targetPath}.tmp-${process.pid}-${randomUUID()}`;
	const flags =
		fs.constants.O_WRONLY |
		fs.constants.O_CREAT |
		fs.constants.O_EXCL |
		fs.constants.O_NOFOLLOW;
	try {
		const descriptor = fs.openSync(temporaryPath, flags, 0o600);
		try {
			fs.writeFileSync(descriptor, content);
		} finally {
			fs.closeSync(descriptor);
		}

		try {
			// Hard-link publication is atomic and fails if a first artifact already won.
			fs.linkSync(temporaryPath, targetPath);
			return "created";
		} catch (error) {
			if (isFileError(error, "EEXIST")) return "existing";
			throw error;
		}
	} finally {
		removeTemporaryFileBestEffort(temporaryPath);
	}
}

export function readRegularFileBytes(filePath: string): Buffer {
	const flags = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW;
	const descriptor = fs.openSync(filePath, flags);
	try {
		if (!fs.fstatSync(descriptor).isFile()) {
			throw new Error("path is not a regular file");
		}
		return fs.readFileSync(descriptor);
	} finally {
		fs.closeSync(descriptor);
	}
}
