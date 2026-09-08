import type { ProjectionInternalDependencies } from "../persistence/sqlite/run-state-store.js";

export interface RunOrchestratorInternalHooks {
	afterBootstrapResult?(): void;
	/** Test-only: fires while the namespace mutex is held immediately before
	 *  the atomic bootstrap COMMIT. Never part of the package public API. */
	beforeRunBootstrapCommit?(): void;
	beforeInitialProjection?(): void;
	afterInitialProjection?(): void;
	beforeInitialDispatchClaim?(): void;
	afterInitialDispatchClaim?(): void;
}

export interface RunOrchestratorInternalDependencies {
	readonly hooks?: RunOrchestratorInternalHooks;
	readonly projectionDependencies?: ProjectionInternalDependencies;
}

export const productionRunOrchestratorDependencies: RunOrchestratorInternalDependencies =
	{};
