const DEFAULT_CRASH_WORKER_EXIT_TIMEOUT_MS = 5000;
export function isSubprocessAlive(subprocess) {
    if (subprocess.pid === undefined)
        return false;
    try {
        process.kill(subprocess.pid, 0);
        return true;
    }
    catch {
        return false;
    }
}
export function waitForExitWithTimeout(subprocess, description, timeoutMs = DEFAULT_CRASH_WORKER_EXIT_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            reject(new Error(`Timed out waiting for ${description} to exit after ${timeoutMs}ms`));
        }, timeoutMs);
        subprocess.exited.then((exitCode) => {
            clearTimeout(timeout);
            resolve(exitCode);
        }, (error) => {
            clearTimeout(timeout);
            reject(error);
        });
    });
}
export async function killAndWaitForSigkill(subprocess, description) {
    subprocess.kill("SIGKILL");
    const exitCode = await waitForExitWithTimeout(subprocess, description);
    if (subprocess.signalCode !== "SIGKILL") {
        throw new Error(`${description} did not exit from SIGKILL (signal=${String(subprocess.signalCode)}, exit=${exitCode})`);
    }
    return exitCode;
}
export async function killSubprocessIfAlive(subprocess, description) {
    if (!isSubprocessAlive(subprocess))
        return;
    await killAndWaitForSigkill(subprocess, description);
}
//# sourceMappingURL=crash-worker-process.js.map