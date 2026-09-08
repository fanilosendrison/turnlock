import * as fs from "node:fs";
import * as path from "node:path";
import type { RunDatabaseFilesystemIdentity } from "./retention-claim-contracts.js";

export function captureDatabaseIdentity(
	dbPath: string,
): RunDatabaseFilesystemIdentity | null {
	try {
		const dbStat = fs.lstatSync(dbPath, { bigint: true });
		const dirStat = fs.lstatSync(path.dirname(dbPath), { bigint: true });
		if (dbStat.isSymbolicLink() || dirStat.isSymbolicLink()) return null;
		return {
			dirDev: dirStat.dev.toString(),
			dirIno: dirStat.ino.toString(),
			dbDev: dbStat.dev.toString(),
			dbIno: dbStat.ino.toString(),
		};
	} catch {
		return null;
	}
}

export function databaseIdentitiesEqual(
	left: RunDatabaseFilesystemIdentity,
	right: RunDatabaseFilesystemIdentity,
): boolean {
	return (
		left.dirDev === right.dirDev &&
		left.dirIno === right.dirIno &&
		left.dbDev === right.dbDev &&
		left.dbIno === right.dbIno
	);
}
