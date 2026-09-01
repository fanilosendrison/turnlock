import { spawn, } from "node:child_process";
import { constants as osConstants } from "node:os";
function streamText(stream) {
    stream.setEncoding("utf8");
    let text = "";
    stream.on("data", (chunk) => {
        text += chunk;
    });
    return new Promise((resolve, reject) => {
        stream.on("end", () => resolve(text));
        stream.on("error", reject);
    });
}
function normalizedExitCode(code, signal) {
    if (code !== null)
        return code;
    if (signal === null)
        return 1;
    return 128 + osConstants.signals[signal];
}
export function spawnNode(modulePath, arguments_ = [], options = {}) {
    const child = spawn(process.execPath, [modulePath, ...arguments_], {
        ...options,
        stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = streamText(child.stdout);
    const stderr = streamText(child.stderr);
    const exited = new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code, signal) => {
            resolve(normalizedExitCode(code, signal));
        });
    });
    return {
        get pid() {
            return child.pid;
        },
        get signalCode() {
            return child.signalCode;
        },
        exited,
        stdout,
        stderr,
        kill(signal) {
            child.kill(signal);
        },
    };
}
//# sourceMappingURL=node-subprocess.js.map