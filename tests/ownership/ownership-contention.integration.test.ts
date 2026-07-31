// TL-F-001 — SQLite ownership campaign.
//
// Seeds a SQLite DB with an expired HELD ownership row, then spawns N
// contenders that all race to take over.  With the CAS-based lock, exactly
// one contender must win.

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { bunSqliteDriver } from "../../src/persistence/sqlite/bun-sqlite-driver";
import { openRunDatabase } from "../../src/persistence/sqlite/run-database";
import { cleanupTempDir, makeTempDir } from "../helpers/temp-run-dir";

const CONTENDER_COUNT = 24;

interface ContenderReport {
	id: string;
	outcome: string;
	ownerToken?: string;
	fenceToken?: string;
}

function spawnContender(
	contenderScript: string,
	dbPath: string,
	id: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	return new Promise((resolve) => {
		const proc = Bun.spawn({
			cmd: ["bun", "run", contenderScript],
			env: {
				...process.env,
				TL_DB_PATH: dbPath,
				TL_CONTENDER_ID: id,
			},
			stdout: "pipe",
			stderr: "pipe",
		});

		const stdoutPromise = new Response(proc.stdout).text();
		const stderrPromise = new Response(proc.stderr).text();

		proc.exited.then(async (exitCode) => {
			resolve({
				stdout: await stdoutPromise,
				stderr: await stderrPromise,
				exitCode,
			});
		});
	});
}

describe("TL-F-001 SQLite ownership campaign", () => {
	test("exactly one contender wins the CAS race", async () => {
		const dir = makeTempDir();
		const dbPath = join(dir, "turnlock.sqlite3");

		try {
			// Open the DB to create the schema, then seed an expired HELD row.
			const seedDb = openRunDatabase({
				driver: bunSqliteDriver,
				dbPath,
				busyTimeoutMs: 500,
			});
			seedDb.connection.exec(`
					INSERT OR IGNORE INTO run_incarnation
						(singleton, run_id, incarnation_id, orchestrator_name,
						 created_at_epoch_ms, created_at_iso)
					VALUES (1, 'contention', 'inc-campaign-001', 'contention-test',
					        0, '1970-01-01T00:00:00.000Z');
					INSERT OR IGNORE INTO run_ownership
						(singleton, incarnation_id, ownership_status,
						 owner_token, owner_pid, fence_token,
						 acquired_at_epoch_ms, lease_until_epoch_ms)
					VALUES (1, 'inc-campaign-001', 'HELD',
					        'EXPIRED-OWNER', 99999, 5,
					        0, -1);
				`);
			seedDb.close();

			// Spawn all contenders.
			const contenderScript = join(import.meta.dir, "fixtures", "contender.ts");

			const promises = Array.from({ length: CONTENDER_COUNT }, (_, i) =>
				spawnContender(contenderScript, dbPath, String(i)),
			);

			const results = await Promise.all(promises);

			const reports: ContenderReport[] = [];
			for (const r of results) {
				if (r.exitCode !== 0) {
					console.error("contender stderr:", r.stderr.slice(0, 500));
					continue;
				}
				const line = r.stdout.trim();
				if (line === "") continue;
				try {
					reports.push(JSON.parse(line) as ContenderReport);
				} catch {
					console.error("unparseable contender output:", line.slice(0, 200));
				}
			}

			const acquired = reports.filter((r) => r.outcome === "ACQUIRED");
			const casMisses = reports.filter(
				(r) => r.outcome === "PREDECESSOR_CAS_MISS",
			);
			const conflicts = reports.filter((r) => r.outcome === "ACTIVE_CONFLICT");
			const timeouts = reports.filter(
				(r) => r.outcome === "DB_CONTENTION_TIMEOUT",
			);
			const errors = reports.filter((r) => r.outcome.startsWith("ERROR"));

			console.error(
				`TL-F-001 SQLite: ACQUIRED=${acquired.length} CAS_MISS=${casMisses.length} CONFLICT=${conflicts.length} TIMEOUT=${timeouts.length} ERROR=${errors.length}`,
			);

			expect(reports.length).toBe(CONTENDER_COUNT);
			expect(errors.length).toBe(0);

			// Exactly one winner — the CAS guarantees it.
			expect(acquired.length).toBe(1);
			expect(acquired[0]?.fenceToken).toBe("6"); // predecessor had fence 5

			// All non-winning outcomes must be safe.
			expect(
				acquired.length + casMisses.length + conflicts.length + timeouts.length,
			).toBe(CONTENDER_COUNT);
		} finally {
			cleanupTempDir(dir);
		}
	}, 60_000);
});
