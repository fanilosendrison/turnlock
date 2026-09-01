import assert from "node:assert/strict";
// NIB-T §23 — events taxonomy (T-OB-01..13, P-OB-a/b/c)
import { describe, test } from "node:test";
const requiredFields = {
    orchestrator_start: [
        "runId",
        "orchestratorName",
        "initialPhase",
        "timestamp",
    ],
    phase_start: ["runId", "phase", "attemptCount", "timestamp"],
    phase_end: ["runId", "phase", "durationMs", "resultKind", "timestamp"],
    delegation_emit: ["runId", "phase", "label", "kind", "jobCount", "timestamp"],
    delegation_result_read: [
        "runId",
        "phase",
        "label",
        "jobCount",
        "filesLoaded",
        "timestamp",
    ],
    delegation_validated: ["runId", "phase", "label", "timestamp"],
    delegation_validation_failed: [
        "runId",
        "phase",
        "label",
        "zodErrorSummary",
        "timestamp",
    ],
    external_request_emit: [
        "runId",
        "phase",
        "label",
        "requestId",
        "requestType",
        "timestamp",
    ],
    external_request_reemit: [
        "runId",
        "phase",
        "label",
        "requestId",
        "requestType",
        "timestamp",
    ],
    external_resolution_read: [
        "runId",
        "phase",
        "label",
        "requestId",
        "requestType",
        "timestamp",
    ],
    external_resolution_validation_failed: [
        "runId",
        "phase",
        "label",
        "requestId",
        "requestType",
        "reason",
        "timestamp",
    ],
    external_resolution_validated: [
        "runId",
        "phase",
        "label",
        "requestId",
        "requestType",
        "timestamp",
    ],
    retry_scheduled: [
        "runId",
        "phase",
        "label",
        "attempt",
        "delayMs",
        "reason",
        "timestamp",
    ],
    phase_error: ["runId", "phase", "errorKind", "message", "timestamp"],
    lock_conflict: ["runId", "reason", "timestamp"],
    orchestrator_end: [
        "runId",
        "orchestratorName",
        "success",
        "durationMs",
        "phasesExecuted",
        "timestamp",
    ],
    ownership_release_failed: ["runId", "timestamp"],
};
function sampleEvents() {
    return {
        orchestrator_start: {
            eventType: "orchestrator_start",
            runId: "01HX",
            orchestratorName: "orch",
            initialPhase: "a",
            timestamp: "2026-04-19T12:00:00.000Z",
        },
        phase_start: {
            eventType: "phase_start",
            runId: "01HX",
            phase: "a",
            attemptCount: 1,
            timestamp: "2026-04-19T12:00:00.100Z",
        },
        phase_end: {
            eventType: "phase_end",
            runId: "01HX",
            phase: "a",
            durationMs: 100,
            resultKind: "done",
            timestamp: "2026-04-19T12:00:00.200Z",
        },
        delegation_emit: {
            eventType: "delegation_emit",
            runId: "01HX",
            phase: "a",
            label: "l",
            kind: "prompt",
            jobCount: 1,
            timestamp: "2026-04-19T12:00:00.100Z",
        },
        delegation_result_read: {
            eventType: "delegation_result_read",
            runId: "01HX",
            phase: "a",
            label: "l",
            jobCount: 1,
            filesLoaded: 1,
            timestamp: "2026-04-19T12:00:00.100Z",
        },
        delegation_validated: {
            eventType: "delegation_validated",
            runId: "01HX",
            phase: "a",
            label: "l",
            timestamp: "2026-04-19T12:00:00.100Z",
        },
        delegation_validation_failed: {
            eventType: "delegation_validation_failed",
            runId: "01HX",
            phase: "a",
            label: "l",
            zodErrorSummary: "root: invalid_type",
            timestamp: "2026-04-19T12:00:00.100Z",
        },
        external_request_emit: {
            eventType: "external_request_emit",
            runId: "01HX",
            phase: "a",
            label: "push-repo",
            requestId: "01HX/push-repo",
            requestType: "git.push",
            timestamp: "2026-04-19T12:00:00.100Z",
        },
        external_request_reemit: {
            eventType: "external_request_reemit",
            runId: "01HX",
            phase: "a",
            label: "push-repo",
            requestId: "01HX/push-repo",
            requestType: "git.push",
            timestamp: "2026-04-19T12:00:01.100Z",
        },
        external_resolution_read: {
            eventType: "external_resolution_read",
            runId: "01HX",
            phase: "b",
            label: "push-repo",
            requestId: "01HX/push-repo",
            requestType: "git.push",
            timestamp: "2026-04-19T12:00:02.100Z",
        },
        external_resolution_validation_failed: {
            eventType: "external_resolution_validation_failed",
            runId: "01HX",
            phase: "b",
            label: "push-repo",
            requestId: "01HX/push-repo",
            requestType: "git.push",
            reason: "schema_invalid",
            timestamp: "2026-04-19T12:00:02.200Z",
        },
        external_resolution_validated: {
            eventType: "external_resolution_validated",
            runId: "01HX",
            phase: "b",
            label: "push-repo",
            requestId: "01HX/push-repo",
            requestType: "git.push",
            timestamp: "2026-04-19T12:00:02.200Z",
        },
        retry_scheduled: {
            eventType: "retry_scheduled",
            runId: "01HX",
            phase: "a",
            label: "l",
            attempt: 1,
            delayMs: 1000,
            reason: "delegation_schema",
            timestamp: "2026-04-19T12:00:00.100Z",
        },
        phase_error: {
            eventType: "phase_error",
            runId: "01HX",
            phase: "a",
            errorKind: "phase_error",
            message: "boom",
            timestamp: "2026-04-19T12:00:00.100Z",
        },
        lock_conflict: {
            eventType: "lock_conflict",
            runId: "01HX",
            reason: "expired_override",
            timestamp: "2026-04-19T12:00:00.100Z",
        },
        orchestrator_end: {
            eventType: "orchestrator_end",
            runId: "01HX",
            orchestratorName: "orch",
            success: true,
            durationMs: 100,
            phasesExecuted: 1,
            timestamp: "2026-04-19T12:00:00.100Z",
        },
        ownership_release_failed: {
            eventType: "ownership_release_failed",
            runId: "01HX",
            reason: "STALE_HANDLE",
            timestamp: "2026-04-19T12:00:00.100Z",
        },
    };
}
describe("[GREEN-L1] events taxonomy", () => {
    const events = sampleEvents();
    for (const [type, fields] of Object.entries(requiredFields)) {
        test(`T-OB-${type} | ${type} has required fields`, () => {
            const ev = events[type];
            assert.notStrictEqual(ev, undefined);
            if (ev === undefined)
                throw new Error(`missing sample event: ${type}`);
            for (const f of fields) {
                assert.ok(f in Object(ev));
            }
        });
    }
});
describe("[GREEN-L1] events closed taxonomy (T-OB-12..13)", () => {
    test("T-OB-12 | eventType belongs to the 17-value taxonomy", () => {
        const allowed = new Set(Object.keys(requiredFields));
        for (const type of Object.keys(sampleEvents())) {
            assert.strictEqual(allowed.has(type), true);
        }
    });
    test("T-OB-13 | no eventType = 'unknown'", () => {
        const events = sampleEvents();
        for (const ev of Object.values(events)) {
            assert.notStrictEqual(ev.eventType, "unknown");
        }
    });
});
describe("[GREEN-L1] events properties (P-OB-a..c)", () => {
    test("P-OB-a | JSON serializable", () => {
        for (const ev of Object.values(sampleEvents())) {
            assert.doesNotThrow(() => JSON.stringify(ev));
        }
    });
    test("P-OB-b | runId non-empty string", () => {
        for (const ev of Object.values(sampleEvents())) {
            assert.strictEqual(typeof ev.runId, "string");
            assert.ok(ev.runId.length > 0);
        }
    });
    test("P-OB-c | timestamp ISO 8601", () => {
        const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
        for (const ev of Object.values(sampleEvents())) {
            assert.strictEqual(iso.test(ev.timestamp), true);
        }
    });
});
//# sourceMappingURL=events-taxonomy.test.js.map