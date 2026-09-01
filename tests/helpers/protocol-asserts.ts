import assert from "node:assert/strict";
import {} from "node:test";
import type { OrchestratorErrorKind } from "../../src/errors/base.js";
import type {
	ParsedProtocolBlock,
	ProtocolAction,
} from "../../src/services/protocol.js";
import { parseProtocolBlock } from "../../src/services/protocol.js";
import type { OrchestratorEvent } from "../../src/types/events.js";

function countBlocks(stdout: string): number {
	const matches = stdout.match(/@@TURNLOCK@@/g);
	return matches === null ? 0 : matches.length;
}
export const protocolAsserts = {
	singleBlock(stdout: string): ParsedProtocolBlock {
		assert.strictEqual(countBlocks(stdout), 1);
		const parsed = parseProtocolBlock(stdout);
		assert.notStrictEqual(parsed, null);
		return parsed as ParsedProtocolBlock;
	},
	blockAction(block: ParsedProtocolBlock, action: ProtocolAction): void {
		assert.strictEqual(block.action, action);
	},
	blockRunId(block: ParsedProtocolBlock, runId: string | null): void {
		assert.strictEqual(block.runId, runId);
	},
	blockErrorKind(
		block: ParsedProtocolBlock,
		errorKind: OrchestratorErrorKind,
	): void {
		assert.strictEqual(block.action, "ERROR");
		assert.strictEqual(block.fields.errorKind, errorKind);
	},
	noBlock(stdout: string): void {
		assert.strictEqual(countBlocks(stdout), 0);
	},
};
export const eventAsserts = {
	sequenceMatches(
		events: OrchestratorEvent[],
		expectedTypes: readonly string[],
	): void {
		const actual: string[] = events.map((e) => e.eventType);
		assert.deepStrictEqual(actual, [...expectedTypes]);
	},
	allSameRunId(events: OrchestratorEvent[]): void {
		const ids = new Set(events.map((e) => e.runId));
		assert.ok(ids.size <= 1);
	},
	countOfType(events: OrchestratorEvent[], eventType: string): number {
		return events.filter((e) => e.eventType === eventType).length;
	},
	endEventFinal(events: OrchestratorEvent[]): void {
		assert.ok(events.length > 0);
		assert.strictEqual(events.at(-1)?.eventType, "orchestrator_end");
	},
	noPIIIn(
		events: OrchestratorEvent[],
		forbiddenTexts: readonly string[],
	): void {
		const serialized = events.map((e) => JSON.stringify(e)).join("\n");
		for (const txt of forbiddenTexts) {
			assert.ok(!serialized.includes(txt));
		}
	},
};
