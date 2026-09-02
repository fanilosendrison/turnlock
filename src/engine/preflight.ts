import { InvalidConfigError } from "../errors/concrete.js";
import { isValidRunId } from "../services/run-id.js";
import type { OrchestratorConfig } from "../types/config.js";
export interface ParsedArgv {
	readonly resume: boolean;
	readonly runId?: string;
	readonly rest: readonly string[];
}
export function parseArgv(args: readonly string[]): ParsedArgv {
	let resume = false;
	let runId: string | undefined;
	const rest: string[] = [];
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--resume") {
			resume = true;
			continue;
		}
		if (args[i] === "--run-id") {
			runId = args[i + 1];
			i++;
			continue;
		}
		const arg = args[i];
		if (arg !== undefined) rest.push(arg);
	}
	if (runId !== undefined) {
		return { resume, runId, rest };
	}
	return { resume, rest };
}
export function validateConfig<S extends object>(
	config: OrchestratorConfig<S>,
): void {
	const nameRegex = /^[a-z][a-z0-9-]*$/;
	if (config === null || typeof config !== "object") {
		throw new InvalidConfigError("config must be an object");
	}
	if (typeof config.name !== "string" || !nameRegex.test(config.name)) {
		throw new InvalidConfigError(
			`config.name invalid (kebab-case required): ${String(config.name)}`,
		);
	}
	if (typeof config.phases !== "object" || config.phases === null) {
		throw new InvalidConfigError("config.phases must be an object");
	}
	const phaseKeys = Object.keys(config.phases);
	if (phaseKeys.length === 0) {
		throw new InvalidConfigError("config.phases cannot be empty");
	}
	for (const key of phaseKeys) {
		if (!nameRegex.test(key)) {
			throw new InvalidConfigError(
				`phase name invalid (kebab-case required): ${key}`,
			);
		}
		if (typeof config.phases[key] !== "function") {
			throw new InvalidConfigError(`phase "${key}" must be a function`);
		}
	}
	if (
		typeof config.initial !== "string" ||
		!(config.initial in config.phases)
	) {
		throw new InvalidConfigError(
			`config.initial "${config.initial}" not in phases`,
		);
	}
	if (config.initialState === undefined) {
		throw new InvalidConfigError("config.initialState is required");
	}
	if (typeof config.resumeCommand !== "function") {
		throw new InvalidConfigError(
			"config.resumeCommand is required (must be a function)",
		);
	}
	// retentionDays drives a destructive cleanup: a non-finite, negative,
	// or fractional value would move the retention threshold into the future
	// (or to NaN) and make nearly every RUN_DIR eligible for deletion.
	// Reject it during preflight, before any cleanup effect is possible.
	if (config.retentionDays !== undefined) {
		const retentionDays = config.retentionDays;
		if (
			!Number.isFinite(retentionDays) ||
			!Number.isInteger(retentionDays) ||
			retentionDays < 0
		) {
			throw new InvalidConfigError(
				`config.retentionDays must be a finite non-negative integer (got ${String(retentionDays)})`,
			);
		}
	}
}
export function validateExternalRunId(
	runId: string,
	orchestratorName: string,
): void {
	if (!isValidRunId(runId)) {
		throw new InvalidConfigError("--run-id must be a ULID", {
			orchestratorName,
		});
	}
}
