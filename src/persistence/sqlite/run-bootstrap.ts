// Public API for atomic run bootstrap and legacy migration.
//
// This module is a thin wrapper over run-bootstrap-core.ts.  It injects the
// production `generateRunId` identity generator and exposes the stable public
// API consumed by run-orchestrator.ts and other production callers.
//
// Tests that need a deterministic identity generator should import
// `bootstrapNewRunAtomicCore` / `migrateLegacyRunAtomicCore` directly from
// run-bootstrap-core.ts and supply their own RunBootstrapDependencies.
import {
	bootstrapNewRunAtomicCore,
	migrateLegacyRunAtomicCore,
	productionDependencies,
} from "./run-bootstrap-core.js";

export type { LockHandle } from "./ownership.js";
// Re-export the public types required by production callers.
export type {
	BootstrapNewRunParams,
	BootstrapNewRunResult,
	CommittedState,
	MigrateLegacyRunParams,
	MigrateLegacyRunResult,
} from "./run-bootstrap-core.js";
// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
/** Bootstrap a brand-new run atomically.
 *
 *  Delegates to {@link bootstrapNewRunAtomicCore} with the production
 *  `generateRunId` identity generator. */
export function bootstrapNewRunAtomic(
	params: import("./run-bootstrap-core.js").BootstrapNewRunParams,
): import("./run-bootstrap-core.js").BootstrapNewRunResult {
	return bootstrapNewRunAtomicCore(params, productionDependencies);
}
/** Migrate a legacy run (state.json, no SQLite DB) into an authoritative
 *  SQLite run atomically.
 *
 *  Delegates to {@link migrateLegacyRunAtomicCore} with the production
 *  `generateRunId` identity generator. */
export function migrateLegacyRunAtomic(
	params: import("./run-bootstrap-core.js").MigrateLegacyRunParams,
): import("./run-bootstrap-core.js").MigrateLegacyRunResult {
	return migrateLegacyRunAtomicCore(params, productionDependencies);
}
