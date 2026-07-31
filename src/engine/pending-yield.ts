import type { StateFile } from "../services/state-io";

export function clearPendingYield<S>(state: StateFile<S>): StateFile<S> {
	const cleared = { ...state };
	Reflect.deleteProperty(cleared, "pendingDelegation");
	Reflect.deleteProperty(cleared, "pendingExternalRequest");
	Reflect.deleteProperty(cleared, "terminalResult");
	return cleared;
}
