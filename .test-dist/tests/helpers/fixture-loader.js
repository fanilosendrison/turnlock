import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, "..", "fixtures");
export function loadFixture(relativePath) {
    return readFileSync(join(fixturesDir, relativePath), { encoding: "utf-8" });
}
export function loadJsonFixture(relativePath) {
    return JSON.parse(loadFixture(relativePath));
}
export function loadStateFixture(relativePath) {
    return loadJsonFixture(relativePath);
}
export function loadManifestFixture(relativePath) {
    return loadJsonFixture(relativePath);
}
//# sourceMappingURL=fixture-loader.js.map