import type { JsonValue } from "../types/external-request";

function isArrayIndex(key: string, length: number): boolean {
	if (!/^(0|[1-9]\d*)$/.test(key)) return false;
	const index = Number(key);
	return Number.isSafeInteger(index) && index >= 0 && index < length;
}

function isJsonValueRecursive(
	value: unknown,
	ancestors: Set<object>,
): value is JsonValue {
	if (value === null) return true;
	if (typeof value === "string" || typeof value === "boolean") return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (typeof value !== "object") return false;
	if (ancestors.has(value)) return false;

	ancestors.add(value);
	try {
		if (Array.isArray(value)) {
			const keys = Reflect.ownKeys(value);
			if (keys.some((key) => typeof key === "symbol")) return false;
			const elementKeys = keys.filter((key) => key !== "length") as string[];
			if (elementKeys.length !== value.length) return false;
			for (const key of elementKeys) {
				if (!isArrayIndex(key, value.length)) return false;
				const descriptor = Object.getOwnPropertyDescriptor(value, key);
				if (
					descriptor === undefined ||
					descriptor.enumerable !== true ||
					!("value" in descriptor) ||
					!isJsonValueRecursive(descriptor.value, ancestors)
				) {
					return false;
				}
			}
			return true;
		}

		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) return false;
		for (const key of Reflect.ownKeys(value)) {
			if (typeof key !== "string") return false;
			const descriptor = Object.getOwnPropertyDescriptor(value, key);
			if (
				descriptor === undefined ||
				descriptor.enumerable !== true ||
				!("value" in descriptor) ||
				!isJsonValueRecursive(descriptor.value, ancestors)
			) {
				return false;
			}
		}
		return true;
	} finally {
		ancestors.delete(value);
	}
}

export function isJsonValue(value: unknown): value is JsonValue {
	return isJsonValueRecursive(value, new Set<object>());
}
