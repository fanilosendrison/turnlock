import type { Clock } from "../types/config.ts";

export type { Clock };

export const clock: Clock = {
	nowWall: (): Date => new Date(),
	nowWallIso: (): string => new Date().toISOString(),
	nowEpochMs: (): number => Date.now(),
	nowMono: (): number => performance.now(),
};
