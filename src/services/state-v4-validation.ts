import {
	MAX_EVENT_FIELD_LENGTH,
	MAX_EXTERNAL_LABEL_LENGTH,
} from "../constants.js";
import { StateCorruptedError } from "../errors/concrete.js";
import { isContentDigest } from "./content-digest.js";
import {
	assertStateArtifactRef,
	isIsoStateTimestamp,
	isNonEmptyStateString,
	isNonNegativeStateNumber,
	requireStateRecord,
} from "./state-value-validation.js";

export function validatePendingDelegationV4(value: unknown): void {
	const pending = requireStateRecord(value, "pendingDelegation");
	if (!isNonEmptyStateString(pending.label)) {
		throw new StateCorruptedError("pendingDelegation.label invalid");
	}
	if (pending.kind !== "prompt" && pending.kind !== "batch") {
		throw new StateCorruptedError("pendingDelegation.kind invalid");
	}
	const hasV4 = pending.manifestArtifact !== undefined;
	const hasV3 = pending.manifestPath !== undefined;
	if (!hasV4 && !hasV3) {
		throw new StateCorruptedError(
			"pendingDelegation must have manifestArtifact or manifestPath",
		);
	}
	if (hasV4) {
		assertStateArtifactRef(
			pending.manifestArtifact,
			"pendingDelegation.manifestArtifact",
			"delegation-manifest",
		);
	} else if (
		typeof pending.manifestPath !== "string" ||
		pending.manifestPath.length === 0
	) {
		throw new StateCorruptedError("pendingDelegation.manifestPath invalid");
	}
	if (
		!isNonEmptyStateString(pending.resumeAt) ||
		!isNonNegativeStateNumber(pending.emittedAtEpochMs) ||
		!isNonNegativeStateNumber(pending.deadlineAtEpochMs) ||
		!Number.isInteger(pending.attempt) ||
		!isNonNegativeStateNumber(pending.attempt)
	) {
		throw new StateCorruptedError("pendingDelegation fields invalid");
	}
	const policy = requireStateRecord(
		pending.effectiveRetryPolicy,
		"pendingDelegation.effectiveRetryPolicy",
	);
	if (
		!isNonNegativeStateNumber(policy.maxAttempts) ||
		!isNonNegativeStateNumber(policy.backoffBaseMs) ||
		!isNonNegativeStateNumber(policy.maxBackoffMs)
	) {
		throw new StateCorruptedError(
			"pendingDelegation.effectiveRetryPolicy invalid",
		);
	}
	if (
		pending.kind === "batch" &&
		(!Array.isArray(pending.jobIds) ||
			!pending.jobIds.every((jobId: unknown) => isNonEmptyStateString(jobId)))
	) {
		throw new StateCorruptedError("pendingDelegation.jobIds invalid");
	}
	if (
		pending.jobIds !== undefined &&
		(!Array.isArray(pending.jobIds) ||
			!pending.jobIds.every((jobId: unknown) => isNonEmptyStateString(jobId)))
	) {
		throw new StateCorruptedError("pendingDelegation.jobIds invalid");
	}
}

export function validatePendingExternalRequestV4(
	value: unknown,
	runId: string,
	usedLabels: readonly string[],
): void {
	const pending = requireStateRecord(value, "pendingExternalRequest");
	if (
		!isNonEmptyStateString(pending.requestId) ||
		pending.requestId.length > MAX_EVENT_FIELD_LENGTH ||
		!isNonEmptyStateString(pending.label) ||
		pending.label.length > MAX_EXTERNAL_LABEL_LENGTH ||
		!/^[a-z][a-z0-9-]*$/.test(pending.label) ||
		!isNonEmptyStateString(pending.requestType) ||
		pending.requestType.trim().length === 0 ||
		pending.requestType.length > MAX_EVENT_FIELD_LENGTH ||
		/[\u0000-\u001f\u007f]/.test(pending.requestType) ||
		!isNonEmptyStateString(pending.resumeAt) ||
		!isNonEmptyStateString(pending.resultPath) ||
		!isNonEmptyStateString(pending.emittedAt) ||
		!isNonNegativeStateNumber(pending.emittedAtEpochMs)
	) {
		throw new StateCorruptedError("pendingExternalRequest fields invalid");
	}
	const hasV4 = pending.manifestArtifact !== undefined;
	const hasV3 =
		pending.manifestPath !== undefined && pending.manifestDigest !== undefined;
	if (!hasV4 && !hasV3) {
		throw new StateCorruptedError(
			"pendingExternalRequest must have manifestArtifact or manifestPath+manifestDigest",
		);
	}
	if (hasV4) {
		assertStateArtifactRef(
			pending.manifestArtifact,
			"pendingExternalRequest.manifestArtifact",
			"external-request-manifest",
		);
	} else {
		if (
			typeof pending.manifestPath !== "string" ||
			pending.manifestPath.length === 0
		) {
			throw new StateCorruptedError(
				"pendingExternalRequest.manifestPath invalid",
			);
		}
		if (!isContentDigest(pending.manifestDigest)) {
			throw new StateCorruptedError(
				"pendingExternalRequest.manifestDigest invalid",
			);
		}
	}
	const acceptedFields = [
		pending.acceptedResolutionPath,
		pending.acceptedResolutionDigest,
		pending.acceptedAt,
	];
	const acceptedFieldCount = acceptedFields.filter(
		(field) => field !== undefined,
	).length;
	if (
		acceptedFieldCount !== 0 &&
		acceptedFieldCount !== acceptedFields.length
	) {
		throw new StateCorruptedError(
			"pendingExternalRequest accepted resolution fields are incomplete",
		);
	}
	if (
		acceptedFieldCount === acceptedFields.length &&
		(!isNonEmptyStateString(pending.acceptedResolutionPath) ||
			!isContentDigest(pending.acceptedResolutionDigest) ||
			!isIsoStateTimestamp(pending.acceptedAt))
	) {
		throw new StateCorruptedError(
			"pendingExternalRequest accepted resolution fields are invalid",
		);
	}
	if (pending.requestId !== `${runId}/${pending.label}`) {
		throw new StateCorruptedError("pendingExternalRequest identity invalid");
	}
	if (!usedLabels.includes(pending.label)) {
		throw new StateCorruptedError(
			"pendingExternalRequest label missing from usedLabels",
		);
	}
}
