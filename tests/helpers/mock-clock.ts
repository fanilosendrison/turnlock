import type { Clock } from "../../src/types/config.js";
export interface MockClock extends Clock {
	setWall(isoOrDate: string | Date): void;
	setEpochMs(ms: number): void;
	setMono(ms: number): void;
	advanceWall(ms: number): void;
	advanceEpoch(ms: number): void;
	advanceMono(ms: number): void;
}
export function createMockClock(
	initialIso = "2026-04-19T12:00:00.000Z",
	initialEpoch?: number,
	initialMono = 0,
): MockClock {
	let wall = new Date(initialIso);
	let epoch = initialEpoch ?? wall.getTime();
	let mono = initialMono;
	return {
		nowWall(): Date {
			return new Date(wall.getTime());
		},
		nowWallIso(): string {
			return wall.toISOString();
		},
		nowEpochMs(): number {
			return epoch;
		},
		nowMono(): number {
			return mono;
		},
		setWall(isoOrDate: string | Date): void {
			wall =
				typeof isoOrDate === "string"
					? new Date(isoOrDate)
					: new Date(isoOrDate.getTime());
		},
		setEpochMs(ms: number): void {
			epoch = ms;
		},
		setMono(ms: number): void {
			mono = ms;
		},
		advanceWall(ms: number): void {
			wall = new Date(wall.getTime() + ms);
		},
		advanceEpoch(ms: number): void {
			epoch += ms;
		},
		advanceMono(ms: number): void {
			mono += ms;
		},
	};
}
