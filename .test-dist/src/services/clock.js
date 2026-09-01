export const clock = {
    nowWall: () => new Date(),
    nowWallIso: () => new Date().toISOString(),
    nowEpochMs: () => Date.now(),
    nowMono: () => performance.now(),
};
//# sourceMappingURL=clock.js.map