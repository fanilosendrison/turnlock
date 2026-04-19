import * as fs from "node:fs";
import * as path from "node:path";
import type { ZodSchema } from "zod";
import {
	StateCorruptedError,
	StateVersionMismatchError,
} from "../errors/concrete";
import { summarizeZodError } from "./validator";

export interface PendingDelegationRecord {
	readonly label: string;
	readonly kind: "skill" | "agent" | "agent-batch";
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

export interface StateFile<State> {
	readonly schemaVersion: 1;
	readonly runId: string;
	readonly orchestratorName: string;
	readonly startedAt: string;
	readonly startedAtEpochMs: number;
	readonly lastTransitionAt: string;
	readonly lastTransitionAtEpochMs: number;
	readonly currentPhase: string;
	readonly phasesExecuted: number;
	readonly accumulatedDurationMs: number;
	readonly data: State;
	readonly pendingDelegation?: PendingDelegationRecord;
	readonly usedLabels: readonly string[];
}

function describeError(err: unknown): string {
	if (err instanceof Error) return err.message.slice(0, 200);
	return String(err).slice(0, 200);
}

function validateCanonicalShape(obj: Record<string, unknown>): void {
	const required: Array<[string, (v: unknown) => boolean]> = [
		["runId", (v) => typeof v === "string" && v.length > 0],
		["orchestratorName", (v) => typeof v === "string" && v.length > 0],
		["startedAt", (v) => typeof v === "string"],
		["startedAtEpochMs", (v) => typeof v === "number"],
		["lastTransitionAt", (v) => typeof v === "string"],
		["lastTransitionAtEpochMs", (v) => typeof v === "number"],
		["currentPhase", (v) => typeof v === "string"],
		["phasesExecuted", (v) => typeof v === "number" && v >= 0],
		["accumulatedDurationMs", (v) => typeof v === "number" && v >= 0],
		["data", (v) => v !== undefined],
		[
			"usedLabels",
			(v) => Array.isArray(v) && v.every((x) => typeof x === "string"),
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
	if (obj.pendingDelegation !== undefined && obj.pendingDelegation !== null) {
		const pd = obj.pendingDelegation as Record<string, unknown>;
		if (!["skill", "agent", "agent-batch"].includes(pd.kind as string)) {
			throw new StateCorruptedError(
				`pendingDelegation.kind invalid: ${String(pd.kind)}`,
			);
		}
	}
}

export function readState<S>(
	runDir: string,
	schema?: ZodSchema<S>,
): StateFile<S> | null {
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

	if (typeof parsed !== "object" || parsed === null) {
		throw new StateCorruptedError("state.json must be a JSON object");
	}
	if (!("schemaVersion" in parsed)) {
		throw new StateCorruptedError(
			"state.json missing required field: schemaVersion",
		);
	}
	const sv = (parsed as { schemaVersion: unknown }).schemaVersion;
	if (sv !== 1) {
		throw new StateVersionMismatchError(
			`state.json schemaVersion mismatch: expected 1, got ${String(sv)}`,
		);
	}

	validateCanonicalShape(parsed as Record<string, unknown>);

	if (schema !== undefined) {
		const parsedObj = parsed as unknown as { data: unknown };
		const result = schema.safeParse(parsedObj.data);
		if (!result.success) {
			throw new StateCorruptedError(
				`state.data failed schema validation: ${summarizeZodError(result.error)}`,
				{ cause: result.error },
			);
		}
		parsedObj.data = result.data;
	}

	return parsed as StateFile<S>;
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
	if (state.schemaVersion !== 1) {
		throw new StateCorruptedError(
			`cannot write state: schemaVersion must be 1, got ${state.schemaVersion}`,
		);
	}

	const json = JSON.stringify(state);
	const statePath = path.join(runDir, "state.json");
	const tmpPath = path.join(runDir, "state.json.tmp");
	fs.writeFileSync(tmpPath, json, { encoding: "utf-8" });
	fs.renameSync(tmpPath, statePath);
}
