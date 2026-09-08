import * as fs from "node:fs";
import * as path from "node:path";
import { StateCorruptedError } from "../errors/concrete.js";
import { describeStateIoError } from "./state-value-validation.js";

/** Read and parse state.json without applying schema-version semantics. */
export function parseStateFile(runDir: string): Record<string, unknown> | null {
	const statePath = path.join(runDir, "state.json");
	if (!fs.existsSync(statePath)) return null;
	let raw: string;
	try {
		raw = fs.readFileSync(statePath, "utf-8");
	} catch (error) {
		throw new StateCorruptedError(
			`failed to read state.json: ${describeStateIoError(error)}`,
			{ cause: error },
		);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		throw new StateCorruptedError(
			`state.json is not valid JSON: ${describeStateIoError(error)}`,
			{ cause: error },
		);
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new StateCorruptedError("state.json must be a JSON object");
	}
	return parsed as Record<string, unknown>;
}

/** Replace state.json through the established temporary-file rename. */
export function writeStateFileAtomic(
	runDir: string,
	state: Record<string, unknown>,
): void {
	const json = JSON.stringify(state);
	const statePath = path.join(runDir, "state.json");
	const tmpPath = path.join(runDir, "state.json.tmp");
	fs.writeFileSync(tmpPath, json, { encoding: "utf-8" });
	fs.renameSync(tmpPath, statePath);
}
