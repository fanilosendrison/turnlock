import * as fs from "node:fs";
import * as path from "node:path";
import { agentBinding } from "../bindings/agent";
import { agentBatchBinding } from "../bindings/agent-batch";
import { skillBinding } from "../bindings/skill";
import type { DelegationBinding, DelegationManifest } from "../bindings/types";
import {
	AbortedError,
	DelegationMissingResultError,
	DelegationSchemaError,
	DelegationTimeoutError,
	ProtocolError,
} from "../errors/concrete";
import { abortableSleep } from "../services/abortable-sleep";
import { clock } from "../services/clock";
import { releaseLock } from "../services/lock";
import { resolveRetryDecision } from "../services/retry-resolver";
import {
	type PendingDelegationRecord,
	type StateFile,
	writeStateAtomic,
} from "../services/state-io";
import type { DelegationRequest } from "../types/delegation";
import { type DispatchContext, doExit, writeFileSyncAtomic } from "./context";
import { emitFatalError, runDispatchLoop } from "./dispatch-loop";

function selectBinding(
	kind: "skill" | "agent" | "agent-batch",
): DelegationBinding<DelegationRequest> {
	switch (kind) {
		case "skill":
			return skillBinding as DelegationBinding<DelegationRequest>;
		case "agent":
			return agentBinding as DelegationBinding<DelegationRequest>;
		case "agent-batch":
			return agentBatchBinding as DelegationBinding<DelegationRequest>;
	}
}

function reconstructManifest(
	old: DelegationManifest,
	updates: {
		attempt: number;
		emittedAt: string;
		emittedAtEpochMs: number;
		deadlineAtEpochMs: number;
		label: string;
		runDir: string;
	},
): DelegationManifest {
	const base: DelegationManifest = {
		...old,
		attempt: updates.attempt,
		emittedAt: updates.emittedAt,
		emittedAtEpochMs: updates.emittedAtEpochMs,
		deadlineAtEpochMs: updates.deadlineAtEpochMs,
	};
	if (old.kind === "skill" || old.kind === "agent") {
		return {
			...base,
			resultPath: path.join(
				updates.runDir,
				"results",
				`${updates.label}-${updates.attempt}.json`,
			),
		};
	}
	return {
		...base,
		jobs: (old.jobs ?? []).map((j) => ({
			...j,
			resultPath: path.join(
				updates.runDir,
				"results",
				`${updates.label}-${updates.attempt}`,
				`${j.id}.json`,
			),
		})),
	};
}

function buildExpectedResultPaths(
	runDir: string,
	pd: PendingDelegationRecord,
): string[] {
	if (pd.kind === "skill" || pd.kind === "agent") {
		return [path.join(runDir, "results", `${pd.label}-${pd.attempt}.json`)];
	}
	const batchDir = path.join(runDir, "results", `${pd.label}-${pd.attempt}`);
	return (pd.jobIds ?? []).map((id) => path.join(batchDir, `${id}.json`));
}

interface Classification {
	readonly allPresent: boolean;
	readonly allParseable: boolean;
	readonly anyMalformed: boolean;
	readonly loadedData: unknown | readonly unknown[] | null;
}

function classifyResultFiles(
	runDir: string,
	pd: PendingDelegationRecord,
): Classification {
	const paths = buildExpectedResultPaths(runDir, pd);
	let allPresent = true;
	let anyMalformed = false;
	const parsedValues: unknown[] = [];

	for (const p of paths) {
		if (!fs.existsSync(p)) {
			allPresent = false;
			continue;
		}
		let raw: string;
		try {
			raw = fs.readFileSync(p, "utf-8");
		} catch {
			anyMalformed = true;
			continue;
		}
		try {
			parsedValues.push(JSON.parse(raw));
		} catch {
			anyMalformed = true;
		}
	}

	const allParseable =
		allPresent && !anyMalformed && parsedValues.length === paths.length;
	return {
		allPresent,
		allParseable,
		anyMalformed,
		loadedData: allParseable
			? pd.kind === "agent-batch"
				? parsedValues
				: (parsedValues[0] ?? null)
			: null,
	};
}

function findFirstMalformedPath(
	runDir: string,
	pd: PendingDelegationRecord,
): string | null {
	const paths = buildExpectedResultPaths(runDir, pd);
	for (const p of paths) {
		if (!fs.existsSync(p)) continue;
		try {
			JSON.parse(fs.readFileSync(p, "utf-8"));
		} catch {
			return p;
		}
	}
	return null;
}

function safeFileSize(p: string): number {
	try {
		return fs.statSync(p).size;
	} catch {
		return -1;
	}
}

async function executeResumeRetry<S extends object>(
	ctx: DispatchContext<S>,
	state: StateFile<S>,
	pd: PendingDelegationRecord,
	decision: { retry: true; delayMs: number; reason: string },
): Promise<never> {
	ctx.logger.emit({
		eventType: "retry_scheduled",
		runId: ctx.runId,
		phase: pd.resumeAt,
		label: pd.label,
		attempt: pd.attempt + 1,
		delayMs: decision.delayMs,
		reason: decision.reason,
		timestamp: clock.nowWallIso(),
	});

	try {
		await abortableSleep(decision.delayMs, ctx.abortController.signal);
	} catch (e) {
		throw new AbortedError("aborted during resume retry sleep", {
			cause: e,
			runId: ctx.runId,
			phase: pd.resumeAt,
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
		phase: pd.resumeAt,
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

async function handleDelegationError<S extends object>(
	ctx: DispatchContext<S>,
	state: StateFile<S>,
	pd: PendingDelegationRecord,
	kind: "delegation_timeout" | "delegation_schema",
	message: string,
): Promise<never> {
	const ErrClass =
		kind === "delegation_timeout"
			? DelegationTimeoutError
			: DelegationSchemaError;
	const err = new ErrClass(message, {
		runId: ctx.runId,
		orchestratorName: ctx.config.name,
		phase: pd.resumeAt,
	});

	if (kind === "delegation_schema") {
		const malformedPath = findFirstMalformedPath(ctx.runDir, pd);
		if (malformedPath) {
			const sizeBytes = safeFileSize(malformedPath);
			ctx.logger.emit({
				eventType: "delegation_validation_failed",
				runId: ctx.runId,
				phase: pd.resumeAt,
				label: pd.label,
				zodErrorSummary:
					`malformed JSON (path=${malformedPath}, fileSizeBytes=${sizeBytes})`.slice(
						0,
						200,
					),
				timestamp: clock.nowWallIso(),
			});
		}
	}

	const decision = resolveRetryDecision(
		err,
		pd.attempt,
		pd.effectiveRetryPolicy,
	);
	if (decision.retry === true) {
		await executeResumeRetry(ctx, state, pd, decision);
		return undefined as never;
	}

	await emitFatalError(ctx, state, state.currentPhase, err);
	return undefined as never;
}

async function enterDispatchLoopWithResults<S extends object>(
	ctx: DispatchContext<S>,
	state: StateFile<S>,
	pd: PendingDelegationRecord,
	loadedData: unknown | readonly unknown[] | null,
): Promise<never> {
	const jobCount = pd.jobIds?.length ?? 1;
	const filesLoaded = Array.isArray(loadedData) ? loadedData.length : 1;
	ctx.logger.emit({
		eventType: "delegation_result_read",
		runId: ctx.runId,
		phase: pd.resumeAt,
		label: pd.label,
		jobCount,
		filesLoaded,
		timestamp: clock.nowWallIso(),
	});

	const stateForDispatch: StateFile<S> = {
		...state,
		currentPhase: pd.resumeAt,
	};

	await runDispatchLoop(ctx, stateForDispatch, undefined, {
		label: pd.label,
		kind: pd.kind,
		data: loadedData as unknown | readonly unknown[],
	});
	return undefined as never;
}

export async function runHandleResume<S extends object>(
	ctx: DispatchContext<S>,
	state: StateFile<S>,
): Promise<never> {
	const pd = state.pendingDelegation;
	if (!pd) {
		throw new ProtocolError("resume without pending delegation", {
			runId: ctx.runId,
			orchestratorName: ctx.config.name,
		});
	}

	const classification = classifyResultFiles(ctx.runDir, pd);
	const nowEpoch = clock.nowEpochMs();
	const deadlinePassed = nowEpoch > pd.deadlineAtEpochMs;

	if (classification.allParseable) {
		await enterDispatchLoopWithResults(
			ctx,
			state,
			pd,
			classification.loadedData,
		);
		return undefined as never;
	}

	if (classification.anyMalformed) {
		await handleDelegationError(
			ctx,
			state,
			pd,
			"delegation_schema",
			"malformed JSON in result file",
		);
		return undefined as never;
	}

	if (!classification.allPresent && deadlinePassed) {
		await handleDelegationError(
			ctx,
			state,
			pd,
			"delegation_timeout",
			`deadline passed for ${pd.label}`,
		);
		return undefined as never;
	}

	if (!classification.allPresent && !deadlinePassed) {
		await emitFatalError(
			ctx,
			state,
			pd.resumeAt,
			new DelegationMissingResultError(
				`result file missing for ${pd.label} (deadline not passed)`,
				{
					runId: ctx.runId,
					orchestratorName: ctx.config.name,
					phase: pd.resumeAt,
				},
			),
		);
		return undefined as never;
	}

	throw new ProtocolError("classification inconsistent", {
		runId: ctx.runId,
		orchestratorName: ctx.config.name,
		phase: pd.resumeAt,
	});
}
