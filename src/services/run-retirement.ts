// Stable facade for the SQLite-backed RUN_DIR retirement protocol.
export type {
	RenameRunDirectoryResult,
	RunRetirementFaultPoint,
	RunRetirementInternalDependencies,
	RunRetirementOutcome,
} from "./run-retirement-contracts.js";
export {
	buildRunRetirement,
	retireRunDirectory,
	retireRunDirectoryInternal,
} from "./run-retirement-flow.js";
export {
	RETIRED_DIR_NAME,
	RETIRED_PAYLOAD_DIR_NAME,
	RETIRED_READY_DIR_NAME,
	RETIREMENT_READY_MARKER_VERSION,
	retiredDirectoryName,
} from "./run-retirement-layout.js";
export {
	renameRunDirectoryToRetired,
	renameRunDirectoryToRetiredInternal,
} from "./run-retirement-rename.js";
export {
	deleteRetiredRunDirectory,
	sweepRetiredRunDirectories,
} from "./run-retirement-sweep.js";
