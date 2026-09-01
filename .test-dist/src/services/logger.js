import * as fs from "node:fs";
export function createLogger(policy) {
    if (policy?.enabled === false) {
        return {
            emit: () => { },
            enableDiskEmit: () => { },
            disableDiskEmit: () => { },
        };
    }
    const custom = policy?.logger;
    const stderrEmit = custom
        ? (ev) => custom.emit(ev)
        : (ev) => {
            process.stderr.write(`${JSON.stringify(ev)}\n`);
        };
    const persistEnabled = policy?.persistEventLog !== false;
    let diskPath = null;
    function emit(ev) {
        try {
            stderrEmit(ev);
        }
        catch {
            // silent
        }
        if (diskPath !== null) {
            try {
                fs.appendFileSync(diskPath, `${JSON.stringify(ev)}\n`, {
                    encoding: "utf-8",
                });
            }
            catch {
                // silent
            }
        }
    }
    function enableDiskEmit(eventsNdjsonPath) {
        if (!persistEnabled)
            return;
        diskPath = eventsNdjsonPath;
    }
    function disableDiskEmit() {
        diskPath = null;
    }
    return { emit, enableDiskEmit, disableDiskEmit };
}
//# sourceMappingURL=logger.js.map