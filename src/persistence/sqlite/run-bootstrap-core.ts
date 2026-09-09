// Compatibility facade for the atomic bootstrap implementation.

export type { LockHandle } from "./ownership.js";
export {
	type BootstrapFaultPoint,
	type BootstrapInternalDependencies,
	type BootstrapNewRunParams,
	type BootstrapNewRunResult,
	type CommittedState,
	InjectedBootstrapFailure,
	type MigrateLegacyRunParams,
	type MigrateLegacyRunResult,
	productionDependencies,
	type RunBootstrapDependencies,
} from "./run-bootstrap-contracts.js";
export {
	computeDigest,
	type EstablishResult,
	establishRunInTransaction,
	isBusy,
	type PartialRecoveryPolicy,
} from "./run-bootstrap-establishment.js";
export { migrateLegacyRunAtomicCore } from "./run-bootstrap-legacy-migration.js";
export { bootstrapNewRunAtomicCore } from "./run-bootstrap-new-run.js";
