import assert from "node:assert/strict";
import { parseProtocolBlock } from "../../src/services/protocol.js";
function countBlocks(stdout) {
    const matches = stdout.match(/@@TURNLOCK@@/g);
    return matches === null ? 0 : matches.length;
}
export const protocolAsserts = {
    singleBlock(stdout) {
        assert.strictEqual(countBlocks(stdout), 1);
        const parsed = parseProtocolBlock(stdout);
        assert.notStrictEqual(parsed, null);
        return parsed;
    },
    blockAction(block, action) {
        assert.strictEqual(block.action, action);
    },
    blockRunId(block, runId) {
        assert.strictEqual(block.runId, runId);
    },
    blockErrorKind(block, errorKind) {
        assert.strictEqual(block.action, "ERROR");
        assert.strictEqual(block.fields.errorKind, errorKind);
    },
    noBlock(stdout) {
        assert.strictEqual(countBlocks(stdout), 0);
    },
};
export const eventAsserts = {
    sequenceMatches(events, expectedTypes) {
        const actual = events.map((e) => e.eventType);
        assert.deepStrictEqual(actual, [...expectedTypes]);
    },
    allSameRunId(events) {
        const ids = new Set(events.map((e) => e.runId));
        assert.ok(ids.size <= 1);
    },
    countOfType(events, eventType) {
        return events.filter((e) => e.eventType === eventType).length;
    },
    endEventFinal(events) {
        assert.ok(events.length > 0);
        assert.strictEqual(events.at(-1)?.eventType, "orchestrator_end");
    },
    noPIIIn(events, forbiddenTexts) {
        const serialized = events.map((e) => JSON.stringify(e)).join("\n");
        for (const txt of forbiddenTexts) {
            assert.ok(!serialized.includes(txt));
        }
    },
};
//# sourceMappingURL=protocol-asserts.js.map