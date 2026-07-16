import type { Phase } from "./types/phase";

export function definePhase<State extends object = object, Output = unknown>(
	fn: Phase<State, Output>,
): Phase<State, Output> {
	return fn;
}
