import * as fs from "node:fs";
export class TestExitSignal {
    code;
    __turnlockExit = true;
    constructor(code) {
        this.code = code;
    }
}
const IS_TEST = (() => {
    if (process.env.TURNLOCK_TEST === "0")
        return false;
    if (process.env.TURNLOCK_TEST === "1")
        return true;
    if (process.env.NODE_TEST_CONTEXT !== undefined)
        return true;
    if (process.env.NODE_ENV === "test")
        return true;
    return false;
})();
export function doExit(code) {
    if (IS_TEST) {
        throw new TestExitSignal(code);
    }
    process.exit(code);
}
export function isTestExitSignal(err) {
    return (typeof err === "object" &&
        err !== null &&
        err.__turnlockExit === true);
}
export function writeFileSyncAtomic(targetPath, content) {
    const tmpPath = `${targetPath}.tmp`;
    fs.writeFileSync(tmpPath, content);
    fs.renameSync(tmpPath, targetPath);
}
//# sourceMappingURL=context.js.map