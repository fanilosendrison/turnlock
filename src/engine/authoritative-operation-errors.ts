/** Build the stable protocol metadata attached to authoritative-operation
 *  errors from the engine context shared by state and ownership operations. */
export function stateOperationErrorOptions(ctx: {
	readonly runId: string;
	readonly config?: {
		readonly name?: string;
	};
	readonly currentPhase?: string | null;
}): {
	runId: string;
	orchestratorName?: string;
	phase?: string;
} {
	const options: {
		runId: string;
		orchestratorName?: string;
		phase?: string;
	} = { runId: ctx.runId };
	if (ctx.config?.name !== undefined) {
		options.orchestratorName = ctx.config.name;
	}
	if (ctx.currentPhase !== null && ctx.currentPhase !== undefined) {
		options.phase = ctx.currentPhase;
	}
	return options;
}

/** Static exhaustiveness guard for closed authoritative result unions. */
export function assertAuthoritativeResultHandled(value: never): never {
	throw new Error(
		`Unhandled authoritative persistence result: ${String(value)}`,
	);
}
