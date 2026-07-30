import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const EXTERNAL_EXECUTION_PATH = [
	"src/engine/external-request-handler.ts",
	"src/engine/external-request-resume.ts",
	"src/engine/dispatch-loop.ts",
	"src/engine/phase-io.ts",
] as const;

describe("External Request retry isolation", () => {
	for (const sourcePath of EXTERNAL_EXECUTION_PATH) {
		test(`${sourcePath} does not import or call the delegation retry resolver`, () => {
			const source = readFileSync(join(process.cwd(), sourcePath), "utf-8");
			expect(source).not.toContain("retry-resolver");
			expect(source).not.toContain("resolveRetryDecision");
		});
	}
});
