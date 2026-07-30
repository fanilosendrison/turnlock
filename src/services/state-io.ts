import * as fs from "node:fs";
import * as path from "node:path";
import type { ZodSchema } from "zod";
import {
	MAX_EVENT_FIELD_LENGTH,
	MAX_EXTERNAL_LABEL_LENGTH,
	STATE_SCHEMA_VERSION,
} from "../constants";
import {
	StateCorruptedError,
	StateVersionMismatchError,
} from "../errors/concrete";
import { isContentDigest } from "./content-digest";
import { summarizeZodError } from "./validator";

const LEGACY_STATE_SCHEMA_VERSION = 2 as const;

export interface PendingDelegationRecord {
	readonly label: string;
	readonly kind: "prompt" | "batch";
	readonly resumeAt: string;
	readonly manifestPath: string;
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
	readonly manifestPath: string;
	readonly manifestDigest: string;
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
	readonly usedLabels: readonly string[];
}

export interface StateSnapshot<State> {
	readonly state: StateFile<State> | null;
	readonly migratedFromVersion: typeof LEGACY_STATE_SCHEMA_VERSION | null;
}

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

function validatePendingDelegation(value: unknown): void {
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

function validatePendingExternalRequest(
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
	if (acceptedFieldCount !== 0 && acceptedFieldCount !== acceptedFields.length) {
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

function validateCanonicalShape(
	obj: Record<string, unknown>,
	version: 2 | 3,
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
	if (version === 3 && hasDelegation && hasExternal) {
		throw new StateCorruptedError(
			"pendingDelegation and pendingExternalRequest are mutually exclusive",
		);
	}
	if (hasDelegation) validatePendingDelegation(obj.pendingDelegation);
	if (version === 3 && hasExternal) {
		validatePendingExternalRequest(
			obj.pendingExternalRequest,
			obj.runId as string,
			obj.usedLabels as readonly string[],
		);
	}
}

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
		schemaVersion: STATE_SCHEMA_VERSION,
	};
	Reflect.deleteProperty(migrated, "pendingExternalRequest");
	return migrated;
}

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
	let migratedFromVersion: typeof LEGACY_STATE_SCHEMA_VERSION | null = null;
	if (version === LEGACY_STATE_SCHEMA_VERSION) {
		validateCanonicalShape(parsed, LEGACY_STATE_SCHEMA_VERSION);
		current = migrateV2ToV3(parsed);
		migratedFromVersion = LEGACY_STATE_SCHEMA_VERSION;
	} else if (version === STATE_SCHEMA_VERSION) {
		current = parsed;
	} else {
		throw new StateVersionMismatchError(
			`state.json schemaVersion mismatch: expected ${STATE_SCHEMA_VERSION} or ${LEGACY_STATE_SCHEMA_VERSION}, got ${String(version)}`,
		);
	}

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
