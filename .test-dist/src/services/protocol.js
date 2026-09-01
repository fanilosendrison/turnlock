import { PROTOCOL_VERSION } from "../constants.js";
function serializeValue(value) {
    if (value === null)
        return "null";
    if (typeof value === "boolean")
        return value ? "true" : "false";
    if (typeof value === "number")
        return String(value);
    if (/[:\n\r\t"\\]/.test(value)) {
        return JSON.stringify(value);
    }
    return value;
}
/** Shared structure: header (version, run_id, orchestrator, action) + body + footer. */
function buildBlock(action, runId, orchestrator, bodyLines) {
    return [
        "",
        "@@TURNLOCK@@",
        `version: ${PROTOCOL_VERSION}`,
        `run_id: ${serializeValue(runId)}`,
        `orchestrator: ${serializeValue(orchestrator)}`,
        `action: ${action}`,
        ...bodyLines,
        "@@END@@",
        "",
        "",
    ].join("\n");
}
function writeDelegate(fields) {
    return buildBlock("DELEGATE", fields.runId, fields.orchestrator, [
        `manifest: ${serializeValue(fields.manifest)}`,
        `kind: ${fields.kind}`,
        `resume_cmd: ${serializeValue(fields.resumeCmd)}`,
    ]);
}
function writeRequestExternal(fields) {
    return buildBlock("REQUEST_EXTERNAL", fields.runId, fields.orchestrator, [
        `request_id: ${serializeValue(fields.requestId)}`,
        `request_type: ${serializeValue(fields.requestType)}`,
        `manifest: ${serializeValue(fields.manifest)}`,
        `result: ${serializeValue(fields.result)}`,
        `resume_cmd: ${serializeValue(fields.resumeCmd)}`,
    ]);
}
function writeDone(fields) {
    return buildBlock("DONE", fields.runId, fields.orchestrator, [
        `output: ${serializeValue(fields.output)}`,
        `success: ${serializeValue(fields.success)}`,
        `phases_executed: ${fields.phasesExecuted}`,
        `duration_ms: ${fields.durationMs}`,
    ]);
}
function writeError(fields) {
    return buildBlock("ERROR", fields.runId, fields.orchestrator, [
        `error_kind: ${fields.errorKind}`,
        `message: ${serializeValue(fields.message)}`,
        `phase: ${serializeValue(fields.phase)}`,
        `phases_executed: ${fields.phasesExecuted}`,
    ]);
}
function writeAborted(fields) {
    return buildBlock("ABORTED", fields.runId, fields.orchestrator, [
        `signal: ${fields.signal}`,
        `phase: ${serializeValue(fields.phase)}`,
    ]);
}
export function writeProtocolBlock(action, fields) {
    switch (action) {
        case "DELEGATE":
            return writeDelegate(fields);
        case "REQUEST_EXTERNAL":
            return writeRequestExternal(fields);
        case "DONE":
            return writeDone(fields);
        case "ERROR":
            return writeError(fields);
        case "ABORTED":
            return writeAborted(fields);
    }
}
function isValidAction(s) {
    return (s === "DELEGATE" ||
        s === "REQUEST_EXTERNAL" ||
        s === "DONE" ||
        s === "ERROR" ||
        s === "ABORTED");
}
function snakeToCamel(s) {
    return s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}
function parseValue(raw) {
    if (raw === "null")
        return null;
    if (raw === "true")
        return true;
    if (raw === "false")
        return false;
    if (/^-?\d+(\.\d+)?$/.test(raw)) {
        const n = Number(raw);
        if (Number.isFinite(n))
            return n;
    }
    if (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) {
        try {
            return JSON.parse(raw);
        }
        catch {
            return raw;
        }
    }
    return raw;
}
function parseKeyValueLine(line) {
    const match = line.match(/^([a-z_][a-z0-9_]*): (.*)$/);
    if (!match)
        return null;
    const key = match[1];
    const rawValue = match[2];
    if (key === undefined || rawValue === undefined)
        return null;
    return { key, value: parseValue(rawValue) };
}
export function parseProtocolBlock(stdout) {
    const lines = stdout.split(/\r?\n/);
    const startIdx = lines.findIndex((l) => l.trim() === "@@TURNLOCK@@");
    if (startIdx === -1)
        return null;
    const endIdx = lines.findIndex((l, i) => i > startIdx && l.trim() === "@@END@@");
    if (endIdx === -1)
        return null;
    const payloadLines = lines.slice(startIdx + 1, endIdx);
    const parsed = {};
    for (const line of payloadLines) {
        if (line.trim() === "")
            continue;
        const result = parseKeyValueLine(line);
        if (result === null)
            return null;
        parsed[result.key] = result.value;
    }
    if (parsed.version !== PROTOCOL_VERSION)
        return null;
    if (typeof parsed.orchestrator !== "string")
        return null;
    if (typeof parsed.action !== "string" || !isValidAction(parsed.action))
        return null;
    if (parsed.run_id !== null && typeof parsed.run_id !== "string")
        return null;
    const { version, run_id, orchestrator, action, ...rest } = parsed;
    const fields = {};
    for (const [k, v] of Object.entries(rest)) {
        fields[snakeToCamel(k)] = v;
    }
    return {
        version: version,
        runId: run_id,
        orchestrator: orchestrator,
        action: action,
        fields,
    };
}
//# sourceMappingURL=protocol.js.map