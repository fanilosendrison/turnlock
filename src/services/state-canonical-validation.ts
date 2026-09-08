import { StateCorruptedError } from "../errors/concrete.js";
import {
	validatePendingDelegationV3,
	validatePendingExternalRequestV3,
} from "./state-v3-validation.js";
import {
	validatePendingDelegationV4,
	validatePendingExternalRequestV4,
} from "./state-v4-validation.js";
import {
	isNonEmptyStateString,
	isNonNegativeStateNumber,
	isTerminalDoneRecord,
} from "./state-value-validation.js";

/** Validate the canonical state shape and dispatch version-specific checks. */
export function validateCanonicalStateShape(
	obj: Record<string, unknown>,
	version: 2 | 3 | 4,
): void {
	const required: Array<[string, (value: unknown) => boolean]> = [
		["runId", isNonEmptyStateString],
		["orchestratorName", isNonEmptyStateString],
		["startedAt", (value) => typeof value === "string"],
		["startedAtEpochMs", isNonNegativeStateNumber],
		["lastTransitionAt", (value) => typeof value === "string"],
		["lastTransitionAtEpochMs", isNonNegativeStateNumber],
		["currentPhase", (value) => typeof value === "string"],
		["phasesExecuted", isNonNegativeStateNumber],
		["accumulatedDurationMs", isNonNegativeStateNumber],
		["data", (value) => value !== undefined],
		[
			"usedLabels",
			(value) =>
				Array.isArray(value) &&
				value.every((label) => typeof label === "string"),
		],
	];
	for (const [field, check] of required) {
		if (!(field in obj)) {
			throw new StateCorruptedError(
				`state.json missing required field: ${field}`,
			);
		}
		if (!check(obj[field])) {
			throw new StateCorruptedError(
				`state.json field ${field} has wrong type or value`,
			);
		}
	}
	const hasDelegation = obj.pendingDelegation !== undefined;
	const hasExternal = obj.pendingExternalRequest !== undefined;
	if (hasDelegation && obj.pendingDelegation === null) {
		throw new StateCorruptedError("pendingDelegation cannot be null");
	}
	if (hasExternal && obj.pendingExternalRequest === null) {
		throw new StateCorruptedError("pendingExternalRequest cannot be null");
	}
	if (version === 2 && hasExternal) {
		throw new StateCorruptedError(
			"pendingExternalRequest is invalid in state schema v2",
		);
	}
	if (hasDelegation && hasExternal) {
		throw new StateCorruptedError(
			"pendingDelegation and pendingExternalRequest are mutually exclusive",
		);
	}
	if (hasDelegation) {
		if (version <= 3) {
			validatePendingDelegationV3(obj.pendingDelegation);
		} else {
			validatePendingDelegationV4(obj.pendingDelegation);
		}
	}
	if (hasExternal) {
		if (version <= 3) {
			validatePendingExternalRequestV3(
				obj.pendingExternalRequest,
				obj.runId as string,
				obj.usedLabels as readonly string[],
			);
		} else {
			validatePendingExternalRequestV4(
				obj.pendingExternalRequest,
				obj.runId as string,
				obj.usedLabels as readonly string[],
			);
		}
	}
	if (version >= 4 && obj.terminalResult !== undefined) {
		if (!isTerminalDoneRecord(obj.terminalResult)) {
			throw new StateCorruptedError(
				"state.json terminalResult is not a valid TerminalDoneRecord",
			);
		}
	}
}
