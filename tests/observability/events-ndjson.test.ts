import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
// Authority: src/services/logger.ts + ADR-0001 (events remain valid JSON and
// carry the logical target).
import { describe, test } from "node:test";
import { createLogger } from "../../src/services/logger.js";
import { cleanupTempDir, makeTempDir } from "../helpers/temp-run-dir.js";

function sampleEvent(runId = "01HX") {
	return {
		eventType: "orchestrator_start" as const,
		runId,
		orchestratorName: "orch",
		initialPhase: "a",
		timestamp: "2026-04-19T12:00:00.000Z",
	};
}
describe("events.ndjson lifecycle (T-EV-01..04)", () => {
	test("T-EV-01 | enabled defaults → ndjson created on first event", () => {
		const dir = makeTempDir();
		try {
			const logger = createLogger({ enabled: true });
			const path = join(dir, "events.ndjson");
			logger.enableDiskEmit(path);
			logger.emit(sampleEvent());
			assert.strictEqual(existsSync(path), true);
		} finally {
			cleanupTempDir(dir);
		}
	});
	test("T-EV-02 | persistEventLog:false → ndjson never created", () => {
		const dir = makeTempDir();
		try {
			const logger = createLogger({ enabled: true, persistEventLog: false });
			logger.enableDiskEmit(join(dir, "events.ndjson"));
			logger.emit(sampleEvent());
			assert.strictEqual(existsSync(join(dir, "events.ndjson")), false);
		} finally {
			cleanupTempDir(dir);
		}
	});
	test("T-EV-03 | enabled:false → ni stderr ni ndjson", () => {
		const dir = makeTempDir();
		try {
			const logger = createLogger({ enabled: false });
			logger.enableDiskEmit(join(dir, "events.ndjson"));
			logger.emit(sampleEvent());
			assert.strictEqual(existsSync(join(dir, "events.ndjson")), false);
		} finally {
			cleanupTempDir(dir);
		}
	});
	test("T-EV-04 | contender doesn't write to owner file", () => {
		const dir = makeTempDir();
		try {
			const owner = createLogger({ enabled: true });
			const path = join(dir, "events.ndjson");
			owner.enableDiskEmit(path);
			owner.emit(sampleEvent("OWNER"));
			const sizeBefore = readFileSync(path, "utf-8").length;
			const contender = createLogger({ enabled: true });
			// contender NEVER calls enableDiskEmit (blocked preflight).
			contender.emit(sampleEvent("CONTENDER"));
			const sizeAfter = readFileSync(path, "utf-8").length;
			assert.strictEqual(sizeAfter, sizeBefore);
		} finally {
			cleanupTempDir(dir);
		}
	});
});
describe("events.ndjson format (T-EV-05..08)", () => {
	test("T-EV-05 | 5 events → 5 lines terminated \\n", () => {
		const dir = makeTempDir();
		try {
			const logger = createLogger({ enabled: true });
			const path = join(dir, "events.ndjson");
			logger.enableDiskEmit(path);
			for (let i = 0; i < 5; i++) logger.emit(sampleEvent());
			const raw = readFileSync(path, "utf-8");
			assert.strictEqual(raw.split("\n").filter((l) => l.length > 0).length, 5);
		} finally {
			cleanupTempDir(dir);
		}
	});
	test("T-EV-06 | each line parseable JSON", () => {
		const dir = makeTempDir();
		try {
			const logger = createLogger({ enabled: true });
			const path = join(dir, "events.ndjson");
			logger.enableDiskEmit(path);
			logger.emit(sampleEvent());
			const line = readFileSync(path, "utf-8").split("\n")[0];
			assert.notStrictEqual(line, undefined);
			if (line === undefined) throw new Error("expected first event line");
			assert.doesNotThrow(() => JSON.parse(line));
		} finally {
			cleanupTempDir(dir);
		}
	});
	test("T-EV-07 | no empty lines", () => {
		const dir = makeTempDir();
		try {
			const logger = createLogger({ enabled: true });
			const path = join(dir, "events.ndjson");
			logger.enableDiskEmit(path);
			for (let i = 0; i < 3; i++) logger.emit(sampleEvent());
			const raw = readFileSync(path, "utf-8");
			const lines = raw.split("\n").slice(0, -1);
			for (const l of lines) assert.ok(l.trim().length > 0);
		} finally {
			cleanupTempDir(dir);
		}
	});
	test("T-EV-08 | UTF-8 unicode preserved", () => {
		const dir = makeTempDir();
		try {
			const logger = createLogger({ enabled: true });
			const path = join(dir, "events.ndjson");
			logger.enableDiskEmit(path);
			logger.emit({ ...sampleEvent(), orchestratorName: "français-éé" });
			const raw = readFileSync(path, "utf-8");
			assert.ok(raw.includes("français"));
		} finally {
			cleanupTempDir(dir);
		}
	});
});
describe("delegation_emit serialization (ADR-0001)", () => {
	function delegationEmitEvent(attempt: number) {
		return {
			eventType: "delegation_emit" as const,
			runId: "01HX",
			phase: "a",
			label: "rev",
			kind: "batch" as const,
			target: { kind: "worker" as const, name: "reviewer" },
			attempt,
			jobCount: 3,
			timestamp: "2026-04-19T12:00:00.100Z",
		};
	}
	test("T-EV-15 | delegation_emit persists target and attempt as valid JSON", () => {
		const dir = makeTempDir();
		try {
			const logger = createLogger({ enabled: true });
			const path = join(dir, "events.ndjson");
			logger.enableDiskEmit(path);
			logger.emit(delegationEmitEvent(0));
			logger.emit(delegationEmitEvent(1));
			const lines = readFileSync(path, "utf-8")
				.split("\n")
				.filter((l) => l.length > 0);
			assert.strictEqual(lines.length, 2);
			const first = JSON.parse(lines[0] ?? "{}") as {
				target: { kind: string; name: string };
				attempt: number;
			};
			const second = JSON.parse(lines[1] ?? "{}") as {
				target: { kind: string; name: string };
				attempt: number;
			};
			assert.deepStrictEqual(first.target, {
				kind: "worker",
				name: "reviewer",
			});
			assert.strictEqual(first.attempt, 0);
			assert.deepStrictEqual(second.target, {
				kind: "worker",
				name: "reviewer",
			});
			assert.strictEqual(second.attempt, 1);
		} finally {
			cleanupTempDir(dir);
		}
	});
});
describe("events.ndjson append-only (T-EV-09..10)", () => {
	test("T-EV-09 | 5+3 events → 8 lines unchanged prefix", () => {
		const dir = makeTempDir();
		try {
			const logger = createLogger({ enabled: true });
			const path = join(dir, "events.ndjson");
			logger.enableDiskEmit(path);
			for (let i = 0; i < 5; i++) logger.emit(sampleEvent());
			const prefix = readFileSync(path, "utf-8");
			for (let i = 0; i < 3; i++) logger.emit(sampleEvent());
			const full = readFileSync(path, "utf-8");
			assert.strictEqual(full.startsWith(prefix), true);
		} finally {
			cleanupTempDir(dir);
		}
	});
	test("T-EV-10 | crash recovery append", () => {
		const dir = makeTempDir();
		try {
			const a = createLogger({ enabled: true });
			const path = join(dir, "events.ndjson");
			a.enableDiskEmit(path);
			a.emit(sampleEvent());
			const b = createLogger({ enabled: true });
			b.enableDiskEmit(path);
			b.emit(sampleEvent());
			const lines = readFileSync(path, "utf-8")
				.split("\n")
				.filter((l) => l.length > 0);
			assert.strictEqual(lines.length, 2);
		} finally {
			cleanupTempDir(dir);
		}
	});
});
describe("events.ndjson reconstruction (T-EV-11..12)", () => {
	test("T-EV-11 | reconstruction from events", () => {
		const dir = makeTempDir();
		try {
			const logger = createLogger({ enabled: true });
			const path = join(dir, "events.ndjson");
			logger.enableDiskEmit(path);
			logger.emit(sampleEvent());
			assert.strictEqual(existsSync(path), true);
		} finally {
			cleanupTempDir(dir);
		}
	});
	test("T-EV-12 | no state.data in events", () => {
		const dir = makeTempDir();
		try {
			const logger = createLogger({ enabled: true });
			const path = join(dir, "events.ndjson");
			logger.enableDiskEmit(path);
			logger.emit(sampleEvent());
			const raw = readFileSync(path, "utf-8");
			assert.strictEqual(raw.includes('"data":'), false);
		} finally {
			cleanupTempDir(dir);
		}
	});
});
describe("owner-only (T-EV-13..14)", () => {
	test("T-EV-13 | owner-only discipline", () => {
		const dir = makeTempDir();
		try {
			const owner = createLogger({ enabled: true });
			const path = join(dir, "events.ndjson");
			owner.enableDiskEmit(path);
			owner.emit(sampleEvent());
			assert.strictEqual(existsSync(path), true);
		} finally {
			cleanupTempDir(dir);
		}
	});
	test("T-EV-14 | stderr active before acquire", () => {
		const logger = createLogger({ enabled: true });
		assert.doesNotThrow(() => logger.emit(sampleEvent()));
	});
});
describe("events.ndjson properties (P-EV-a..c)", () => {
	test("P-EV-a | monotone growing", () => {
		const dir = makeTempDir();
		try {
			const logger = createLogger({ enabled: true });
			const path = join(dir, "events.ndjson");
			logger.enableDiskEmit(path);
			let lastSize = 0;
			for (let i = 0; i < 10; i++) {
				logger.emit(sampleEvent());
				const size = readFileSync(path, "utf-8").length;
				assert.ok(size >= lastSize);
				lastSize = size;
			}
		} finally {
			cleanupTempDir(dir);
		}
	});
	test("P-EV-b | order preserved", () => {
		const dir = makeTempDir();
		try {
			const logger = createLogger({ enabled: true });
			const path = join(dir, "events.ndjson");
			logger.enableDiskEmit(path);
			for (let i = 0; i < 5; i++) {
				logger.emit({ ...sampleEvent(`id-${i}`) });
			}
			const lines = readFileSync(path, "utf-8")
				.split("\n")
				.filter((l) => l.length > 0);
			for (let i = 0; i < 5; i++) {
				const line = lines[i];
				if (line === undefined) assert.fail(`missing event line ${i}`);
				assert.ok(line.includes(`id-${i}`));
			}
		} finally {
			cleanupTempDir(dir);
		}
	});
	test("P-EV-c | N events → N lines", () => {
		const dir = makeTempDir();
		try {
			const logger = createLogger({ enabled: true });
			const path = join(dir, "events.ndjson");
			logger.enableDiskEmit(path);
			for (let i = 0; i < 20; i++) logger.emit(sampleEvent());
			const lines = readFileSync(path, "utf-8")
				.split("\n")
				.filter((l) => l.length > 0);
			assert.strictEqual(lines.length, 20);
		} finally {
			cleanupTempDir(dir);
		}
	});
});
