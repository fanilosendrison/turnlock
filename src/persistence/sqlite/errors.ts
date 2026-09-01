// SQLite persistence errors — typed wrappers for internal db-layer failures.
// These never propagate to user code; they are either retried internally or
// translated to existing OrchestratorError kinds.
import { OrchestratorError } from "../../errors/base.js";
export class DbConnectionError extends OrchestratorError {
	readonly kind = "state_corrupted";
}
export class DbContentionTimeoutError extends OrchestratorError {
	readonly kind = "state_corrupted";
}
export class DbIntegrityError extends OrchestratorError {
	readonly kind = "state_corrupted";
}
export class DbMigrationError extends OrchestratorError {
	readonly kind = "state_corrupted";
}
