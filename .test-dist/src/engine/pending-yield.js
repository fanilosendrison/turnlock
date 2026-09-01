export function clearPendingYield(state) {
    const cleared = { ...state };
    Reflect.deleteProperty(cleared, "pendingDelegation");
    Reflect.deleteProperty(cleared, "pendingExternalRequest");
    Reflect.deleteProperty(cleared, "terminalResult");
    return cleared;
}
//# sourceMappingURL=pending-yield.js.map