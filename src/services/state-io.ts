import * as fs from "node:fs";
import * as path from "node:path";
import type { ZodSchema } from "zod";
import {
	MAX_EVENT_FIELD_LENGTH,
	MAX_EXTERNAL_LABEL_LENGTH,
	STATE_SCHEMA_VERSION,
} from "../constants";
import {
	type MigrationBlockReason,
	StateCorruptedError,
	StateMigrationBlockedError,
	StateVersionMismatchError,
} from "../errors/concrete";
import type { ArtifactRef, TerminalDoneRecord } from "../types/artifacts";
import { installPreparedArtifact } from "./artifact-store";
import { contentDigest, isContentDigest } from "./content-digest";
import { summarizeZodError } from "./validator";

// ---------------------------------------------------------------------------
// Schema version history
// ---------------------------------------------------------------------------

const LEGACY_STATE_SCHEMA_VERSION = 2 as const;
const PREVIOUS_STATE_SCHEMA_VERSION = 3 as const;

// ---------------------------------------------------------------------------
// Types (v4 — current)
// ---------------------------------------------------------------------------

export interface PendingDelegationRecord {
	readonly label: string;
	readonly kind: "prompt" | "batch";
	readonly resumeAt: string;
	/** v4+: immutable blob reference. Required for new writes. */
	readonly manifestArtifact?: ArtifactRef;
	/** @deprecated v3 field — still accepted at runtime for migration. */
	readonly manifestPath?: string;
	readonly emittedAtEpochMs: number;
	readonly deadlineAtEpochMs: number;
	readonly attempt: number;
	readonly effectiveRetryPolicy: {
		readonly maxAttempts: number;
		readonly backoffBaseMs: number;
		readonly maxBackoffMs: number;
	};
	readonly jobIds?: readonly string[];
}

export interface PendingExternalRequestRecord {
	readonly requestId: string;
	readonly label: string;
	readonly requestType: string;
	readonly resumeAt: string;
	/** v4+: immutable blob reference. Required for new writes. */
	readonly manifestArtifact?: ArtifactRef;
	/** @deprecated v3 fields — still accepted at runtime for migration. */
	readonly manifestPath?: string;
	/** @deprecated v3 field — still accepted at runtime for migration. */
	readonly manifestDigest?: string;
	readonly resultPath: string;
	readonly emittedAt: string;
	readonly emittedAtEpochMs: number;
	readonly acceptedResolutionPath?: string;
	readonly acceptedResolutionDigest?: string;
	readonly acceptedAt?: string;
}

export interface StateFile<State> {
	readonly schemaVersion: typeof STATE_SCHEMA_VERSION;
	readonly runId: string;
	readonly orchestratorName: string;
	readonly startedAt: string;
	readonly startedAtEpochMs: number;
	// Historical schema field name: retained until a future STATE_SCHEMA_VERSION bump.
	// It records the last non-terminal protocol-yield emission timestamp.
	readonly lastTransitionAt: string;
	readonly lastTransitionAtEpochMs: number;
	readonly currentPhase: string;
	readonly phasesExecuted: number;
	readonly accumulatedDurationMs: number;
	readonly data: State;
	readonly pendingDelegation?: PendingDelegationRecord;
	readonly pendingExternalRequest?: PendingExternalRequestRecord;
	readonly terminalResult?: TerminalDoneRecord;
	readonly usedLabels: readonly string[];
}

export interface StateSnapshot<State> {
	readonly state: StateFile<State> | null;
	readonly migratedFromVersion:
		| typeof LEGACY_STATE_SCHEMA_VERSION
		| typeof PREVIOUS_STATE_SCHEMA_VERSION
		| null;
}

// ---------------------------------------------------------------------------
// ArtifactRef helpers
// ---------------------------------------------------------------------------

function isArtifactRef(value: unknown): value is ArtifactRef {
	if (typeof value !== "object" || value === null) return false;
	const r = value as Record<string, unknown>;
	return (
		typeof r.kind === "string" &&
		(r.kind === "terminal-output" ||
			r.kind === "delegation-manifest" ||
			r.kind === "external-request-manifest") &&
		r.digestAlgorithm === "sha256" &&
		isContentDigest(r.digest) &&
		typeof r.relativePath === "string" &&
		r.relativePath.length > 0 &&
		r.mediaType === "application/json" &&
		typeof r.sizeBytes === "number" &&
		Number.isInteger(r.sizeBytes) &&
		r.sizeBytes >= 0
	);
}

function assertArtifactRef(
	value: unknown,
	field: string,
	expectedKind?: ArtifactRef["kind"],
): ArtifactRef {
	if (!isArtifactRef(value)) {
		throw new StateCorruptedError(
			`state.json field ${field} is not a valid ArtifactRef`,
		);
	}
	if (expectedKind !== undefined && value.kind !== expectedKind) {
		throw new StateCorruptedError(
			`state.json field ${field} has wrong kind: expected ${expectedKind}, got ${value.kind}`,
		);
	}
	return value;
}

function isTerminalDoneRecord(value: unknown): value is TerminalDoneRecord {
	if (typeof value !== "object" || value === null) return false;
	const r = value as Record<string, unknown>;
	return (
		r.kind === "done" &&
		isArtifactRef(r.outputArtifact) &&
		r.outputArtifact.kind === "terminal-output" &&
		typeof r.completedAt === "string" &&
		typeof r.completedAtEpochMs === "number" &&
		Number.isFinite(r.completedAtEpochMs)
	);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function describeError(err: unknown): string {
	if (err instanceof Error) return err.message.slice(0, 200);
	return String(err).slice(0, 200);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function isNonNegativeNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isIsoTimestamp(value: unknown): value is string {
	if (typeof value !== "string") return false;
	try {
		return new Date(value).toISOString() === value;
	} catch {
		return false;
	}
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new StateCorruptedError(
			`state.json field ${field} has wrong type or value`,
		);
	}
	return value as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Validation (v4)
// ---------------------------------------------------------------------------

function validatePendingDelegationV4(value: unknown): void {
	const pending = requireRecord(value, "pendingDelegation");
	if (!isNonEmptyString(pending.label)) {
		throw new StateCorruptedError("pendingDelegation.label invalid");
	}
	if (pending.kind !== "prompt" && pending.kind !== "batch") {
		throw new StateCorruptedError("pendingDelegation.kind invalid");
	}
	// Accept both v4 (manifestArtifact) and v3-legacy (manifestPath) shapes.
	const hasV4 = pending.manifestArtifact !== undefined;
	const hasV3 = pending.manifestPath !== undefined;
	if (!hasV4 && !hasV3) {
		throw new StateCorruptedError(
			"pendingDelegation must have manifestArtifact or manifestPath",
		);
	}
	if (hasV4) {
		assertArtifactRef(
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
		!isNonEmptyString(pending.resumeAt) ||
		!isNonNegativeNumber(pending.emittedAtEpochMs) ||
		!isNonNegativeNumber(pending.deadlineAtEpochMs) ||
		!Number.isInteger(pending.attempt) ||
		!isNonNegativeNumber(pending.attempt)
	) {
		throw new StateCorruptedError("pendingDelegation fields invalid");
	}
	const policy = requireRecord(
		pending.effectiveRetryPolicy,
		"pendingDelegation.effectiveRetryPolicy",
	);
	if (
		!isNonNegativeNumber(policy.maxAttempts) ||
		!isNonNegativeNumber(policy.backoffBaseMs) ||
		!isNonNegativeNumber(policy.maxBackoffMs)
	) {
		throw new StateCorruptedError(
			"pendingDelegation.effectiveRetryPolicy invalid",
		);
	}
	if (
		pending.kind === "batch" &&
		(!Array.isArray(pending.jobIds) ||
			!pending.jobIds.every((jobId: unknown) => isNonEmptyString(jobId)))
	) {
		throw new StateCorruptedError("pendingDelegation.jobIds invalid");
	}
	if (
		pending.jobIds !== undefined &&
		(!Array.isArray(pending.jobIds) ||
			!pending.jobIds.every((jobId: unknown) => isNonEmptyString(jobId)))
	) {
		throw new StateCorruptedError("pendingDelegation.jobIds invalid");
	}
}

function validatePendingExternalRequestV4(
	value: unknown,
	runId: string,
	usedLabels: readonly string[],
): void {
	const pending = requireRecord(value, "pendingExternalRequest");
	if (
		!isNonEmptyString(pending.requestId) ||
		pending.requestId.length > MAX_EVENT_FIELD_LENGTH ||
		!isNonEmptyString(pending.label) ||
		pending.label.length > MAX_EXTERNAL_LABEL_LENGTH ||
		!/^[a-z][a-z0-9-]*$/.test(pending.label) ||
		!isNonEmptyString(pending.requestType) ||
		pending.requestType.trim().length === 0 ||
		pending.requestType.length > MAX_EVENT_FIELD_LENGTH ||
		/[\u0000-\u001f\u007f]/.test(pending.requestType) ||
		!isNonEmptyString(pending.resumeAt) ||
		!isNonEmptyString(pending.resultPath) ||
		!isNonEmptyString(pending.emittedAt) ||
		!isNonNegativeNumber(pending.emittedAtEpochMs)
	) {
		throw new StateCorruptedError("pendingExternalRequest fields invalid");
	}
	// Accept both v4 (manifestArtifact) and v3-legacy (manifestPath + manifestDigest) shapes.
	const hasV4 = pending.manifestArtifact !== undefined;
	const hasV3 =
		pending.manifestPath !== undefined && pending.manifestDigest !== undefined;
	if (!hasV4 && !hasV3) {
		throw new StateCorruptedError(
			"pendingExternalRequest must have manifestArtifact or manifestPath+manifestDigest",
		);
	}
	if (hasV4) {
		assertArtifactRef(
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
		(value) => value !== undefined,
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
		(!isNonEmptyString(pending.acceptedResolutionPath) ||
			!isContentDigest(pending.acceptedResolutionDigest) ||
			!isIsoTimestamp(pending.acceptedAt))
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

// ---------------------------------------------------------------------------
// Validation (v3 — backward-compatible reads)
// ---------------------------------------------------------------------------

function validatePendingDelegationV3(value: unknown): void {
	const pending = requireRecord(value, "pendingDelegation");
	if (!isNonEmptyString(pending.label)) {
		throw new StateCorruptedError("pendingDelegation.label invalid");
	}
	if (pending.kind !== "prompt" && pending.kind !== "batch") {
		throw new StateCorruptedError("pendingDelegation.kind invalid");
	}
	if (
		!isNonEmptyString(pending.resumeAt) ||
		!isNonEmptyString(pending.manifestPath) ||
		!isNonNegativeNumber(pending.emittedAtEpochMs) ||
		!isNonNegativeNumber(pending.deadlineAtEpochMs) ||
		!Number.isInteger(pending.attempt) ||
		!isNonNegativeNumber(pending.attempt)
	) {
		throw new StateCorruptedError("pendingDelegation fields invalid");
	}
	const policy = requireRecord(
		pending.effectiveRetryPolicy,
		"pendingDelegation.effectiveRetryPolicy",
	);
	if (
		!isNonNegativeNumber(policy.maxAttempts) ||
		!isNonNegativeNumber(policy.backoffBaseMs) ||
		!isNonNegativeNumber(policy.maxBackoffMs)
	) {
		throw new StateCorruptedError(
			"pendingDelegation.effectiveRetryPolicy invalid",
		);
	}
	if (
		pending.kind === "batch" &&
		(!Array.isArray(pending.jobIds) ||
			!pending.jobIds.every((jobId) => isNonEmptyString(jobId)))
	) {
		throw new StateCorruptedError("pendingDelegation.jobIds invalid");
	}
	if (
		pending.jobIds !== undefined &&
		(!Array.isArray(pending.jobIds) ||
			!pending.jobIds.every((jobId) => isNonEmptyString(jobId)))
	) {
		throw new StateCorruptedError("pendingDelegation.jobIds invalid");
	}
}

function validatePendingExternalRequestV3(
	value: unknown,
	runId: string,
	usedLabels: readonly string[],
): void {
	const pending = requireRecord(value, "pendingExternalRequest");
	if (
		!isNonEmptyString(pending.requestId) ||
		pending.requestId.length > MAX_EVENT_FIELD_LENGTH ||
		!isNonEmptyString(pending.label) ||
		pending.label.length > MAX_EXTERNAL_LABEL_LENGTH ||
		!/^[a-z][a-z0-9-]*$/.test(pending.label) ||
		!isNonEmptyString(pending.requestType) ||
		pending.requestType.trim().length === 0 ||
		pending.requestType.length > MAX_EVENT_FIELD_LENGTH ||
		/[\u0000-\u001f\u007f]/.test(pending.requestType) ||
		!isNonEmptyString(pending.resumeAt) ||
		!isNonEmptyString(pending.manifestPath) ||
		!isContentDigest(pending.manifestDigest) ||
		!isNonEmptyString(pending.resultPath) ||
		!isNonEmptyString(pending.emittedAt) ||
		!isNonNegativeNumber(pending.emittedAtEpochMs)
	) {
		throw new StateCorruptedError("pendingExternalRequest fields invalid");
	}

	const acceptedFields = [
		pending.acceptedResolutionPath,
		pending.acceptedResolutionDigest,
		pending.acceptedAt,
	];
	const acceptedFieldCount = acceptedFields.filter(
		(value) => value !== undefined,
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
		(!isNonEmptyString(pending.acceptedResolutionPath) ||
			!isContentDigest(pending.acceptedResolutionDigest) ||
			!isIsoTimestamp(pending.acceptedAt))
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

// ---------------------------------------------------------------------------
// Canonical shape validation
// ---------------------------------------------------------------------------

function validateCanonicalShape(
	obj: Record<string, unknown>,
	version: 2 | 3 | 4,
): void {
	const required: Array<[string, (value: unknown) => boolean]> = [
		["runId", isNonEmptyString],
		["orchestratorName", isNonEmptyString],
		["startedAt", (value) => typeof value === "string"],
		["startedAtEpochMs", isNonNegativeNumber],
		["lastTransitionAt", (value) => typeof value === "string"],
		["lastTransitionAtEpochMs", isNonNegativeNumber],
		["currentPhase", (value) => typeof value === "string"],
		["phasesExecuted", isNonNegativeNumber],
		["accumulatedDurationMs", isNonNegativeNumber],
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

	// v4: optional terminalResult
	if (version >= 4 && obj.terminalResult !== undefined) {
		if (!isTerminalDoneRecord(obj.terminalResult)) {
			throw new StateCorruptedError(
				"state.json terminalResult is not a valid TerminalDoneRecord",
			);
		}
	}
}

// ---------------------------------------------------------------------------
// Parsing + migration
// ---------------------------------------------------------------------------

function parseStateFile(runDir: string): Record<string, unknown> | null {
	const statePath = path.join(runDir, "state.json");
	if (!fs.existsSync(statePath)) return null;

	let raw: string;
	try {
		raw = fs.readFileSync(statePath, "utf-8");
	} catch (err) {
		throw new StateCorruptedError(
			`failed to read state.json: ${describeError(err)}`,
			{ cause: err },
		);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		throw new StateCorruptedError(
			`state.json is not valid JSON: ${describeError(err)}`,
			{ cause: err },
		);
	}

	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new StateCorruptedError("state.json must be a JSON object");
	}
	return parsed as Record<string, unknown>;
}

function migrateV2ToV3(
	parsed: Record<string, unknown>,
): Record<string, unknown> {
	const migrated = {
		...parsed,
		schemaVersion: PREVIOUS_STATE_SCHEMA_VERSION,
	};
	Reflect.deleteProperty(migrated, "pendingExternalRequest");
	return migrated;
}

// ---------------------------------------------------------------------------
// Migration result type (v3 → v4)
// ---------------------------------------------------------------------------

export type MigrationResult =
	| {
			readonly kind: "MIGRATED";
			readonly state: Record<string, unknown>;
	  }
	| {
			readonly kind: "BLOCKED";
			readonly reason: MigrationBlockReason;
			readonly path?: string;
			readonly cause?: unknown;
	  };

/** Migrate a v3 state record to v4 by converting manifestPath/manifestDigest
 *  fields to manifestArtifact.  Reads the old manifest file from disk to
 *  compute the digest and derive the immutable blob path.
 *
 *  All-or-nothing: if any legacy manifest cannot be fully converted, the
 *  schema version stays at 3 and the result includes the blocking reason.
 *  A v3 state without any legacy fields is a successful no-op migration. */
export function migrateV3ToV4(
	parsed: Record<string, unknown>,
	runDir: string,
): MigrationResult {
	const migrated: Record<string, unknown> = {
		...parsed,
	};

	let allConverted = true;
	let blockReason: MigrationBlockReason | null = null;
	let blockPath: string | undefined;

	// Convert pendingDelegation.manifestPath → manifestArtifact
	if (migrated.pendingDelegation !== undefined) {
		const pd = migrated.pendingDelegation as Record<string, unknown>;
		if (pd.manifestPath !== undefined && pd.manifestArtifact === undefined) {
			const rawPath = String(pd.manifestPath);
			const resolved = resolveManifestPath(runDir, rawPath);
			if (resolved === null) {
				allConverted = false;
				if (blockReason === null) {
					blockReason = "MANIFEST_OUTSIDE_RUN_DIR";
					blockPath = rawPath;
				}
			} else {
				const readResult = tryReadManifestBytesWithReason(resolved);
				if (readResult.kind === "OK") {
					const digest = contentDigest(readResult.bytes);
					const ref = buildArtifactRefFromBytes(
						"delegation-manifest",
						digest,
						readResult.bytes,
					);
					installArtifactBlob(runDir, ref, readResult.bytes);
					pd.manifestArtifact = ref;
					delete pd.manifestPath;
				} else {
					allConverted = false;
					if (blockReason === null) {
						blockReason = readResult.reason;
						blockPath = resolved;
					}
				}
			}
		}
	}

	// Convert pendingExternalRequest.manifestPath + manifestDigest → manifestArtifact
	if (migrated.pendingExternalRequest !== undefined) {
		const per = migrated.pendingExternalRequest as Record<string, unknown>;
		if (per.manifestPath !== undefined && per.manifestArtifact === undefined) {
			const rawPath = String(per.manifestPath);
			const resolved = resolveManifestPath(runDir, rawPath);
			if (resolved === null) {
				allConverted = false;
				if (blockReason === null) {
					blockReason = "MANIFEST_OUTSIDE_RUN_DIR";
					blockPath = rawPath;
				}
			} else {
				const readResult = tryReadManifestBytesWithReason(resolved);
				if (readResult.kind === "OK") {
					const digest = contentDigest(readResult.bytes);
					// Verify the stored digest if present
					if (
						per.manifestDigest !== undefined &&
						String(per.manifestDigest) !== digest
					) {
						allConverted = false;
						if (blockReason === null) {
							blockReason = "MANIFEST_DIGEST_MISMATCH";
							blockPath = resolved;
						}
					} else {
						const ref = buildArtifactRefFromBytes(
							"external-request-manifest",
							digest,
							readResult.bytes,
						);
						installArtifactBlob(runDir, ref, readResult.bytes);
						per.manifestArtifact = ref;
						delete per.manifestPath;
						delete per.manifestDigest;
					}
				} else {
					allConverted = false;
					if (blockReason === null) {
						blockReason = readResult.reason;
						blockPath = resolved;
					}
				}
			}
		}
	}

	// A no-op v3 (no legacy fields at all) is a successful migration.
	if (allConverted) {
		migrated.schemaVersion = STATE_SCHEMA_VERSION;
		return { kind: "MIGRATED", state: migrated };
	}

	return blockPath !== undefined
		? {
				kind: "BLOCKED" as const,
				reason: blockReason ?? "MANIFEST_MISSING",
				path: blockPath,
			}
		: {
				kind: "BLOCKED" as const,
				reason: blockReason ?? "MANIFEST_MISSING",
			};
}

/** Resolve a manifest path that may be absolute (old code used
 *  path.join(runDir, "delegations", ...) which produces absolute paths when
 *  runDir is absolute) or relative.  Returns null if the path cannot be
 *  resolved under the expected RUN_DIR (best-effort migration).
 *
 *  Uses path.resolve + path.relative to close traversal attacks like
 *  `../outside.json` or `/run/expected/../../outside.json`. */
function resolveManifestPath(runDir: string, stored: string): string | null {
	const root = path.resolve(runDir);
	const candidate = path.isAbsolute(stored)
		? path.resolve(stored)
		: path.resolve(root, stored);

	const relative = path.relative(root, candidate);

	if (
		relative === "" ||
		relative.startsWith(`..${path.sep}`) ||
		relative === ".." ||
		path.isAbsolute(relative)
	) {
		return null;
	}

	return candidate;
}

// ---------------------------------------------------------------------------
// Manifest byte reading with reason discrimination
// ---------------------------------------------------------------------------

type ManifestReadResult =
	| { readonly kind: "OK"; readonly bytes: Buffer }
	| { readonly kind: "MISSING"; readonly reason: MigrationBlockReason };

/** Try to read manifest bytes, discriminating between ENOENT, symlinks, and
 *  non-regular files.  Symlinks are rejected for migration safety. */
function tryReadManifestBytesWithReason(filePath: string): ManifestReadResult {
	try {
		const stat = fs.lstatSync(filePath);
		if (stat.isSymbolicLink()) {
			return { kind: "MISSING", reason: "MANIFEST_SYMLINK" };
		}
		if (!stat.isFile()) {
			return { kind: "MISSING", reason: "MANIFEST_NOT_REGULAR" };
		}
		return { kind: "OK", bytes: fs.readFileSync(filePath) };
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") {
			return { kind: "MISSING", reason: "MANIFEST_MISSING" };
		}
		throw err;
	}
}

/** Install artifact bytes as an immutable blob.  Delegates to the
 *  canonical artifact-store primitive.  Idempotent. */
function installArtifactBlob(
	runDir: string,
	ref: ArtifactRef,
	bytes: Uint8Array,
): void {
	installPreparedArtifact(runDir, { ref, bytes });
}

/** Build an ArtifactRef from content bytes without performing I/O.
 *  The relativePath is derived from the digest. */
function buildArtifactRefFromBytes(
	kind: ArtifactRef["kind"],
	digest: string,
	bytes: Uint8Array,
): ArtifactRef {
	const hex = digest.slice(7); // strip "sha256:"
	const prefix = hex.slice(0, 2);
	const rest = hex.slice(2);
	return {
		kind,
		digestAlgorithm: "sha256",
		digest,
		relativePath: `artifacts/sha256/${prefix}/${rest}.json`,
		mediaType: "application/json",
		sizeBytes: bytes.length,
	};
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function readStateSnapshot<S>(
	runDir: string,
	schema?: ZodSchema<S>,
): StateSnapshot<S> {
	const parsed = parseStateFile(runDir);
	if (parsed === null) return { state: null, migratedFromVersion: null };
	if (!("schemaVersion" in parsed)) {
		throw new StateCorruptedError(
			"state.json missing required field: schemaVersion",
		);
	}

	const version = parsed.schemaVersion;
	let current: Record<string, unknown>;
	let migratedFromVersion: StateSnapshot<S>["migratedFromVersion"] = null;

	if (version === LEGACY_STATE_SCHEMA_VERSION) {
		validateCanonicalShape(parsed, LEGACY_STATE_SCHEMA_VERSION);
		current = migrateV2ToV3(parsed);
		// v2→v3→v4 chain migration
		const migrationResult = migrateV3ToV4(current, runDir);
		if (migrationResult.kind === "BLOCKED") {
			throw new StateMigrationBlockedError(
				"v2→v4 migration blocked: legacy manifest cannot be converted",
				{
					reason: migrationResult.reason,
					runId: parsed.runId as string,
					orchestratorName: parsed.orchestratorName as string,
				},
			);
		}
		current = migrationResult.state;
		migratedFromVersion = LEGACY_STATE_SCHEMA_VERSION;
	} else if (version === PREVIOUS_STATE_SCHEMA_VERSION) {
		validateCanonicalShape(parsed, PREVIOUS_STATE_SCHEMA_VERSION);
		const migrationResult = migrateV3ToV4(parsed, runDir);
		if (migrationResult.kind === "BLOCKED") {
			throw new StateMigrationBlockedError(
				"v3→v4 migration blocked: legacy manifest cannot be converted",
				{
					reason: migrationResult.reason,
					runId: parsed.runId as string,
					orchestratorName: parsed.orchestratorName as string,
				},
			);
		}
		current = migrationResult.state;
		migratedFromVersion = PREVIOUS_STATE_SCHEMA_VERSION;
	} else if (version === STATE_SCHEMA_VERSION) {
		current = parsed;
	} else {
		throw new StateVersionMismatchError(
			`state.json schemaVersion mismatch: expected ${STATE_SCHEMA_VERSION}, ${PREVIOUS_STATE_SCHEMA_VERSION}, or ${LEGACY_STATE_SCHEMA_VERSION}, got ${String(version)}`,
		);
	}

	// After migration, current.schemaVersion is always STATE_SCHEMA_VERSION.
	validateCanonicalShape(current, STATE_SCHEMA_VERSION);

	if (schema !== undefined) {
		const result = schema.safeParse(current.data);
		if (!result.success) {
			throw new StateCorruptedError(
				`state.data failed schema validation: ${summarizeZodError(result.error)}`,
				{ cause: result.error },
			);
		}
		current = { ...current, data: result.data };
	}

	return {
		state: current as unknown as StateFile<S>,
		migratedFromVersion,
	};
}

export function readState<S>(
	runDir: string,
	schema?: ZodSchema<S>,
): StateFile<S> | null {
	return readStateSnapshot(runDir, schema).state;
}

export function writeStateAtomic<S>(
	runDir: string,
	state: StateFile<S>,
	schema?: ZodSchema<S>,
): void {
	if (schema !== undefined) {
		const result = schema.safeParse(state.data);
		if (!result.success) {
			throw new StateCorruptedError(
				`cannot write state: data fails schema: ${summarizeZodError(result.error)}`,
				{ cause: result.error },
			);
		}
	}
	if (state.schemaVersion !== STATE_SCHEMA_VERSION) {
		throw new StateCorruptedError(
			`cannot write state: schemaVersion must be ${STATE_SCHEMA_VERSION}, got ${state.schemaVersion}`,
		);
	}
	validateCanonicalShape(
		state as unknown as Record<string, unknown>,
		STATE_SCHEMA_VERSION,
	);

	const json = JSON.stringify(state);
	const statePath = path.join(runDir, "state.json");
	const tmpPath = path.join(runDir, "state.json.tmp");
	fs.writeFileSync(tmpPath, json, { encoding: "utf-8" });
	fs.renameSync(tmpPath, statePath);
}
