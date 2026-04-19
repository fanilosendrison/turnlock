import { ulid } from "ulid";

export function generateRunId(): string {
	return ulid();
}
