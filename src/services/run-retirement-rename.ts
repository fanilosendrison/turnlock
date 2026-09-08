import * as fs from "node:fs";
import * as path from "node:path";
import { RUN_DB_FILENAME } from "../constants.js";
import type { RunDatabaseFilesystemIdentity } from "../persistence/sqlite/retention-claim.js";
import { inspectRetiredRunAuthority } from "../persistence/sqlite/retired-run-inspection.js";
import {
	ensureDirectoryPathWithoutSymlinks,
	fsyncDirectory,
} from "./durable-fs.js";
import { retiredDirectoryName } from "./retirement-journal.js";
import type {
	RenameRunDirectoryParams,
	RenameRunDirectoryResult,
	RunRetirementInternalDependencies,
} from "./run-retirement-contracts.js";
import {
	RETIRED_DIR_NAME,
	RETIRED_PAYLOAD_DIR_NAME,
	RETIRED_READY_DIR_NAME,
} from "./run-retirement-layout.js";

const productionRetirementDependencies: RunRetirementInternalDependencies = {};

function pathIdentityMatches(
	canonicalRunDir: string,
	databasePath: string,
	expected: RunDatabaseFilesystemIdentity,
): boolean {
	try {
		const directoryStat = fs.lstatSync(canonicalRunDir, { bigint: true });
		const databaseStat = fs.lstatSync(databasePath, { bigint: true });
		if (directoryStat.isSymbolicLink() || databaseStat.isSymbolicLink()) {
			return false;
		}
		return (
			directoryStat.dev.toString() === expected.dirDev &&
			directoryStat.ino.toString() === expected.dirIno &&
			databaseStat.dev.toString() === expected.dbDev &&
			databaseStat.ino.toString() === expected.dbIno
		);
	} catch {
		return false;
	}
}

/** Rename a claimed canonical RUN_DIR into the retirement area.
 *  The caller must hold the per-run namespace mutex for the whole call. */
export function renameRunDirectoryToRetired(
	params: RenameRunDirectoryParams,
): RenameRunDirectoryResult {
	return renameRunDirectoryToRetiredInternal(
		params,
		productionRetirementDependencies,
	);
}

/** Internal rename variant with test-only fault injection. */
export function renameRunDirectoryToRetiredInternal(
	params: RenameRunDirectoryParams,
	dependencies: RunRetirementInternalDependencies,
): RenameRunDirectoryResult {
	const { driver, runDir, runId, retirementToken, incarnationId } = params;
	const databasePath = path.join(runDir, RUN_DB_FILENAME);
	const orchestratorBaseDir = path.dirname(runDir);
	const retiredRoot = path.join(orchestratorBaseDir, RETIRED_DIR_NAME);
	const retiredPayloadDir = path.join(retiredRoot, RETIRED_PAYLOAD_DIR_NAME);
	const retiredPath = path.join(
		retiredPayloadDir,
		retiredDirectoryName(runId, retirementToken),
	);
	if (params.databaseIdentity === null) {
		return { kind: "MISMATCH" };
	}
	if (!fs.existsSync(runDir)) {
		return { kind: "MISMATCH" };
	}
	if (!pathIdentityMatches(runDir, databasePath, params.databaseIdentity)) {
		return { kind: "MISMATCH" };
	}
	const preInspection = inspectRetiredRunAuthority({
		driver,
		dbPath: databasePath,
		expectedRunId: runId,
		...(params.expectedOrchestratorName !== undefined
			? { expectedOrchestratorName: params.expectedOrchestratorName }
			: {}),
		expectedRetirementToken: retirementToken,
		expectedIncarnationId: incarnationId,
	});
	if (preInspection.kind !== "VALID_RETIRING") {
		return { kind: "MISMATCH" };
	}
	ensureDirectoryPathWithoutSymlinks(retiredPayloadDir, orchestratorBaseDir);
	ensureDirectoryPathWithoutSymlinks(
		path.join(retiredRoot, RETIRED_READY_DIR_NAME),
		orchestratorBaseDir,
	);
	if (fs.existsSync(retiredPath)) {
		return { kind: "MISMATCH" };
	}
	dependencies.onFaultPoint?.("AFTER_PRE_RENAME_VERIFICATION");
	fs.renameSync(runDir, retiredPath);
	dependencies.onFaultPoint?.("AFTER_RENAME_BEFORE_POSTCHECK");
	try {
		fsyncDirectory(orchestratorBaseDir);
		fsyncDirectory(retiredPayloadDir);
	} catch {
		return { kind: "DETACHED_UNREADY", retiredPath };
	}
	const postInspection = inspectRetiredRunAuthority({
		driver,
		dbPath: path.join(retiredPath, RUN_DB_FILENAME),
		expectedRunId: runId,
		...(params.expectedOrchestratorName !== undefined
			? { expectedOrchestratorName: params.expectedOrchestratorName }
			: {}),
		expectedRetirementToken: retirementToken,
		expectedIncarnationId: incarnationId,
	});
	if (postInspection.kind !== "VALID_RETIRING") {
		try {
			if (!fs.existsSync(runDir)) {
				fs.renameSync(retiredPath, runDir);
			}
		} catch {
			// The sweep validates the untouched payload before any deletion.
		}
		return { kind: "MISMATCH" };
	}
	return { kind: "RENAMED", retiredPath };
}
