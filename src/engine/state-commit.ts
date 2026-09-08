// Stable engine-level facade for authoritative state commits, ownership
// lifecycle operations, and fenced canonical artifact projection.
export type { LockHandle } from "../persistence/sqlite/ownership.js";
export { projectCanonicalArtifactFenced } from "./canonical-artifact-projection.js";
export {
	refreshOwnershipFromContext,
	releaseOwnershipBestEffort,
	releaseOwnershipFromContext,
} from "./ownership-context.js";
export type {
	ExpectedArtifactPlacement,
	OwnershipContextWithLogger,
} from "./state-commit-contracts.js";
export {
	claimInitialDispatchWithProjection,
	commitStateWithProjection,
} from "./state-transition-commit.js";
