export function validateResult(rawJson, schema) {
    const result = schema.safeParse(rawJson);
    if (result.success)
        return { ok: true, data: result.data };
    return { ok: false, error: result.error };
}
const MAX_SUMMARY_LENGTH = 200;
const ELLIPSIS = "…";
export function summarizeZodError(err) {
    const parts = [];
    for (const issue of err.issues) {
        const path = issue.path.length === 0 ? "root" : issue.path.join(".");
        parts.push(`${path}: ${issue.code}`);
    }
    const joined = parts.join("; ");
    if (joined.length <= MAX_SUMMARY_LENGTH)
        return joined;
    return joined.slice(0, MAX_SUMMARY_LENGTH - 1) + ELLIPSIS;
}
//# sourceMappingURL=validator.js.map