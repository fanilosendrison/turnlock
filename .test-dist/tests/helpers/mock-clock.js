export function createMockClock(initialIso = "2026-04-19T12:00:00.000Z", initialEpoch, initialMono = 0) {
    let wall = new Date(initialIso);
    let epoch = initialEpoch ?? wall.getTime();
    let mono = initialMono;
    return {
        nowWall() {
            return new Date(wall.getTime());
        },
        nowWallIso() {
            return wall.toISOString();
        },
        nowEpochMs() {
            return epoch;
        },
        nowMono() {
            return mono;
        },
        setWall(isoOrDate) {
            wall =
                typeof isoOrDate === "string"
                    ? new Date(isoOrDate)
                    : new Date(isoOrDate.getTime());
        },
        setEpochMs(ms) {
            epoch = ms;
        },
        setMono(ms) {
            mono = ms;
        },
        advanceWall(ms) {
            wall = new Date(wall.getTime() + ms);
        },
        advanceEpoch(ms) {
            epoch += ms;
        },
        advanceMono(ms) {
            mono += ms;
        },
    };
}
//# sourceMappingURL=mock-clock.js.map