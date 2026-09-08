import { ProtocolError } from "../errors/concrete.js";
import { releaseOwnership } from "../persistence/sqlite/ownership.js";
import type { OrchestratorConfig } from "../types/config.js";
import type { DispatchContext } from "./context.js";
import { runHandleResume } from "./handle-resume.js";
import type { ParsedArgv } from "./preflight.js";
import type { RunOrchestratorInternalDependencies } from "./run-orchestrator-contracts.js";
import { setupResumeAuthority } from "./run-orchestrator-resume-authority.js";
import { prepareResumeState } from "./run-orchestrator-resume-state.js";
import { installSignalHandlers } from "./signal-handlers.js";

/** Coordinate resume setup and dispatch while retaining one cleanup owner for
 *  every failure after authoritative ownership has been established. */
export async function runResumeMode<S extends object>(
	config: OrchestratorConfig<S>,
	argv: ParsedArgv,
	dependencies: RunOrchestratorInternalDependencies,
): Promise<void> {
	const authority = setupResumeAuthority(config, argv);
	const { runId, runDir, logger, namespaceMutex } = authority;
	if (authority.runDb === null || authority.handle === null) {
		throw new ProtocolError(
			"internal error: resume artifacts missing after setup",
			{ runId, orchestratorName: config.name },
		);
	}
	const runDb = authority.runDb;
	const handle = authority.handle;
	try {
		const prepared = prepareResumeState({
			config,
			runId,
			runDir,
			runDb,
			handle,
			logger,
			dependencies,
		});
		// Canonical setup is complete. Never hold the namespace mutex during
		// phase execution; subsequent writes are independently fenced.
		namespaceMutex.release();
		const ctx: DispatchContext<S> = {
			config,
			runId,
			runDir,
			runDb,
			handle,
			logger,
			abortController: new AbortController(),
			currentPhase: prepared.state.currentPhase,
			phasesExecuted: prepared.state.phasesExecuted,
			accumulatedDurationMs: prepared.state.accumulatedDurationMs,
			stateRevision: prepared.stateRevision,
		};
		installSignalHandlers(ctx);
		await runHandleResume(ctx, prepared.state, prepared.pendingInitialDispatch);
	} catch (primaryError) {
		const releaseResult = releaseOwnership({ db: runDb.connection, handle });
		runDb.close();
		namespaceMutex.rollbackAndRelease();
		if (
			releaseResult.kind !== "SUCCESS" &&
			releaseResult.kind !== "STALE_HANDLE"
		) {
			process.stderr.write(
				`[turnlock] ownership release failed: ${releaseResult.kind}` +
					(releaseResult.kind === "DB_FAILURE"
						? ` (${String(releaseResult.cause)})`
						: "") +
					"\n",
			);
		}
		throw primaryError;
	}
}
