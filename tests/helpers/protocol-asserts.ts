import { expect } from "bun:test";
import type { OrchestratorErrorKind } from "../../src/errors/base";
import type {
	ParsedProtocolBlock,
	ProtocolAction,
} from "../../src/services/protocol";
import { parseProtocolBlock } from "../../src/services/protocol";
import type { OrchestratorEvent } from "../../src/types/events";

function countBlocks(stdout: string): number {
	const matches = stdout.match(/@@TURNLOCK@@/g);
	return matches === null ? 0 : matches.length;
}

export const protocolAsserts = {
	singleBlock(stdout: string): ParsedProtocolBlock {
		expect(countBlocks(stdout)).toBe(1);
		const parsed = parseProtocolBlock(stdout);
		expect(parsed).not.toBeNull();
		return parsed as ParsedProtocolBlock;
	},
	blockAction(block: ParsedProtocolBlock, action: ProtocolAction): void {
		expect(block.action).toBe(action);
	},
	blockRunId(block: ParsedProtocolBlock, runId: string | null): void {
		expect(block.runId).toBe(runId);
	},
	blockErrorKind(
		block: ParsedProtocolBlock,
		errorKind: OrchestratorErrorKind,
	): void {
		expect(block.action).toBe("ERROR");
		expect(block.fields.errorKind).toBe(errorKind);
	},
	noBlock(stdout: string): void {
		expect(countBlocks(stdout)).toBe(0);
	},
};

export const eventAsserts = {
	sequenceMatches(
		events: OrchestratorEvent[],
		expectedTypes: readonly string[],
	): void {
		const actual: string[] = events.map((e) => e.eventType);
		expect(actual).toEqual([...expectedTypes]);
	},
	allSameRunId(events: OrchestratorEvent[]): void {
		const ids = new Set(events.map((e) => e.runId));
		expect(ids.size).toBeLessThanOrEqual(1);
	},
	countOfType(events: OrchestratorEvent[], eventType: string): number {
		return events.filter((e) => e.eventType === eventType).length;
	},
	endEventFinal(events: OrchestratorEvent[]): void {
		expect(events.length).toBeGreaterThan(0);
		expect(events.at(-1)?.eventType).toBe("orchestrator_end");
	},
	noPIIIn(
		events: OrchestratorEvent[],
		forbiddenTexts: readonly string[],
	): void {
		const serialized = events.map((e) => JSON.stringify(e)).join("\n");
		for (const txt of forbiddenTexts) {
			expect(serialized).not.toContain(txt);
		}
	},
};
