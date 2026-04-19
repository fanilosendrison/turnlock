import { AbortedError } from "../errors/concrete";

export function abortableSleep(
	delayMs: number,
	signal: AbortSignal,
): Promise<void> {
	if (signal.aborted) {
		return Promise.reject(
			new AbortedError("aborted before sleep", { cause: signal.reason }),
		);
	}
	if (delayMs <= 0) return Promise.resolve();

	return new Promise<void>((resolve, reject) => {
		const onAbort = () => {
			clearTimeout(timer);
			reject(
				new AbortedError("aborted during sleep", { cause: signal.reason }),
			);
		};
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, delayMs);
		signal.addEventListener("abort", onAbort, { once: true });
	});
}
