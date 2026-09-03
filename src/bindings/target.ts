import { MANIFEST_VERSION, MAX_WORKER_NAME_LENGTH } from "../constants.js";
import {
	AmbiguousLegacyDelegationTargetError,
	InvalidConfigError,
	ProtocolError,
} from "../errors/concrete.js";
import type { DelegationTarget } from "../types/delegation.js";
/** Worker names follow the same deterministic shape as delegation labels. */
export const WORKER_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;
/**
 * Runtime validation for logical delegation targets (fail-closed).
 *
 * Compile-time typing covers the happy path; this guard exists for runtime
 * input that can bypass it (JavaScript consumers, `as any` casts, or data
 * read back from disk).  A structurally invalid target must never produce
 * an ambiguous manifest.
 *
 * @throws InvalidConfigError for any invalid shape.
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
/**
 * Resolve the logical target of a stored delegation manifest during
 * re-emission.
 *
 * - v3 manifests: `target` is mandatory and validated fail-closed.
 * - v2 manifests with a non-empty `worker`: deterministic migration to
 *   `{ kind: "worker", name: worker }`.  The historical name is preserved
 *   byte-for-byte — v2 imposed no naming constraints, so migration does not
 *   retroactively reject what v2 accepted.
 * - v2 manifests without `worker`: NEVER guessed as host.  The legacy
 *   contract allowed absence but did not normatively establish a meaning;
 *   re-execution therefore fails closed.
 * - any other manifestVersion: fail closed (unknown/unsupported version).
 */
export function resolveManifestTarget(
	raw: Record<string, unknown>,
	label: string,
	context: {
		readonly runId: string;
		readonly orchestratorName: string;
		readonly phase: string;
	},
): DelegationTarget {
	const version = raw.manifestVersion;
	if (version === MANIFEST_VERSION) {
		assertValidDelegationTarget(raw.target, label);
		return raw.target;
	}
	if (version === 2) {
		const worker = raw.worker;
		if (typeof worker === "string" && worker.length > 0) {
			return { kind: "worker", name: worker };
		}
		throw new AmbiguousLegacyDelegationTargetError(
			`delegation '${label}' was recorded by manifest v2 without a worker — its logical target is ambiguous and cannot be re-executed; no legacy default (such as host) is assumed`,
			{
				runId: context.runId,
				orchestratorName: context.orchestratorName,
				phase: context.phase,
			},
		);
	}
	throw new ProtocolError(
		`manifestVersion mismatch: expected ${MANIFEST_VERSION} or legacy 2, got ${String(version)}`,
		{
			runId: context.runId,
			orchestratorName: context.orchestratorName,
			phase: context.phase,
		},
	);
}
