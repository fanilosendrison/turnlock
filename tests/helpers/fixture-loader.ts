import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DelegationManifest } from "../../src/bindings/types.js";
import type { StateFile } from "../../src/services/state-io.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, "..", "fixtures");
export function loadFixture(relativePath: string): string {
	return readFileSync(join(fixturesDir, relativePath), { encoding: "utf-8" });
}
export function loadJsonFixture<T = unknown>(relativePath: string): T {
	return JSON.parse(loadFixture(relativePath)) as T;
}
export function loadStateFixture<S>(relativePath: string): StateFile<S> {
	return loadJsonFixture<StateFile<S>>(relativePath);
}
export function loadManifestFixture(relativePath: string): DelegationManifest {
	return loadJsonFixture<DelegationManifest>(relativePath);
}
