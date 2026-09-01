import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
const EXTERNAL_EXECUTION_PATH = [
    "src/engine/external-request-handler.ts",
    "src/engine/external-request-resume.ts",
    "src/engine/dispatch-loop.ts",
    "src/engine/phase-io.ts",
];
describe("External Request retry isolation", () => {
    for (const sourcePath of EXTERNAL_EXECUTION_PATH) {
        test(`${sourcePath} does not import or call the delegation retry resolver`, () => {
            const source = readFileSync(join(process.cwd(), sourcePath), "utf-8");
            assert.ok(!source.includes("retry-resolver"));
            assert.ok(!source.includes("resolveRetryDecision"));
        });
    }
});
//# sourceMappingURL=external-request-retry-isolation.test.js.map