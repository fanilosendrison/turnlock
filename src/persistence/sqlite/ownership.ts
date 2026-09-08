// Compatibility facade for authoritative SQLite ownership.
export {
	acquireOwnership,
	acquireOwnershipDirectInTransaction,
} from "./ownership-acquisition.js";
export {
	ensureIncarnationInTransaction,
	ensureOwnershipRowInTransaction,
} from "./ownership-bootstrap.js";
export type {
	AcquireOwnershipDirectInTransactionResult,
	AcquireParams,
	AcquireResult,
	LiveOwnershipVerification,
	LockHandle,
	OwnershipOperationResult,
	OwnershipPredecessor,
	RefreshParams,
	ReleaseParams,
} from "./ownership-contracts.js";
export { verifyLiveOwnershipInTransaction } from "./ownership-live-verification.js";
export {
	refreshOwnership,
	releaseOwnership,
} from "./ownership-refresh-release.js";
export {
	isLiveLease,
	isOwnershipLive,
	readOwnershipIncarnationId,
	readOwnershipPredecessor,
} from "./ownership-row-observation.js";
export {
	beginImmediate,
	commit,
	isSqliteBusyError,
	rollback,
} from "./ownership-transactions.js";
