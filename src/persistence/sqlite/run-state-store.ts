// Compatibility facade for the authoritative SQLite state store.
export { commitState } from "./run-state-commit.js";
export type {
	ClaimInitialDispatchParams,
	ClaimInitialDispatchResult,
	CommitStateParams,
	CommitStateResult,
	CommittedState,
	InitializeStateParams,
	InitializeStateResult,
	ProjectionFaultPoint,
	ProjectionInternalDependencies,
	ReadStateResult,
	StateAuthorityMetadata,
	StateRecord,
} from "./run-state-contracts.js";
export { claimInitialDispatchUnderFence } from "./run-state-initial-dispatch.js";
export { initializeStateUnderFence } from "./run-state-initialize.js";
export { projectAuthoritativeStateFenced } from "./run-state-projection.js";
export { readAuthoritativeState } from "./run-state-read.js";
