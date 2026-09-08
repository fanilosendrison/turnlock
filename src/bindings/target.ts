import {
	LEGACY_V2_TARGET_COMPATIBILITY,
	MANIFEST_VERSION,
	MAX_WORKER_NAME_LENGTH,
} from "../constants.js";
import {
	AmbiguousLegacyDelegationTargetError,
	InvalidConfigError,
	ProtocolError,
} from "../errors/concrete.js";
import type { DelegationTarget } from "../types/delegation.js";
import type { ResolvedManifestTarget } from "./types.js";

/** Worker names follow the same deterministic shape as delegation labels. */
export const WORKER_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;

/**
 * Runtime validation for newly-authored logical delegation targets.
 *
 * Compile-time typing covers the happy path; this guard exists for runtime
 * input that can bypass it. Strict worker-name validation applies at this
 * authoring boundary and to unmarked v3 manifests.
 */
export function assertValidDelegationTarget(
	value: unknown,
	label: string,
): asserts value is DelegationTarget {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new InvalidConfigError(
			`delegation '${label}' target must be an object with kind 'host' or kind 'worker'`,
		);
	}
	const target = value as Record<string, unknown>;
	if (target.kind === "host") {
		const extra = Object.keys(target).filter((key) => key !== "kind");
		if (extra.length > 0) {
			throw new InvalidConfigError(
				`delegation '${label}' host target must not carry extra fields (found: ${extra.join(", ")})`,
			);
		}
		return;
	}
	if (target.kind === "worker") {
		const { name } = target;
		if (typeof name !== "string" || name.length === 0) {
			throw new InvalidConfigError(
				`delegation '${label}' worker target requires a non-empty name`,
			);
		}
		if (name.length > MAX_WORKER_NAME_LENGTH) {
			throw new InvalidConfigError(
				`delegation '${label}' worker name exceeds ${MAX_WORKER_NAME_LENGTH} characters`,
			);
		}
		if (!WORKER_NAME_PATTERN.test(name)) {
			throw new InvalidConfigError(
				`delegation '${label}' worker name '${name}' must match ${WORKER_NAME_PATTERN.source}`,
			);
		}
		const extra = Object.keys(target).filter(
			(key) => key !== "kind" && key !== "name",
		);
		if (extra.length > 0) {
			throw new InvalidConfigError(
				`delegation '${label}' worker target must not carry extra fields (found: ${extra.join(", ")})`,
			);
		}
		return;
	}
	throw new InvalidConfigError(
		`delegation '${label}' target kind must be 'host' or 'worker' (got: ${String(target.kind)})`,
	);
}

interface ManifestResolutionContext {
	readonly runId: string;
	readonly orchestratorName: string;
	readonly phase: string;
}

function protocolError(
	message: string,
	context: ManifestResolutionContext,
): ProtocolError {
	return new ProtocolError(message, context);
}

function resolveMarkedLegacyTarget(
	value: unknown,
	label: string,
	context: ManifestResolutionContext,
): ResolvedManifestTarget {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw protocolError(
			`delegation '${label}' legacy-v2 target must be an exact worker target`,
			context,
		);
	}
	const target = value as Record<string, unknown>;
	const keys = Object.keys(target);
	if (
		target.kind !== "worker" ||
		typeof target.name !== "string" ||
		target.name.length === 0 ||
		keys.length !== 2 ||
		!keys.includes("kind") ||
		!keys.includes("name")
	) {
		throw protocolError(
			`delegation '${label}' legacy-v2 target must be an exact worker target with a non-empty name`,
			context,
		);
	}
	return {
		target: { kind: "worker", name: target.name },
		targetCompatibility: LEGACY_V2_TARGET_COMPATIBILITY,
	};
}

/**
 * Resolve a stored manifest's target and the validation regime that accepted
 * it. New/unmarked v3 targets remain strict. A v2 worker is preserved
 * byte-for-byte and marked when rewritten as v3, so no later retry can make
 * the same immutable logical destination invalid. Ambiguous v2 manifests
 * and unknown compatibility markers fail closed.
 */
export function resolveManifestTarget(
	raw: Record<string, unknown>,
	label: string,
	context: ManifestResolutionContext,
): ResolvedManifestTarget {
	const version = raw.manifestVersion;
	if (version === MANIFEST_VERSION) {
		const compatibility = raw.targetCompatibility;
		if (compatibility === undefined) {
			assertValidDelegationTarget(raw.target, label);
			return { target: raw.target };
		}
		if (compatibility === LEGACY_V2_TARGET_COMPATIBILITY) {
			return resolveMarkedLegacyTarget(raw.target, label, context);
		}
		throw protocolError(
			`delegation '${label}' has unsupported target compatibility marker: ${String(compatibility)}`,
			context,
		);
	}
	if (version === 2) {
		const worker = raw.worker;
		if (typeof worker === "string" && worker.length > 0) {
			return {
				target: { kind: "worker", name: worker },
				targetCompatibility: LEGACY_V2_TARGET_COMPATIBILITY,
			};
		}
		throw new AmbiguousLegacyDelegationTargetError(
			`delegation '${label}' was recorded by manifest v2 without a worker — its logical target is ambiguous and cannot be re-executed; no legacy default (such as host) is assumed`,
			context,
		);
	}
	throw protocolError(
		`manifestVersion mismatch: expected ${MANIFEST_VERSION} or legacy 2, got ${String(version)}`,
		context,
	);
}
