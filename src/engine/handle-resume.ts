import * as fs from "node:fs";
import * as path from "node:path";
import {
	DelegationMissingResultError,
	DelegationSchemaError,
	DelegationTimeoutError,
	ProtocolError,
} from "../errors/concrete";
import { clock } from "../services/clock";
import { resolveRetryDecision } from "../services/retry-resolver";
import type { PendingDelegationRecord, StateFile } from "../services/state-io";
import type { DispatchContext } from "./context";
import { reemitDelegationAttempt } from "./delegation-reemit";
import { runDispatchLoop } from "./dispatch-loop";
import { emitFatalError } from "./terminal-handlers";

function buildExpectedResultPaths(
	runDir: string,
	pd: PendingDelegationRecord,
): string[] {
	if (pd.kind === "prompt") {
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
			? pd.kind === "batch"
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
		await reemitDelegationAttempt(
			ctx,
			state,
			pd,
			decision,
			pd.resumeAt,
			"aborted during resume retry sleep",
		);
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

	await runDispatchLoop(ctx, stateForDispatch, {
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
