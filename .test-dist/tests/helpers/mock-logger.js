export function createMockLogger() {
    const events = [];
    let diskPath = null;
    const self = {
        events,
        emit(event) {
            events.push(event);
        },
        enableDiskEmit(path) {
            diskPath = path;
        },
        disableDiskEmit() {
            diskPath = null;
        },
        reset() {
            events.length = 0;
            diskPath = null;
        },
        find(eventType) {
            return events.find((e) => e.eventType === eventType);
        },
        findAll(eventType) {
            return events.filter((e) => e.eventType === eventType);
        },
        eventTypes() {
            return events.map((e) => e.eventType);
        },
    };
    // Reference diskPath so that TS doesn't flag the assignments as dead writes.
    Object.defineProperty(self, "__diskPath", {
        get: () => diskPath,
        enumerable: false,
    });
    return self;
}
//# sourceMappingURL=mock-logger.js.map