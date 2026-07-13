import { ulid } from "ulid";

const RUN_ID_REGEX = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export function generateRunId(): string {
	return ulid();
}

export function isValidRunId(runId: string): boolean {
	return RUN_ID_REGEX.test(runId);
}
