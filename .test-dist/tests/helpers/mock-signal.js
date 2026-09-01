export function createControlledSignal() {
    const controller = new AbortController();
    return {
        signal: controller.signal,
        abort(reason) {
            controller.abort(reason);
        },
        abortAfter(ms, reason) {
            setTimeout(() => controller.abort(reason), ms).unref?.();
        },
        emitOsSignal(sig) {
            process.emit(sig);
        },
    };
}
//# sourceMappingURL=mock-signal.js.map