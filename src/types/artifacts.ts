// Artifact references and records — used by artifact-store to decouple
// blob installation from authority-bearing commits.
//
// Every handler-produced content is installed as an immutable blob first,
// then referenced via ArtifactRef in the authoritative SQLite state.  Only
// after a successful fenced commit is a canonical projection emitted.

export type ArtifactKind =
	| "terminal-output"
	| "delegation-manifest"
	| "external-request-manifest";

export interface ArtifactRef {
	readonly kind: ArtifactKind;
	readonly digestAlgorithm: "sha256";
	/** Full content digest, e.g. "sha256:3fc7f2...91" */
	readonly digest: string;
	/** Immutable blob path relative to RUN_DIR, e.g.
	 *  "artifacts/sha256/3f/3fc7f2...91.json" */
	readonly relativePath: string;
	readonly mediaType: "application/json";
	readonly sizeBytes: number;
}

/** Record stored in state when the orchestrator terminates with "done". */
export interface TerminalDoneRecord {
	readonly kind: "done";
	readonly outputArtifact: ArtifactRef;
	readonly completedAt: string;
	readonly completedAtEpochMs: number;
}

/** A serialized artifact ready for immutable installation. */
export interface PreparedArtifact {
	readonly ref: ArtifactRef;
	readonly bytes: Uint8Array;
}
