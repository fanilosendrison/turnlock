import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, test } from "node:test";
const TEST_ROOT = resolve(process.cwd(), "tests");
const FORBIDDEN_TERMS = [
    { label: "focused test marker", term: [".", "only", "("].join("") },
    { label: "disabled test marker", term: [".", "skip", "("].join("") },
    { label: "todo test marker", term: ["test", ".", "todo"].join("") },
    { label: "todo describe marker", term: ["describe", ".", "todo"].join("") },
    { label: "todo it marker", term: ["it", ".", "todo"].join("") },
    {
        label: "unfinished implementation text",
        term: ["Not", " implemented"].join(""),
    },
    { label: "dead run harness", term: ["create", "RunHarness"].join("") },
    {
        label: "truthy sentinel assertion",
        term: ["expect", "(true).toBe(true)"].join(""),
    },
    { label: "placeholder label", term: ["st", "ub"].join("") },
];
const ASSERTION_SIGNALS = [
    "assert.",
    "protocolAsserts.",
    "eventAsserts.",
    "expectProtocol(",
];
function collectTestFiles(dir) {
    const files = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === "fixtures")
                continue;
            files.push(...collectTestFiles(fullPath));
            continue;
        }
        if (entry.isFile() && entry.name.endsWith(".test.ts")) {
            files.push(fullPath);
        }
    }
    return files.sort();
}
describe("test suite integrity", () => {
    test("active tests do not contain disabled markers or known placeholders", () => {
        const violations = [];
        for (const filePath of collectTestFiles(TEST_ROOT)) {
            const content = readFileSync(filePath, "utf-8");
            for (const forbidden of FORBIDDEN_TERMS) {
                if (content.includes(forbidden.term)) {
                    violations.push(`${filePath}: ${forbidden.label}`);
                }
            }
        }
        assert.deepStrictEqual(violations, []);
    });
    test("protocol fixture hashes match the migration parity manifest", () => {
        const parity = JSON.parse(readFileSync(join(process.cwd(), "docs", "migrations", "node-pnpm", "test-parity.json"), "utf8"));
        for (const [relativePath, expectedHash] of Object.entries(parity.protocolFixtures)) {
            const content = readFileSync(join(process.cwd(), relativePath));
            const actualHash = createHash("sha256").update(content).digest("hex");
            assert.strictEqual(actualHash, expectedHash, relativePath);
        }
    });
    test("NIB-tagged test files contain direct or helper assertions", () => {
        const nibMarker = ["NIB", "-T"].join("");
        const violations = [];
        for (const filePath of collectTestFiles(TEST_ROOT)) {
            const content = readFileSync(filePath, "utf-8");
            if (!content.includes(nibMarker))
                continue;
            const hasAssertion = ASSERTION_SIGNALS.some((signal) => content.includes(signal));
            if (!hasAssertion) {
                violations.push(filePath);
            }
        }
        assert.deepStrictEqual(violations, []);
    });
});
//# sourceMappingURL=test-integrity.test.js.map