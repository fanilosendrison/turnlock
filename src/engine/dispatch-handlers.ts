import * as fs from "node:fs";
import * as path from "node:path";
import type { DelegationManifest } from "../bindings/types";
import {
	DEFAULT_BACKOFF_BASE_MS,
	DEFAULT_MAX_ATTEMPTS,
	DEFAULT_MAX_BACKOFF_MS,
	DEFAULT_TIMEOUT_MS,
} from "../constants";
import { enrich, OrchestratorError } from "../errors/base";
import {
	AbortedError,
	InvalidConfigError,
	PhaseError,
	ProtocolError,
} from "../errors/concrete";
import { abortableSleep } from "../services/abortable-sleep";
import { clock } from "../services/clock";
import { releaseLock } from "../services/lock";
import { writeProtocolBlock } from "../services/protocol";
import {
	type PendingDelegationRecord,
	type StateFile,
	writeStateAtomic,
} from "../services/state-io";
import type {
	AgentBatchDelegationRequest,
	DelegationRequest,
} from "../types/delegation";
import { type DispatchContext, doExit, writeFileSyncAtomic } from "./context";
import { reconstructManifest, selectBinding } from "./shared";

export async function executeRetryBranch<S extends object>(
	ctx: DispatchContext<S>,
	state: StateFile<S>,
	pd: PendingDelegationRecord,
	decision: { retry: true; delayMs: number; reason: string },
	phase: string,
): Promise<never> {
	ctx.logger.emit({
		eventType: "retry_scheduled",
		runId: ctx.runId,
		phase,
		label: pd.label,
		attempt: pd.attempt + 1,
		delayMs: decision.delayMs,
		reason: decision.reason,
		timestamp: clock.nowWallIso(),
	});

	try {
		await abortableSleep(decision.delayMs, ctx.abortController.signal);
	} catch (e) {
		throw new AbortedError("aborted during retry sleep", {
			cause: e,
			runId: ctx.runId,
			phase,
		});
	}

	const oldManifest = JSON.parse(
		fs.readFileSync(pd.manifestPath, "utf-8"),
	) as DelegationManifest;
	const newAttempt = pd.attempt + 1;
	const newEmittedAtEpochMs = clock.nowEpochMs();
	const newEmittedAt = clock.nowWallIso();
	const newDeadlineAtEpochMs = newEmittedAtEpochMs + oldManifest.timeoutMs;
	const newManifestPath = path.join(
		ctx.runDir,
		"delegations",
		`${pd.label}-${newAttempt}.json`,
	);
	const newManifest = reconstructManifest(oldManifest, {
		attempt: newAttempt,
		emittedAt: newEmittedAt,
		emittedAtEpochMs: newEmittedAtEpochMs,
		deadlineAtEpochMs: newDeadlineAtEpochMs,
		label: pd.label,
		runDir: ctx.runDir,
	});

	writeFileSyncAtomic(newManifestPath, JSON.stringify(newManifest));

	const newState: StateFile<S> = {
		...state,
		pendingDelegation: {
			...pd,
			attempt: newAttempt,
			emittedAtEpochMs: newEmittedAtEpochMs,
			deadlineAtEpochMs: newDeadlineAtEpochMs,
			manifestPath: newManifestPath,
		},
		lastTransitionAt: newEmittedAt,
		lastTransitionAtEpochMs: newEmittedAtEpochMs,
	};
	writeStateAtomic(ctx.runDir, newState, ctx.config.stateSchema);

	ctx.logger.emit({
		eventType: "delegation_emit",
		runId: ctx.runId,
		phase,
		label: pd.label,
		kind: pd.kind,
		jobCount: pd.jobIds?.length ?? 1,
		timestamp: newEmittedAt,
	});

	const resumeCmd = ctx.config.resumeCommand(ctx.runId);
	const binding = selectBinding(pd.kind);
	const block = binding.buildProtocolBlock(
		newManifest,
		newManifestPath,
		resumeCmd,
	);
	process.stdout.write(block);

	releaseLock(ctx.lockPath, ctx.handle, clock, ctx.logger, ctx.runId);
	doExit(0);
}

export async function emitFatalError<S extends object>(
	ctx: DispatchContext<S>,
	state: StateFile<S>,
	currentPhase: string,
	err: unknown,
): Promise<never> {
	let wrapped: OrchestratorError;
	if (err instanceof OrchestratorError) {
		wrapped = err;
	} else if (err instanceof Error) {
		wrapped = new PhaseError(err.message.slice(0, 200), { cause: err });
	} else {
		wrapped = new PhaseError(String(err).slice(0, 200));
	}
	enrich(wrapped, {
		runId: ctx.runId,
		orchestratorName: ctx.config.name,
		phase: currentPhase,
	});

	try {
		writeStateAtomic(ctx.runDir, state, ctx.config.stateSchema);
	} catch {
		// silent
	}

	const nowIso = clock.nowWallIso();
	ctx.logger.emit({
		eventType: "phase_error",
		runId: ctx.runId,
		phase: currentPhase,
		errorKind: wrapped.kind,
		message: wrapped.message.slice(0, 200),
		timestamp: nowIso,
	});
	ctx.logger.emit({
		eventType: "orchestrator_end",
		runId: ctx.runId,
		orchestratorName: ctx.config.name,
		success: false,
		durationMs: state.accumulatedDurationMs,
		phasesExecuted: state.phasesExecuted,
		timestamp: nowIso,
	});

	const block = writeProtocolBlock("ERROR", {
		runId: ctx.runId,
		orchestrator: ctx.config.name,
		errorKind: wrapped.kind,
		message: wrapped.message.slice(0, 200),
		phase: currentPhase,
		phasesExecuted: state.phasesExecuted,
	});
	process.stdout.write(block);

	releaseLock(ctx.lockPath, ctx.handle, clock, ctx.logger, ctx.runId);
	doExit(1);
}

export async function handleTransition<S extends object>(
	ctx: DispatchContext<S>,
	state: StateFile<S>,
	result: {
		kind: "transition";
		nextPhase: string;
		nextState: S;
		input?: unknown;
	},
	accumulatedDurationMs: number,
): Promise<StateFile<S>> {
	if (!(result.nextPhase in ctx.config.phases)) {
		throw new ProtocolError(`unknown phase: ${result.nextPhase}`, {
			runId: ctx.runId,
			orchestratorName: ctx.config.name,
			phase: state.currentPhase,
		});
	}

	const nowIso = clock.nowWallIso();
	const nowEpoch = clock.nowEpochMs();

	const newState: StateFile<S> = {
		schemaVersion: 1,
		runId: state.runId,
		orchestratorName: state.orchestratorName,
		startedAt: state.startedAt,
		startedAtEpochMs: state.startedAtEpochMs,
		currentPhase: result.nextPhase,
		data: result.nextState,
		phasesExecuted: state.phasesExecuted + 1,
		lastTransitionAt: nowIso,
		lastTransitionAtEpochMs: nowEpoch,
		accumulatedDurationMs,
		usedLabels: state.usedLabels,
	};

	writeStateAtomic(ctx.runDir, newState, ctx.config.stateSchema);
	return newState;
}

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

	if (kind === "agent-batch") {
		const req = request as AgentBatchDelegationRequest;
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
		...(kind === "agent-batch"
			? {
					jobIds: (request as AgentBatchDelegationRequest).jobs.map(
						(j) => j.id,
					),
				}
			: {}),
	};

	const newState: StateFile<S> = {
		...state,
		data: result.nextState,
		phasesExecuted: state.phasesExecuted + 1,
		lastTransitionAt: emittedAt,
		lastTransitionAtEpochMs: emittedAtEpochMs,
		accumulatedDurationMs,
		pendingDelegation,
		usedLabels: [...state.usedLabels, label],
	};
	writeStateAtomic(ctx.runDir, newState, ctx.config.stateSchema);

	ctx.logger.emit({
		eventType: "delegation_emit",
		runId: ctx.runId,
		phase: state.currentPhase,
		label,
		kind,
		jobCount:
			kind === "agent-batch"
				? (request as AgentBatchDelegationRequest).jobs.length
				: 1,
		timestamp: emittedAt,
	});

	const resumeCmd = ctx.config.resumeCommand(ctx.runId);
	const block = binding.buildProtocolBlock(manifest, manifestPath, resumeCmd);
	process.stdout.write(block);

	releaseLock(ctx.lockPath, ctx.handle, clock, ctx.logger, ctx.runId);
	doExit(0);
}

export async function handleDone<S extends object>(
	ctx: DispatchContext<S>,
	state: StateFile<S>,
	result: { kind: "done"; output: unknown },
	accumulatedDurationMs: number,
): Promise<never> {
	const outputPath = path.join(ctx.runDir, "output.json");
	let serialized: string;
	try {
		serialized = JSON.stringify(result.output);
		if (serialized === undefined) serialized = "null";
	} catch (err) {
		throw new PhaseError(
			`failed to serialize done.output: ${err instanceof Error ? err.message : String(err)}`,
			{
				cause: err,
				runId: ctx.runId,
				orchestratorName: ctx.config.name,
				phase: state.currentPhase,
			},
		);
	}

	// Detect functions/non-serializable content that JSON.stringify silently drops.
	// For `{fn: () => 1}` → serialized is "{}" — we accept this (silent drop per NIB-M-STATE-IO §6).
	try {
		writeFileSyncAtomic(outputPath, serialized);
	} catch (err) {
		throw new PhaseError(
			`failed to write output.json: ${err instanceof Error ? err.message : String(err)}`,
			{
				cause: err,
				runId: ctx.runId,
				orchestratorName: ctx.config.name,
				phase: state.currentPhase,
			},
		);
	}

	const newState: StateFile<S> = {
		schemaVersion: 1,
		runId: state.runId,
		orchestratorName: state.orchestratorName,
		startedAt: state.startedAt,
		startedAtEpochMs: state.startedAtEpochMs,
		currentPhase: state.currentPhase,
		data: state.data,
		phasesExecuted: state.phasesExecuted + 1,
		lastTransitionAt: state.lastTransitionAt,
		lastTransitionAtEpochMs: state.lastTransitionAtEpochMs,
		accumulatedDurationMs,
		usedLabels: state.usedLabels,
	};
	writeStateAtomic(ctx.runDir, newState, ctx.config.stateSchema);

	const endedAt = clock.nowWallIso();
	ctx.logger.emit({
		eventType: "orchestrator_end",
		runId: ctx.runId,
		orchestratorName: ctx.config.name,
		success: true,
		durationMs: accumulatedDurationMs,
		phasesExecuted: newState.phasesExecuted,
		timestamp: endedAt,
	});

	const block = writeProtocolBlock("DONE", {
		runId: ctx.runId,
		orchestrator: ctx.config.name,
		output: outputPath,
		success: true,
		phasesExecuted: newState.phasesExecuted,
		durationMs: accumulatedDurationMs,
	});
	process.stdout.write(block);

	releaseLock(ctx.lockPath, ctx.handle, clock, ctx.logger, ctx.runId);
	doExit(0);
}

export async function handleFail<S extends object>(
	ctx: DispatchContext<S>,
	state: StateFile<S>,
	result: { kind: "fail"; error: Error },
	accumulatedDurationMs: number,
): Promise<never> {
	const errorKind =
		result.error instanceof OrchestratorError
			? result.error.kind
			: "phase_error";

	const newState: StateFile<S> = {
		schemaVersion: 1,
		runId: state.runId,
		orchestratorName: state.orchestratorName,
		startedAt: state.startedAt,
		startedAtEpochMs: state.startedAtEpochMs,
		currentPhase: state.currentPhase,
		data: state.data,
		phasesExecuted: state.phasesExecuted + 1,
		lastTransitionAt: state.lastTransitionAt,
		lastTransitionAtEpochMs: state.lastTransitionAtEpochMs,
		accumulatedDurationMs,
		usedLabels: state.usedLabels,
	};
	writeStateAtomic(ctx.runDir, newState, ctx.config.stateSchema);

	const nowIso = clock.nowWallIso();
	ctx.logger.emit({
		eventType: "phase_error",
		runId: ctx.runId,
		phase: state.currentPhase,
		errorKind,
		message: result.error.message.slice(0, 200),
		timestamp: nowIso,
	});
	ctx.logger.emit({
		eventType: "orchestrator_end",
		runId: ctx.runId,
		orchestratorName: ctx.config.name,
		success: false,
		durationMs: accumulatedDurationMs,
		phasesExecuted: newState.phasesExecuted,
		timestamp: nowIso,
	});

	const block = writeProtocolBlock("ERROR", {
		runId: ctx.runId,
		orchestrator: ctx.config.name,
		errorKind,
		message: result.error.message.slice(0, 200),
		phase: state.currentPhase,
		phasesExecuted: newState.phasesExecuted,
	});
	process.stdout.write(block);

	releaseLock(ctx.lockPath, ctx.handle, clock, ctx.logger, ctx.runId);
	doExit(1);
}
