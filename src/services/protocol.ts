import { PROTOCOL_VERSION } from "../constants";

export type ProtocolAction = "DELEGATE" | "DONE" | "ERROR" | "ABORTED";

export interface ParsedProtocolBlock {
	readonly version: number;
	readonly runId: string | null;
	readonly orchestrator: string;
	readonly action: ProtocolAction;
	readonly fields: Record<string, string | number | boolean | null>;
}

export interface DelegateFields {
	readonly runId: string;
	readonly orchestrator: string;
	readonly manifest: string;
	readonly kind: "skill" | "agent" | "agent-batch";
	readonly resumeCmd: string;
}

export interface DoneFields {
	readonly runId: string;
	readonly orchestrator: string;
	readonly output: string;
	readonly success: true;
	readonly phasesExecuted: number;
	readonly durationMs: number;
}

export interface ErrorFields {
	readonly runId: string | null;
	readonly orchestrator: string;
	readonly errorKind: string;
	readonly message: string;
	readonly phase: string | null;
	readonly phasesExecuted: number;
}

export interface AbortedFields {
	readonly runId: string;
	readonly orchestrator: string;
	readonly signal: "SIGINT" | "SIGTERM";
	readonly phase: string | null;
}

function serializeValue(value: string | number | boolean | null): string {
	if (value === null) return "null";
	if (typeof value === "boolean") return value ? "true" : "false";
	if (typeof value === "number") return String(value);
	if (/[:\n\r\t"\\]/.test(value)) {
		return JSON.stringify(value);
	}
	return value;
}

function writeDelegate(fields: DelegateFields): string {
	return [
		"",
		"@@CC_ORCH@@",
		`version: ${PROTOCOL_VERSION}`,
		`run_id: ${serializeValue(fields.runId)}`,
		`orchestrator: ${serializeValue(fields.orchestrator)}`,
		"action: DELEGATE",
		`manifest: ${serializeValue(fields.manifest)}`,
		`kind: ${fields.kind}`,
		`resume_cmd: ${serializeValue(fields.resumeCmd)}`,
		"@@END@@",
		"",
		"",
	].join("\n");
}

function writeDone(fields: DoneFields): string {
	return [
		"",
		"@@CC_ORCH@@",
		`version: ${PROTOCOL_VERSION}`,
		`run_id: ${serializeValue(fields.runId)}`,
		`orchestrator: ${serializeValue(fields.orchestrator)}`,
		"action: DONE",
		`output: ${serializeValue(fields.output)}`,
		`success: ${serializeValue(fields.success)}`,
		`phases_executed: ${fields.phasesExecuted}`,
		`duration_ms: ${fields.durationMs}`,
		"@@END@@",
		"",
		"",
	].join("\n");
}

function writeError(fields: ErrorFields): string {
	return [
		"",
		"@@CC_ORCH@@",
		`version: ${PROTOCOL_VERSION}`,
		`run_id: ${serializeValue(fields.runId)}`,
		`orchestrator: ${serializeValue(fields.orchestrator)}`,
		"action: ERROR",
		`error_kind: ${fields.errorKind}`,
		`message: ${serializeValue(fields.message)}`,
		`phase: ${serializeValue(fields.phase)}`,
		`phases_executed: ${fields.phasesExecuted}`,
		"@@END@@",
		"",
		"",
	].join("\n");
}

function writeAborted(fields: AbortedFields): string {
	return [
		"",
		"@@CC_ORCH@@",
		`version: ${PROTOCOL_VERSION}`,
		`run_id: ${serializeValue(fields.runId)}`,
		`orchestrator: ${serializeValue(fields.orchestrator)}`,
		"action: ABORTED",
		`signal: ${fields.signal}`,
		`phase: ${serializeValue(fields.phase)}`,
		"@@END@@",
		"",
		"",
	].join("\n");
}

export function writeProtocolBlock(
	action: "DELEGATE",
	fields: DelegateFields,
): string;
export function writeProtocolBlock(action: "DONE", fields: DoneFields): string;
export function writeProtocolBlock(
	action: "ERROR",
	fields: ErrorFields,
): string;
export function writeProtocolBlock(
	action: "ABORTED",
	fields: AbortedFields,
): string;
export function writeProtocolBlock(
	action: ProtocolAction,
	fields: DelegateFields | DoneFields | ErrorFields | AbortedFields,
): string {
	switch (action) {
		case "DELEGATE":
			return writeDelegate(fields as DelegateFields);
		case "DONE":
			return writeDone(fields as DoneFields);
		case "ERROR":
			return writeError(fields as ErrorFields);
		case "ABORTED":
			return writeAborted(fields as AbortedFields);
	}
}

function isValidAction(s: string): s is ProtocolAction {
	return s === "DELEGATE" || s === "DONE" || s === "ERROR" || s === "ABORTED";
}

function snakeToCamel(s: string): string {
	return s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

function parseValue(raw: string): string | number | boolean | null {
	if (raw === "null") return null;
	if (raw === "true") return true;
	if (raw === "false") return false;
	if (/^-?\d+(\.\d+)?$/.test(raw)) {
		const n = Number(raw);
		if (Number.isFinite(n)) return n;
	}
	if (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) {
		try {
			return JSON.parse(raw) as string;
		} catch {
			return raw;
		}
	}
	return raw;
}

function parseKeyValueLine(
	line: string,
): { key: string; value: string | number | boolean | null } | null {
	const match = line.match(/^([a-z_][a-z0-9_]*): (.*)$/);
	if (!match) return null;
	const key = match[1];
	const rawValue = match[2];
	if (key === undefined || rawValue === undefined) return null;
	return { key, value: parseValue(rawValue) };
}

export function parseProtocolBlock(stdout: string): ParsedProtocolBlock | null {
	const lines = stdout.split(/\r?\n/);
	const startIdx = lines.findIndex((l) => l.trim() === "@@CC_ORCH@@");
	if (startIdx === -1) return null;
	const endIdx = lines.findIndex(
		(l, i) => i > startIdx && l.trim() === "@@END@@",
	);
	if (endIdx === -1) return null;

	const payloadLines = lines.slice(startIdx + 1, endIdx);
	const parsed: Record<string, string | number | boolean | null> = {};
	for (const line of payloadLines) {
		if (line.trim() === "") continue;
		const result = parseKeyValueLine(line);
		if (result === null) return null;
		parsed[result.key] = result.value;
	}

	if (parsed.version !== PROTOCOL_VERSION) return null;
	if (typeof parsed.orchestrator !== "string") return null;
	if (typeof parsed.action !== "string" || !isValidAction(parsed.action))
		return null;
	if (parsed.run_id !== null && typeof parsed.run_id !== "string") return null;

	const { version, run_id, orchestrator, action, ...rest } = parsed;
	const fields: Record<string, string | number | boolean | null> = {};
	for (const [k, v] of Object.entries(rest)) {
		fields[snakeToCamel(k)] = v;
	}
	return {
		version: version as number,
		runId: run_id as string | null,
		orchestrator: orchestrator as string,
		action: action as ProtocolAction,
		fields,
	};
}
