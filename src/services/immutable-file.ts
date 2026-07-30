import * as fs from "node:fs";

export type ImmutableFileInstallResult = "created" | "existing";

function isMissingFileError(error: unknown): boolean {
	return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function pathExists(filePath: string): boolean {
	try {
		fs.lstatSync(filePath);
		return true;
	} catch (error) {
		if (isMissingFileError(error)) return false;
		throw error;
	}
}

export function installImmutableFileAtomic(
	targetPath: string,
	content: Uint8Array,
): ImmutableFileInstallResult {
	if (pathExists(targetPath)) return "existing";

	const temporaryPath = `${targetPath}.tmp`;
	try {
		fs.writeFileSync(temporaryPath, content);
		if (pathExists(targetPath)) return "existing";
		fs.renameSync(temporaryPath, targetPath);
		return "created";
	} finally {
		try {
			fs.unlinkSync(temporaryPath);
		} catch (error) {
			if (!isMissingFileError(error)) throw error;
		}
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
