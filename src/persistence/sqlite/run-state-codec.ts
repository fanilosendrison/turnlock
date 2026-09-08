import { createHash } from "node:crypto";
import {
	LEGACY_PENDING_INITIAL_DISPATCH_STATE_FIELD,
	LEGACY_PENDING_INITIAL_DISPATCH_VERSION_STATE_FIELD,
	PENDING_INITIAL_DISPATCH_STATE_FIELD,
	PENDING_INITIAL_DISPATCH_VERSION,
	PENDING_INITIAL_DISPATCH_VERSION_STATE_FIELD,
} from "../../constants.js";
import { DbIntegrityError } from "./errors.js";

export function bigintFromStateRow(value: unknown): bigint {
	if (typeof value === "bigint") return value;
	if (typeof value === "number") return BigInt(value);
	throw new DbIntegrityError(`expected bigint, got ${typeof value}`);
}

export function computeStateDigest(json: string): string {
	return `sha256:${createHash("sha256").update(json).digest("hex")}`;
}

/** Recognise a versioned pending initial-dispatch marker. */
export function isPendingInitialDispatchV1(
	parsed: Record<string, unknown>,
): boolean {
	const newMarker =
		parsed[PENDING_INITIAL_DISPATCH_STATE_FIELD] === true &&
		parsed[PENDING_INITIAL_DISPATCH_VERSION_STATE_FIELD] ===
			PENDING_INITIAL_DISPATCH_VERSION;
	const legacyMarker =
		parsed[LEGACY_PENDING_INITIAL_DISPATCH_STATE_FIELD] === true &&
		parsed[LEGACY_PENDING_INITIAL_DISPATCH_VERSION_STATE_FIELD] ===
			PENDING_INITIAL_DISPATCH_VERSION;
	return newMarker || legacyMarker;
}

export function stripAllPendingInitialDispatchMarkers(
	state: Record<string, unknown>,
): void {
	delete state[PENDING_INITIAL_DISPATCH_STATE_FIELD];
	delete state[PENDING_INITIAL_DISPATCH_VERSION_STATE_FIELD];
	delete state[LEGACY_PENDING_INITIAL_DISPATCH_STATE_FIELD];
	delete state[LEGACY_PENDING_INITIAL_DISPATCH_VERSION_STATE_FIELD];
}
