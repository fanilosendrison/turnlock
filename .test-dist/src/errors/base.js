export class OrchestratorError extends Error {
    runId;
    orchestratorName;
    phase;
    constructor(message, options) {
        super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
        this.name = this.constructor.name;
        if (options?.runId !== undefined)
            this.runId = options.runId;
        if (options?.orchestratorName !== undefined)
            this.orchestratorName = options.orchestratorName;
        if (options?.phase !== undefined)
            this.phase = options.phase;
    }
}
export function enrich(err, ctx) {
    if (err.runId === undefined && ctx.runId !== undefined) {
        err.runId = ctx.runId;
    }
    if (err.orchestratorName === undefined &&
        ctx.orchestratorName !== undefined) {
        err.orchestratorName = ctx.orchestratorName;
    }
    if (err.phase === undefined && ctx.phase !== undefined) {
        err.phase = ctx.phase;
    }
    return err;
}
//# sourceMappingURL=base.js.map