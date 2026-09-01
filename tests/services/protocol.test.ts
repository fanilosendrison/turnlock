import assert from "node:assert/strict";
// NIB-T §4 — protocol writer/parser (T-PR-01..26, P-PR-a..d)
import { describe, test } from "node:test";
import {
	parseProtocolBlock,
	writeProtocolBlock,
} from "../../src/services/protocol.js";
import { loadFixture } from "../helpers/fixture-loader.js";

const RID = "01HX0000000000000000000001";
const RCMD = "bun run ./main.ts --run-id 01HX0000000000000000000001 --resume";
describe("writeProtocolBlock DELEGATE (T-PR-01..03)", () => {
	test("T-PR-01 | prompt", () => {
		const out = writeProtocolBlock("DELEGATE", {
			runId: RID,
			orchestrator: "senior-review",
			manifest: "/abs/path.json",
			kind: "prompt",
			resumeCmd: RCMD,
		});
		assert.ok(out.includes("@@TURNLOCK@@"));
		assert.ok(out.includes("@@END@@"));
		assert.ok(out.includes("action: DELEGATE"));
		assert.ok(out.includes("kind: prompt"));
		assert.ok(out.includes("manifest: /abs/path.json"));
	});
	test("T-PR-02 | batch", () => {
		const out = writeProtocolBlock("DELEGATE", {
			runId: RID,
			orchestrator: "x",
			manifest: "/a.json",
			kind: "batch",
			resumeCmd: RCMD,
		});
		assert.ok(out.includes("kind: batch"));
	});
	test("T-PR-03 | prompt with alternate orchestrator", () => {
		const out = writeProtocolBlock("DELEGATE", {
			runId: RID,
			orchestrator: "x",
			manifest: "/a.json",
			kind: "prompt",
			resumeCmd: RCMD,
		});
		assert.ok(out.includes("kind: prompt"));
	});
});
describe("writeProtocolBlock REQUEST_EXTERNAL", () => {
	test("writes every stable external request field", () => {
		const out = writeProtocolBlock("REQUEST_EXTERNAL", {
			runId: RID,
			orchestrator: "x",
			requestId: `${RID}/push-repo`,
			requestType: "git.push",
			manifest: "/run/external-requests/push-repo.json",
			result: "/run/external-results/push-repo.json",
			resumeCmd: RCMD,
		});
		assert.ok(out.includes("action: REQUEST_EXTERNAL"));
		assert.ok(out.includes(`request_id: ${RID}/push-repo`));
		assert.ok(out.includes("request_type: git.push"));
		assert.ok(out.includes("manifest: /run/external-requests/push-repo.json"));
		assert.ok(out.includes("result: /run/external-results/push-repo.json"));
	});
});
describe("writeProtocolBlock DONE (T-PR-04..05)", () => {
	test("T-PR-04 | done full fields", () => {
		const out = writeProtocolBlock("DONE", {
			runId: RID,
			orchestrator: "x",
			output: "/abs/output.json",
			success: true,
			phasesExecuted: 5,
			durationMs: 12345,
		});
		assert.ok(out.includes("action: DONE"));
		assert.ok(out.includes("success: true"));
		assert.ok(out.includes("phases_executed: 5"));
		assert.ok(out.includes("duration_ms: 12345"));
	});
	test("T-PR-05 | phases_executed: 0 not omitted", () => {
		const out = writeProtocolBlock("DONE", {
			runId: RID,
			orchestrator: "x",
			output: "/o.json",
			success: true,
			phasesExecuted: 0,
			durationMs: 0,
		});
		assert.ok(out.includes("phases_executed: 0"));
	});
});
describe("writeProtocolBlock ERROR (T-PR-06..10)", () => {
	test("T-PR-06 | error with phase", () => {
		const out = writeProtocolBlock("ERROR", {
			runId: RID,
			orchestrator: "x",
			errorKind: "delegation_schema",
			message: "Validation failed",
			phase: "consolidate",
			phasesExecuted: 4,
		});
		assert.ok(out.includes("action: ERROR"));
		assert.ok(out.includes("error_kind: delegation_schema"));
		assert.ok(out.includes("phase: consolidate"));
		assert.ok(out.includes("phases_executed: 4"));
	});
	test("T-PR-07 | preflight error runId/phase null", () => {
		const out = writeProtocolBlock("ERROR", {
			runId: null,
			orchestrator: "senior-review",
			errorKind: "invalid_config",
			message: "OrchestratorConfig.resumeCommand is required",
			phase: null,
			phasesExecuted: 0,
		});
		assert.ok(out.includes("run_id: null"));
		assert.ok(out.includes("phase: null"));
		assert.ok(out.includes("error_kind: invalid_config"));
	});
	test("T-PR-08 | run_locked with path-like message", () => {
		const out = writeProtocolBlock("ERROR", {
			runId: RID,
			orchestrator: "x",
			errorKind: "run_locked",
			message: "Run locked by PID 12345 at /tmp/run/.lock",
			phase: null,
			phasesExecuted: 0,
		});
		assert.ok(out.includes("error_kind: run_locked"));
	});
	test(`T-PR-09 | message containing " escaped`, () => {
		const out = writeProtocolBlock("ERROR", {
			runId: RID,
			orchestrator: "x",
			errorKind: "protocol",
			message: 'escape "inside"',
			phase: null,
			phasesExecuted: 0,
		});
		assert.ok(out.includes('\\"'));
	});
	test(`T-PR-10 | message containing \\n escaped`, () => {
		const out = writeProtocolBlock("ERROR", {
			runId: RID,
			orchestrator: "x",
			errorKind: "protocol",
			message: "line1\nline2",
			phase: null,
			phasesExecuted: 0,
		});
		assert.ok(out.includes("\\n"));
	});
});
describe("writeProtocolBlock ABORTED (T-PR-11..12)", () => {
	test("T-PR-11 | SIGINT with phase", () => {
		const out = writeProtocolBlock("ABORTED", {
			runId: RID,
			orchestrator: "x",
			signal: "SIGINT",
			phase: "dispatch-reviews",
		});
		assert.ok(out.includes("action: ABORTED"));
		assert.ok(out.includes("signal: SIGINT"));
		assert.ok(out.includes("phase: dispatch-reviews"));
	});
	test("T-PR-12 | SIGTERM phase null", () => {
		const out = writeProtocolBlock("ABORTED", {
			runId: RID,
			orchestrator: "x",
			signal: "SIGTERM",
			phase: null,
		});
		assert.ok(out.includes("signal: SIGTERM"));
		assert.ok(out.includes("phase: null"));
	});
});
describe("parseProtocolBlock happy (T-PR-13..19)", () => {
	test("T-PR-13 | DELEGATE full", () => {
		const parsed = parseProtocolBlock(
			loadFixture("protocol/delegate-prompt.txt"),
		);
		assert.notStrictEqual(parsed, null);
		assert.strictEqual(parsed?.action, "DELEGATE");
		assert.strictEqual(parsed?.fields.kind, "prompt");
	});
	test("parses REQUEST_EXTERNAL fields", () => {
		const parsed = parseProtocolBlock(
			loadFixture("protocol/request-external.txt"),
		);
		assert.strictEqual(parsed?.action, "REQUEST_EXTERNAL");
		assert.strictEqual(parsed?.fields.requestId, `${RID}/push-repo`);
		assert.strictEqual(parsed?.fields.requestType, "git.push");
		assert.strictEqual(
			parsed?.fields.result,
			"/tmp/external-results/push-repo.json",
		);
	});
	test("T-PR-14 | DONE full", () => {
		const parsed = parseProtocolBlock(loadFixture("protocol/done-minimal.txt"));
		assert.strictEqual(parsed?.action, "DONE");
		assert.strictEqual(parsed?.fields.success, true);
		assert.strictEqual(parsed?.fields.phasesExecuted, 3);
		assert.strictEqual(parsed?.fields.durationMs, 1234);
	});
	test("T-PR-15 | ERROR preflight runId=null", () => {
		const parsed = parseProtocolBlock(
			loadFixture("protocol/error-preflight.txt"),
		);
		assert.strictEqual(parsed?.runId, null);
	});
	test("T-PR-16 | ERROR phase=null", () => {
		const parsed = parseProtocolBlock(
			loadFixture("protocol/error-preflight.txt"),
		);
		assert.strictEqual(parsed?.fields.phase, null);
	});
	test("T-PR-17 | ABORTED", () => {
		const parsed = parseProtocolBlock(
			loadFixture("protocol/aborted-sigint.txt"),
		);
		assert.strictEqual(parsed?.action, "ABORTED");
		assert.strictEqual(parsed?.fields.signal, "SIGINT");
	});
	test("T-PR-18 | success string → boolean", () => {
		const parsed = parseProtocolBlock(loadFixture("protocol/done-minimal.txt"));
		assert.strictEqual(parsed?.fields.success, true);
		assert.strictEqual(typeof parsed?.fields.success, "boolean");
	});
	test("T-PR-19 | phases_executed → number", () => {
		const parsed = parseProtocolBlock(loadFixture("protocol/done-minimal.txt"));
		assert.strictEqual(typeof parsed?.fields.phasesExecuted, "number");
	});
});
describe("parseProtocolBlock rejects (T-PR-20..24)", () => {
	test("T-PR-20 | no block → null", () => {
		assert.strictEqual(parseProtocolBlock("plain text\nno markers"), null);
	});
	test("T-PR-21 | no @@END@@ → null", () => {
		assert.strictEqual(
			parseProtocolBlock(loadFixture("protocol/malformed-missing-end.txt")),
			null,
		);
	});
	test("T-PR-22 | missing @@TURNLOCK@@ → null", () => {
		assert.strictEqual(
			parseProtocolBlock("version: 3\nrun_id: X\n@@END@@"),
			null,
		);
	});
	test("T-PR-23 | version incompatible → null", () => {
		const s =
			"\n@@TURNLOCK@@\nversion: 1\nrun_id: X\norchestrator: y\naction: DONE\n@@END@@\n";
		assert.strictEqual(parseProtocolBlock(s), null);
	});
	test("T-PR-24 | unknown action → null", () => {
		const s =
			"\n@@TURNLOCK@@\nversion: 3\nrun_id: X\norchestrator: y\naction: FOOBAR\n@@END@@\n";
		assert.strictEqual(parseProtocolBlock(s), null);
	});
});
describe("parseProtocolBlock multiplicity (T-PR-25..26)", () => {
	test("T-PR-25 | two blocks → returns first", () => {
		const parsed = parseProtocolBlock(
			loadFixture("protocol/malformed-double-block.txt"),
		);
		assert.notStrictEqual(parsed, null);
		assert.strictEqual(parsed?.fields.output, "/tmp/out1.json");
	});
	test("T-PR-26 | tolerates noise before block", () => {
		const noisy = `stray log line\nanother\n${loadFixture("protocol/done-minimal.txt")}`;
		const parsed = parseProtocolBlock(noisy);
		assert.notStrictEqual(parsed, null);
		assert.strictEqual(parsed?.action, "DONE");
	});
});
describe("protocol properties (P-PR-a..d)", () => {
	test("P-PR-a | round-trip DELEGATE", () => {
		const block = writeProtocolBlock("DELEGATE", {
			runId: RID,
			orchestrator: "x",
			manifest: "/a.json",
			kind: "prompt",
			resumeCmd: RCMD,
		});
		const parsed = parseProtocolBlock(block);
		assert.notStrictEqual(parsed, null);
		assert.strictEqual(parsed?.action, "DELEGATE");
		assert.strictEqual(parsed?.fields.kind, "prompt");
	});
	test("P-PR-b | pure (same input → same output)", () => {
		const fields = {
			runId: RID,
			orchestrator: "x",
			output: "/a.json",
			success: true as const,
			phasesExecuted: 1,
			durationMs: 100,
		};
		assert.strictEqual(
			writeProtocolBlock("DONE", fields),
			writeProtocolBlock("DONE", fields),
		);
	});
	test("P-PR-c | block contains exactly one @@TURNLOCK@@ + one @@END@@", () => {
		const out = writeProtocolBlock("DONE", {
			runId: RID,
			orchestrator: "x",
			output: "/a.json",
			success: true,
			phasesExecuted: 1,
			durationMs: 10,
		});
		assert.strictEqual(out.match(/@@TURNLOCK@@/g)?.length, 1);
		assert.strictEqual(out.match(/@@END@@/g)?.length, 1);
	});
	test("P-PR-d | required fields always present", () => {
		const out = writeProtocolBlock("DONE", {
			runId: RID,
			orchestrator: "x",
			output: "/a.json",
			success: true,
			phasesExecuted: 1,
			durationMs: 10,
		});
		assert.match(out, /version: \d+/);
		assert.match(out, /run_id: /);
		assert.match(out, /orchestrator: /);
		assert.match(out, /action: /);
	});
});
