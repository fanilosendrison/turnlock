import type { ZodError, ZodSchema } from "zod";

export type ValidationResult<T> =
	| { readonly ok: true; readonly data: T }
	| { readonly ok: false; readonly error: ZodError };

export function validateResult<T>(
	rawJson: unknown,
	schema: ZodSchema<T>,
): ValidationResult<T> {
	const result = schema.safeParse(rawJson);
	if (result.success) return { ok: true, data: result.data };
	return { ok: false, error: result.error };
}

const MAX_SUMMARY_LENGTH = 200;
const ELLIPSIS = "…";

export function summarizeZodError(err: ZodError): string {
	const parts: string[] = [];
	for (const issue of err.issues) {
		const path = issue.path.length === 0 ? "root" : issue.path.join(".");
		parts.push(`${path}: ${issue.code}`);
	}
	const joined = parts.join("; ");
	if (joined.length <= MAX_SUMMARY_LENGTH) return joined;
	return joined.slice(0, MAX_SUMMARY_LENGTH - 1) + ELLIPSIS;
}
