// NIB-T §4 — protocol writer/parser (T-PR-01..26, P-PR-a..d)
import { describe, expect, test } from "bun:test";
import {
	parseProtocolBlock,
	writeProtocolBlock,
} from "../../src/services/protocol";
import { loadFixture } from "../helpers/fixture-loader";

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
		expect(out).toContain("@@TURNLOCK@@");
		expect(out).toContain("@@END@@");
		expect(out).toContain("action: DELEGATE");
		expect(out).toContain("kind: prompt");
		expect(out).toContain("manifest: /abs/path.json");
	});
	test("T-PR-02 | batch", () => {
		const out = writeProtocolBlock("DELEGATE", {
			runId: RID,
			orchestrator: "x",
			manifest: "/a.json",
			kind: "batch",
			resumeCmd: RCMD,
		});
		expect(out).toContain("kind: batch");
	});
	test("T-PR-03 | prompt with alternate orchestrator", () => {
		const out = writeProtocolBlock("DELEGATE", {
			runId: RID,
			orchestrator: "x",
			manifest: "/a.json",
			kind: "prompt",
			resumeCmd: RCMD,
		});
		expect(out).toContain("kind: prompt");
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

		expect(out).toContain("action: REQUEST_EXTERNAL");
		expect(out).toContain(`request_id: ${RID}/push-repo`);
		expect(out).toContain("request_type: git.push");
		expect(out).toContain("manifest: /run/external-requests/push-repo.json");
		expect(out).toContain("result: /run/external-results/push-repo.json");
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
		expect(out).toContain("action: DONE");
		expect(out).toContain("success: true");
		expect(out).toContain("phases_executed: 5");
		expect(out).toContain("duration_ms: 12345");
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
		expect(out).toContain("phases_executed: 0");
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
		expect(out).toContain("action: ERROR");
		expect(out).toContain("error_kind: delegation_schema");
		expect(out).toContain("phase: consolidate");
		expect(out).toContain("phases_executed: 4");
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
		expect(out).toContain("run_id: null");
		expect(out).toContain("phase: null");
		expect(out).toContain("error_kind: invalid_config");
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
		expect(out).toContain("error_kind: run_locked");
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
		expect(out).toContain('\\"');
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
		expect(out).toContain("\\n");
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
		expect(out).toContain("action: ABORTED");
		expect(out).toContain("signal: SIGINT");
		expect(out).toContain("phase: dispatch-reviews");
	});
	test("T-PR-12 | SIGTERM phase null", () => {
		const out = writeProtocolBlock("ABORTED", {
			runId: RID,
			orchestrator: "x",
			signal: "SIGTERM",
			phase: null,
		});
		expect(out).toContain("signal: SIGTERM");
		expect(out).toContain("phase: null");
	});
});

describe("parseProtocolBlock happy (T-PR-13..19)", () => {
	test("T-PR-13 | DELEGATE full", () => {
		const parsed = parseProtocolBlock(
			loadFixture("protocol/delegate-prompt.txt"),
		);
		expect(parsed).not.toBeNull();
		expect(parsed?.action).toBe("DELEGATE");
		expect(parsed?.fields.kind).toBe("prompt");
	});
	test("parses REQUEST_EXTERNAL fields", () => {
		const parsed = parseProtocolBlock(
			loadFixture("protocol/request-external.txt"),
		);
		expect(parsed?.action).toBe("REQUEST_EXTERNAL");
		expect(parsed?.fields.requestId).toBe(`${RID}/push-repo`);
		expect(parsed?.fields.requestType).toBe("git.push");
		expect(parsed?.fields.result).toBe("/tmp/external-results/push-repo.json");
	});
	test("T-PR-14 | DONE full", () => {
		const parsed = parseProtocolBlock(loadFixture("protocol/done-minimal.txt"));
		expect(parsed?.action).toBe("DONE");
		expect(parsed?.fields.success).toBe(true);
		expect(parsed?.fields.phasesExecuted).toBe(3);
		expect(parsed?.fields.durationMs).toBe(1234);
	});
	test("T-PR-15 | ERROR preflight runId=null", () => {
		const parsed = parseProtocolBlock(
			loadFixture("protocol/error-preflight.txt"),
		);
		expect(parsed?.runId).toBeNull();
	});
	test("T-PR-16 | ERROR phase=null", () => {
		const parsed = parseProtocolBlock(
			loadFixture("protocol/error-preflight.txt"),
		);
		expect(parsed?.fields.phase).toBeNull();
	});
	test("T-PR-17 | ABORTED", () => {
		const parsed = parseProtocolBlock(
			loadFixture("protocol/aborted-sigint.txt"),
		);
		expect(parsed?.action).toBe("ABORTED");
		expect(parsed?.fields.signal).toBe("SIGINT");
	});
	test("T-PR-18 | success string → boolean", () => {
		const parsed = parseProtocolBlock(loadFixture("protocol/done-minimal.txt"));
		expect(parsed?.fields.success).toBe(true);
		expect(typeof parsed?.fields.success).toBe("boolean");
	});
	test("T-PR-19 | phases_executed → number", () => {
		const parsed = parseProtocolBlock(loadFixture("protocol/done-minimal.txt"));
		expect(typeof parsed?.fields.phasesExecuted).toBe("number");
	});
});

describe("parseProtocolBlock rejects (T-PR-20..24)", () => {
	test("T-PR-20 | no block → null", () => {
		expect(parseProtocolBlock("plain text\nno markers")).toBeNull();
	});
	test("T-PR-21 | no @@END@@ → null", () => {
		expect(
			parseProtocolBlock(loadFixture("protocol/malformed-missing-end.txt")),
		).toBeNull();
	});
	test("T-PR-22 | missing @@TURNLOCK@@ → null", () => {
		expect(parseProtocolBlock("version: 3\nrun_id: X\n@@END@@")).toBeNull();
	});
	test("T-PR-23 | version incompatible → null", () => {
		const s =
			"\n@@TURNLOCK@@\nversion: 1\nrun_id: X\norchestrator: y\naction: DONE\n@@END@@\n";
		expect(parseProtocolBlock(s)).toBeNull();
	});
	test("T-PR-24 | unknown action → null", () => {
		const s =
			"\n@@TURNLOCK@@\nversion: 3\nrun_id: X\norchestrator: y\naction: FOOBAR\n@@END@@\n";
		expect(parseProtocolBlock(s)).toBeNull();
	});
});

describe("parseProtocolBlock multiplicity (T-PR-25..26)", () => {
	test("T-PR-25 | two blocks → returns first", () => {
		const parsed = parseProtocolBlock(
			loadFixture("protocol/malformed-double-block.txt"),
		);
		expect(parsed).not.toBeNull();
		expect(parsed?.fields.output).toBe("/tmp/out1.json");
	});
	test("T-PR-26 | tolerates noise before block", () => {
		const noisy = `stray log line\nanother\n${loadFixture("protocol/done-minimal.txt")}`;
		const parsed = parseProtocolBlock(noisy);
		expect(parsed).not.toBeNull();
		expect(parsed?.action).toBe("DONE");
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
		expect(parsed).not.toBeNull();
		expect(parsed?.action).toBe("DELEGATE");
		expect(parsed?.fields.kind).toBe("prompt");
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
		expect(writeProtocolBlock("DONE", fields)).toBe(
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
		expect(out.match(/@@TURNLOCK@@/g)?.length).toBe(1);
		expect(out.match(/@@END@@/g)?.length).toBe(1);
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
		expect(out).toMatch(/version: \d+/);
		expect(out).toMatch(/run_id: /);
		expect(out).toMatch(/orchestrator: /);
		expect(out).toMatch(/action: /);
	});
});
