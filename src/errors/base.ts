export type OrchestratorErrorKind =
	| "invalid_config"
	| "state_corrupted"
	| "state_missing"
	| "state_version_mismatch"
	| "delegation_timeout"
	| "delegation_schema"
	| "delegation_missing_result"
	| "external_resolution_missing"
	| "external_resolution_schema"
	| "external_resolution_malformed"
	| "phase_error"
	| "protocol"
	| "aborted"
	| "run_locked"
	| "authority_lost"
	| "state_revision_conflict"
	| "persistence_failure"
	| "artifact_integrity";

export interface OrchestratorErrorOptions {
	readonly cause?: unknown;
	readonly runId?: string;
	readonly orchestratorName?: string;
	readonly phase?: string;
}

export abstract class OrchestratorError extends Error {
	abstract readonly kind: OrchestratorErrorKind;
	runId?: string;
	orchestratorName?: string;
	phase?: string;

	constructor(message: string, options?: OrchestratorErrorOptions) {
		super(
			message,
			options?.cause !== undefined ? { cause: options.cause } : undefined,
		);
		this.name = this.constructor.name;
		if (options?.runId !== undefined) this.runId = options.runId;
		if (options?.orchestratorName !== undefined)
			this.orchestratorName = options.orchestratorName;
		if (options?.phase !== undefined) this.phase = options.phase;
	}
}

export function enrich<E extends OrchestratorError>(
	err: E,
	ctx: {
		readonly runId?: string;
		readonly orchestratorName?: string;
		readonly phase?: string;
	},
): E {
	if (err.runId === undefined && ctx.runId !== undefined) {
		err.runId = ctx.runId;
	}
	if (
		err.orchestratorName === undefined &&
		ctx.orchestratorName !== undefined
	) {
		err.orchestratorName = ctx.orchestratorName;
	}
	if (err.phase === undefined && ctx.phase !== undefined) {
		err.phase = ctx.phase;
	}
	return err;
}
