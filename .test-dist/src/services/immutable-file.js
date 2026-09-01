import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
function isFileError(error, code) {
    return error.code === code;
}
function pathExists(filePath) {
    try {
        fs.lstatSync(filePath);
        return true;
    }
    catch (error) {
        if (isFileError(error, "ENOENT"))
            return false;
        throw error;
    }
}
function removeTemporaryFileBestEffort(temporaryPath) {
    try {
        fs.unlinkSync(temporaryPath);
    }
    catch {
        // A stale uniquely named temp file is non-authoritative.
    }
}
export function installImmutableFileAtomic(targetPath, content) {
    if (pathExists(targetPath))
        return "existing";
    const temporaryPath = `${targetPath}.tmp-${process.pid}-${randomUUID()}`;
    const flags = fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        fs.constants.O_NOFOLLOW;
    try {
        const descriptor = fs.openSync(temporaryPath, flags, 0o600);
        try {
            fs.writeFileSync(descriptor, content);
        }
        finally {
            fs.closeSync(descriptor);
        }
        try {
            // Hard-link publication is atomic and fails if a first artifact already won.
            fs.linkSync(temporaryPath, targetPath);
            return "created";
        }
        catch (error) {
            if (isFileError(error, "EEXIST"))
                return "existing";
            throw error;
        }
    }
    finally {
        removeTemporaryFileBestEffort(temporaryPath);
    }
}
export function readRegularFileBytes(filePath) {
    const flags = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW;
    const descriptor = fs.openSync(filePath, flags);
    try {
        if (!fs.fstatSync(descriptor).isFile()) {
            throw new Error("path is not a regular file");
        }
        return fs.readFileSync(descriptor);
    }
    finally {
        fs.closeSync(descriptor);
    }
}
//# sourceMappingURL=immutable-file.js.map