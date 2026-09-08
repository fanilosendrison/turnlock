import type { OrchestratorConfig } from "../types/config.js";
import { isTestExitSignal } from "./context.js";
import { handleTopLevelError } from "./error-emitter.js";
import { type ParsedArgv, parseArgv, validateConfig } from "./preflight.js";
import {
	productionRunOrchestratorDependencies,
	type RunOrchestratorInternalDependencies,
} from "./run-orchestrator-contracts.js";
import { runInitialMode } from "./run-orchestrator-initial-mode.js";
import { runResumeMode } from "./run-orchestrator-resume-mode.js";

export type {
	RunOrchestratorInternalDependencies,
	RunOrchestratorInternalHooks,
} from "./run-orchestrator-contracts.js";

export async function runOrchestratorInternal<S extends object>(
	config: OrchestratorConfig<S>,
	argv: ParsedArgv,
	dependencies: RunOrchestratorInternalDependencies,
): Promise<void> {
	validateConfig(config);
	if (argv.resume) {
		await runResumeMode(config, argv, dependencies);
	} else {
		await runInitialMode(config, argv, dependencies);
	}
}

export async function runOrchestrator<S extends object>(
	config: OrchestratorConfig<S>,
): Promise<void> {
	try {
		const argv = parseArgv(process.argv.slice(2));
		await runOrchestratorInternal(
			config,
			argv,
			productionRunOrchestratorDependencies,
		);
	} catch (error) {
		if (isTestExitSignal(error)) return;
		try {
			handleTopLevelError(error, config);
		} catch (nestedError) {
			if (isTestExitSignal(nestedError)) return;
		}
	}
}
