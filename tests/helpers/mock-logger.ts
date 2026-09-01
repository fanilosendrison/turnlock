import type { InternalLogger } from "../../src/services/logger.js";
import type { OrchestratorEvent } from "../../src/types/events.js";
export interface MockLogger extends InternalLogger {
	events: OrchestratorEvent[];
	reset(): void;
	find(eventType: string): OrchestratorEvent | undefined;
	findAll(eventType: string): OrchestratorEvent[];
	eventTypes(): string[];
}
export function createMockLogger(): MockLogger {
	const events: OrchestratorEvent[] = [];
	let diskPath: string | null = null;
	const self: MockLogger = {
		events,
		emit(event: OrchestratorEvent): void {
			events.push(event);
		},
		enableDiskEmit(path: string): void {
			diskPath = path;
		},
		disableDiskEmit(): void {
			diskPath = null;
		},
		reset(): void {
			events.length = 0;
			diskPath = null;
		},
		find(eventType: string): OrchestratorEvent | undefined {
			return events.find((e) => e.eventType === eventType);
		},
		findAll(eventType: string): OrchestratorEvent[] {
			return events.filter((e) => e.eventType === eventType);
		},
		eventTypes(): string[] {
			return events.map((e) => e.eventType);
		},
	};
	// Reference diskPath so that TS doesn't flag the assignments as dead writes.
	Object.defineProperty(self, "__diskPath", {
		get: () => diskPath,
		enumerable: false,
	});
	return self;
}
