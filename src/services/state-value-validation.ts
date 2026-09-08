import { StateCorruptedError } from "../errors/concrete.js";
import type { ArtifactRef, TerminalDoneRecord } from "../types/artifacts.js";
import { isContentDigest } from "./content-digest.js";

export function describeStateIoError(error: unknown): string {
	if (error instanceof Error) return error.message.slice(0, 200);
	return String(error).slice(0, 200);
}

export function isNonEmptyStateString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

export function isNonNegativeStateNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function isIsoStateTimestamp(value: unknown): value is string {
	if (typeof value !== "string") return false;
	try {
		return new Date(value).toISOString() === value;
	} catch {
		return false;
	}
}

export function requireStateRecord(
	value: unknown,
	field: string,
): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new StateCorruptedError(
			`state.json field ${field} has wrong type or value`,
		);
	}
	return value as Record<string, unknown>;
}

export function isStateArtifactRef(value: unknown): value is ArtifactRef {
	if (typeof value !== "object" || value === null) return false;
	const ref = value as Record<string, unknown>;
	return (
		typeof ref.kind === "string" &&
		(ref.kind === "terminal-output" ||
			ref.kind === "delegation-manifest" ||
			ref.kind === "external-request-manifest") &&
		ref.digestAlgorithm === "sha256" &&
		isContentDigest(ref.digest) &&
		typeof ref.relativePath === "string" &&
		ref.relativePath.length > 0 &&
		ref.mediaType === "application/json" &&
		typeof ref.sizeBytes === "number" &&
		Number.isInteger(ref.sizeBytes) &&
		ref.sizeBytes >= 0
	);
}

export function assertStateArtifactRef(
	value: unknown,
	field: string,
	expectedKind?: ArtifactRef["kind"],
): ArtifactRef {
	if (!isStateArtifactRef(value)) {
		throw new StateCorruptedError(
			`state.json field ${field} is not a valid ArtifactRef`,
		);
	}
	if (expectedKind !== undefined && value.kind !== expectedKind) {
		throw new StateCorruptedError(
			`state.json field ${field} has wrong kind: expected ${expectedKind}, got ${value.kind}`,
		);
	}
	return value;
}

export function isTerminalDoneRecord(
	value: unknown,
): value is TerminalDoneRecord {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	return (
		record.kind === "done" &&
		isStateArtifactRef(record.outputArtifact) &&
		record.outputArtifact.kind === "terminal-output" &&
		typeof record.completedAt === "string" &&
		typeof record.completedAtEpochMs === "number" &&
		Number.isFinite(record.completedAtEpochMs)
	);
}
