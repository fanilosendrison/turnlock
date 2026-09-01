export interface ControlledSignal {
	readonly signal: AbortSignal;
	abort(reason?: unknown): void;
	abortAfter(ms: number, reason?: unknown): void;
	emitOsSignal(sig: "SIGINT" | "SIGTERM"): void;
}
export function createControlledSignal(): ControlledSignal {
	const controller = new AbortController();
	return {
		signal: controller.signal,
		abort(reason?: unknown): void {
			controller.abort(reason);
		},
		abortAfter(ms: number, reason?: unknown): void {
			setTimeout(() => controller.abort(reason), ms).unref?.();
		},
		emitOsSignal(sig: "SIGINT" | "SIGTERM"): void {
			process.emit(sig);
		},
	};
}
