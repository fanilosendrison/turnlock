import * as fs from "node:fs";
import type { SqliteDriver } from "../persistence/sqlite/sqlite-driver.js";
import {
	sweepReadyRetirementMarkers,
	sweepUnreadyRetiredPayloads,
} from "./retirement-journal.js";

/** Delete a retirement-specific directory after destructive authorization. */
export function deleteRetiredRunDirectory(
	retiredPath: string,
): { readonly kind: "DELETED" } | { readonly kind: "FAILED" } {
	try {
		fs.rmSync(retiredPath, { recursive: true, force: true });
		return { kind: "DELETED" };
	} catch {
		return { kind: "FAILED" };
	}
}

/** Sweep READY markers first, then validate and recover UNREADY payloads. */
export function sweepRetiredRunDirectories(params: {
	readonly driver: SqliteDriver;
	readonly retiredRoot: string;
	readonly orchestratorName?: string;
}): number {
	const { driver, retiredRoot } = params;
	if (!fs.existsSync(retiredRoot)) return 0;
	let completed = 0;
	completed += sweepReadyRetirementMarkers({
		retiredRoot,
		orchestratorName: params.orchestratorName ?? null,
	});
	completed += sweepUnreadyRetiredPayloads({
		driver,
		retiredRoot,
		...(params.orchestratorName !== undefined
			? { expectedOrchestratorName: params.orchestratorName }
			: {}),
	});
	return completed;
}
