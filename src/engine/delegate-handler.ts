import * as path from "node:path";
import {
	DEFAULT_BACKOFF_BASE_MS,
	DEFAULT_MAX_ATTEMPTS,
	DEFAULT_MAX_BACKOFF_MS,
	DEFAULT_TIMEOUT_MS,
} from "../constants";
import { InvalidConfigError, ProtocolError } from "../errors/concrete";
import { clock } from "../services/clock";
import type { PendingDelegationRecord, StateFile } from "../services/state-io";
import type {
	BatchDelegationRequest,
	DelegationRequest,
} from "../types/delegation";
import { type DispatchContext, doExit, writeFileSyncAtomic } from "./context";
import { clearPendingYield } from "./pending-yield";
import { selectBinding } from "./shared";
import {
	commitStateWithProjection,
	releaseOwnershipFromContext,
} from "./state-commit";

export async function handleDelegate<S extends object>(
	ctx: DispatchContext<S>,
	state: StateFile<S>,
	result: {
		kind: "delegate";
		request: DelegationRequest;
		resumeAt: string;
		nextState: S;
	},
	accumulatedDurationMs: number,
): Promise<never> {
	const request = result.request;
	const { label, kind } = request;
	const { resumeAt } = result;

	if (!(resumeAt in ctx.config.phases)) {
		throw new ProtocolError(`unknown phase: ${resumeAt}`, {
			runId: ctx.runId,
			orchestratorName: ctx.config.name,
			phase: state.currentPhase,
		});
	}
	if (!/^[a-z][a-z0-9-]*$/.test(label)) {
		throw new ProtocolError(`invalid label format: ${label}`, {
			runId: ctx.runId,
			orchestratorName: ctx.config.name,
			phase: state.currentPhase,
		});
	}
	if (state.usedLabels.includes(label)) {
		throw new ProtocolError(`duplicate label: ${label}`, {
			runId: ctx.runId,
			orchestratorName: ctx.config.name,
			phase: state.currentPhase,
		});
	}

	if (kind === "batch") {
		const req = request as BatchDelegationRequest;
		if (req.jobs.length === 0) {
			throw new InvalidConfigError(`batch delegation '${label}' has no jobs`);
		}
		const ids = new Set<string>();
		for (const job of req.jobs) {
			if (ids.has(job.id)) {
				throw new ProtocolError(`duplicate job id in batch: ${job.id}`, {
					runId: ctx.runId,
					orchestratorName: ctx.config.name,
					phase: state.currentPhase,
				});
			}
			ids.add(job.id);
		}
	}

	const effectiveRetryPolicy = {
		maxAttempts:
			request.retry?.maxAttempts ??
			ctx.config.retry?.maxAttempts ??
			DEFAULT_MAX_ATTEMPTS,
		backoffBaseMs:
			request.retry?.backoffBaseMs ??
			ctx.config.retry?.backoffBaseMs ??
			DEFAULT_BACKOFF_BASE_MS,
		maxBackoffMs:
			request.retry?.maxBackoffMs ??
			ctx.config.retry?.maxBackoffMs ??
			DEFAULT_MAX_BACKOFF_MS,
	};
	const timeoutMs =
		request.timeout?.perDelegationMs ??
		ctx.config.timeout?.perDelegationMs ??
		DEFAULT_TIMEOUT_MS;

	const emittedAtEpochMs = clock.nowEpochMs();
	const emittedAt = clock.nowWallIso();
	const deadlineAtEpochMs = emittedAtEpochMs + timeoutMs;
	const attempt = 0;

	const binding = selectBinding(kind);
	const manifestContext = {
		runId: ctx.runId,
		orchestratorName: ctx.config.name,
		phase: state.currentPhase,
		resumeAt,
		attempt,
		maxAttempts: effectiveRetryPolicy.maxAttempts,
		emittedAt,
		emittedAtEpochMs,
		timeoutMs,
		deadlineAtEpochMs,
		runDir: ctx.runDir,
	};
	const manifest = binding.buildManifest(request, manifestContext);
	const manifestPath = path.join(
		ctx.runDir,
		"delegations",
		`${label}-${attempt}.json`,
	);
	writeFileSyncAtomic(manifestPath, JSON.stringify(manifest));

	const pendingDelegation: PendingDelegationRecord = {
		label,
		kind,
		resumeAt,
		manifestPath,
		emittedAtEpochMs,
		deadlineAtEpochMs,
		attempt,
		effectiveRetryPolicy,
		...(kind === "batch"
			? {
					jobIds: (request as BatchDelegationRequest).jobs.map((j) => j.id),
				}
			: {}),
	};

	const newState: StateFile<S> = {
		...clearPendingYield(state),
		data: result.nextState,
		phasesExecuted: state.phasesExecuted + 1,
		lastTransitionAt: emittedAt,
		lastTransitionAtEpochMs: emittedAtEpochMs,
		accumulatedDurationMs,
		pendingDelegation,
		usedLabels: [...state.usedLabels, label],
	};
	commitStateWithProjection(ctx, newState);

	ctx.logger.emit({
		eventType: "delegation_emit",
		runId: ctx.runId,
		phase: state.currentPhase,
		label,
		kind,
		jobCount:
			kind === "batch" ? (request as BatchDelegationRequest).jobs.length : 1,
		timestamp: emittedAt,
	});

	const resumeCmd = ctx.config.resumeCommand(ctx.runId);
	const block = binding.buildProtocolBlock(manifest, manifestPath, resumeCmd);
	process.stdout.write(block);

	releaseOwnershipFromContext(ctx);
	doExit(0);
}
