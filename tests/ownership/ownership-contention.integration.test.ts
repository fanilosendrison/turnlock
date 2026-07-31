// TL-F-001 — reproduce expired-lock takeover race.
//
// Writes an expired lock file with a deliberately large payload (to widen the
// writeFileSync window during overrideLock), then spawns N contenders that all
// attempt acquireLock().  The current file-based lock uses a shared
// `<lock>.tmp` path + read-then-act for takeover, so multiple contenders can
// win.
//
// Once TL-F-001 is fixed the expected outcome becomes exactly 1 × ACQUIRED.

import { describe, expect, test } from "bun:test";
import { unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "../helpers/temp-run-dir";

const CONTENDER_COUNT = 24;

interface ContenderReport {
	id: string;
	outcome: "ACQUIRED" | "ACTIVE_CONFLICT" | "ERROR";
	ownerToken?: string;
}

function spawnContender(
	contenderScript: string,
	lockPath: string,
	id: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	return new Promise((resolve) => {
		const proc = Bun.spawn({
			cmd: ["bun", "run", contenderScript],
			env: {
				...process.env,
				TL_LOCK_PATH: lockPath,
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

describe("TL-F-001 reproduction", () => {
	test("expired lock takeover is not mutually exclusive (documented race)", async () => {
		const dir = makeTempDir();
		const lockPath = join(dir, ".lock");

		try {
			// Deliberately large predecessor payload to widen the
			// writeFileSync window during overrideLock, as documented
			// in the original finding reproduction.
			const padding = "x".repeat(64 * 1024); // 64 KiB
			writeFileSync(
				lockPath,
				JSON.stringify({
					ownerPid: 99999,
					ownerToken: "PREDECESSOR-TOKEN",
					acquiredAtEpochMs: 0,
					leaseUntilEpochMs: -1,
					padding,
				}),
			);

			const contenderScript = join(import.meta.dir, "fixtures", "contender.ts");

			// Spawn all contenders as close together as possible.
			const promises = Array.from({ length: CONTENDER_COUNT }, (_, i) =>
				spawnContender(contenderScript, lockPath, String(i)),
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
			const conflicts = reports.filter((r) => r.outcome === "ACTIVE_CONFLICT");
			const errors = reports.filter((r) => r.outcome === "ERROR");

			console.error(
				`TL-F-001 results: ACQUIRED=${acquired.length} CONFLICT=${conflicts.length} ERROR=${errors.length}`,
			);

			expect(reports.length).toBe(CONTENDER_COUNT);
			expect(errors.length).toBe(0);

			// Minimum guarantee — at least one contender must acquire.
			expect(acquired.length).toBeGreaterThanOrEqual(1);

			// Document whether the race manifests.  When TL-F-001 is
			// fixed this becomes `expect(acquired.length).toBe(1)`.
			if (acquired.length >= 2) {
				console.error(
					`⚠ TL-F-001 CONFIRMED: ${acquired.length} winners for the same lock`,
				);
			} else {
				console.error(
					"ℹ TL-F-001 race window closed on this run (1 winner); re-run may trigger",
				);
			}
		} finally {
			try {
				unlinkSync(lockPath);
			} catch {
				/* */
			}
			cleanupTempDir(dir);
		}
	}, 60_000);
});
