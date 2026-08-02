const DEFAULT_CRASH_WORKER_EXIT_TIMEOUT_MS = 5_000;

export interface CrashWorkerSubprocess {
	readonly pid: number | undefined;
	readonly exited: Promise<number>;
	readonly signalCode: NodeJS.Signals | null;
	kill(signal?: number | NodeJS.Signals): void;
}

export function isSubprocessAlive(subprocess: CrashWorkerSubprocess): boolean {
	if (subprocess.pid === undefined) return false;
	try {
		process.kill(subprocess.pid, 0);
		return true;
	} catch {
		return false;
	}
}

export function waitForExitWithTimeout(
	subprocess: CrashWorkerSubprocess,
	description: string,
	timeoutMs = DEFAULT_CRASH_WORKER_EXIT_TIMEOUT_MS,
): Promise<number> {
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			reject(
				new Error(
					`Timed out waiting for ${description} to exit after ${timeoutMs}ms`,
				),
			);
		}, timeoutMs);
		subprocess.exited.then(
			(exitCode) => {
				clearTimeout(timeout);
				resolve(exitCode);
			},
			(error: unknown) => {
				clearTimeout(timeout);
				reject(error);
			},
		);
	});
}

export async function killAndWaitForSigkill(
	subprocess: CrashWorkerSubprocess,
	description: string,
): Promise<number> {
	subprocess.kill("SIGKILL");
	const exitCode = await waitForExitWithTimeout(subprocess, description);
	if (subprocess.signalCode !== "SIGKILL") {
		throw new Error(
			`${description} did not exit from SIGKILL (signal=${String(subprocess.signalCode)}, exit=${exitCode})`,
		);
	}
	return exitCode;
}

export async function killSubprocessIfAlive(
	subprocess: CrashWorkerSubprocess,
	description: string,
): Promise<void> {
	if (!isSubprocessAlive(subprocess)) return;
	await killAndWaitForSigkill(subprocess, description);
}
