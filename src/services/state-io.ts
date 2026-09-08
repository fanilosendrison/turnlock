import type { ZodSchema } from "zod";
import { STATE_SCHEMA_VERSION } from "../constants.js";
import {
	StateCorruptedError,
	StateMigrationBlockedError,
	StateVersionMismatchError,
} from "../errors/concrete.js";
import { validateCanonicalStateShape } from "./state-canonical-validation.js";
import {
	LEGACY_STATE_SCHEMA_VERSION,
	PREVIOUS_STATE_SCHEMA_VERSION,
	type StateFile,
	type StateSnapshot,
} from "./state-contracts.js";
import { parseStateFile, writeStateFileAtomic } from "./state-file-storage.js";
import { migrateV2ToV3, migrateV3ToV4 } from "./state-migration.js";
import { summarizeZodError } from "./validator.js";

export type {
	MigrationResult,
	PendingDelegationRecord,
	PendingExternalRequestRecord,
	StateFile,
	StateSnapshot,
} from "./state-contracts.js";
export { migrateV3ToV4 } from "./state-migration.js";

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
		validateCanonicalStateShape(parsed, LEGACY_STATE_SCHEMA_VERSION);
		current = migrateV2ToV3(parsed);
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
		validateCanonicalStateShape(parsed, PREVIOUS_STATE_SCHEMA_VERSION);
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
	validateCanonicalStateShape(current, STATE_SCHEMA_VERSION);
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
	validateCanonicalStateShape(
		state as unknown as Record<string, unknown>,
		STATE_SCHEMA_VERSION,
	);
	writeStateFileAtomic(runDir, state as unknown as Record<string, unknown>);
}
