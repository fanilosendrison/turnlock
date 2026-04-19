import type { ZodSchema } from "zod";
import {
	DelegationMissingResultError,
	DelegationSchemaError,
	ProtocolError,
} from "../errors/concrete";
import { clock } from "../services/clock";
import { refreshLock } from "../services/lock";
import type { PendingDelegationRecord } from "../services/state-io";
import { summarizeZodError, validateResult } from "../services/validator";
import type { PhaseIO, PhaseResult } from "../types/phase";
import type { DispatchContext, LoadedResults } from "./context";

export interface PhaseIOGuards {
	readonly committed: { value: boolean };
	readonly committedResult: { value: PhaseResult<object> | null };
	readonly consumedCount: { value: number };
}

export function buildPhaseIO<S extends object>(args: {
	ctx: DispatchContext<S>;
	currentPhase: string;
	loadedResults: LoadedResults | undefined;
	pendingAtEntry: PendingDelegationRecord | undefined;
	guards: PhaseIOGuards;
}): PhaseIO<S> {
	const { ctx, currentPhase, loadedResults, pendingAtEntry, guards } = args;

	function guardCommitted(): void {
		if (guards.committed.value) {
			throw new ProtocolError("PhaseResult already committed", {
				runId: ctx.runId,
				orchestratorName: ctx.config.name,
				phase: currentPhase,
			});
		}
	}

	function commit(result: PhaseResult<S>): PhaseResult<S> {
		guards.committed.value = true;
		guards.committedResult.value = result as PhaseResult<object>;
		return result;
	}

	function assertPending(): PendingDelegationRecord {
		if (!pendingAtEntry) {
			throw new ProtocolError("no pending delegation to consume", {
				runId: ctx.runId,
				orchestratorName: ctx.config.name,
				phase: currentPhase,
			});
		}
		return pendingAtEntry;
	}

	return {
		transition<NextInput = void>(
			nextPhase: string,
			nextState: S,
			input?: NextInput,
		): PhaseResult<S> {
			guardCommitted();
			return commit(
				input === undefined
					? { kind: "transition", nextPhase, nextState }
					: { kind: "transition", nextPhase, nextState, input },
			);
		},
		delegateSkill(request, resumeAt, nextState) {
			guardCommitted();
			return commit({ kind: "delegate", request, resumeAt, nextState });
		},
		delegateAgent(request, resumeAt, nextState) {
			guardCommitted();
			return commit({ kind: "delegate", request, resumeAt, nextState });
		},
		delegateAgentBatch(request, resumeAt, nextState) {
			guardCommitted();
			return commit({ kind: "delegate", request, resumeAt, nextState });
		},
		done<FinalOutput>(output: FinalOutput): PhaseResult<S> {
			guardCommitted();
			return commit({ kind: "done", output } as PhaseResult<S>);
		},
		fail(error: Error): PhaseResult<S> {
			guardCommitted();
			return commit({ kind: "fail", error });
		},
		logger: ctx.logger,
		clock,
		runId: ctx.runId,
		args: process.argv.slice(2),
		runDir: ctx.runDir,
		signal: ctx.abortController.signal,

		consumePendingResult<T>(schema: ZodSchema<T>): T {
			const pd = assertPending();
			if (pd.kind === "agent-batch") {
				throw new ProtocolError(
					"use consumePendingBatchResults for batch delegations",
					{
						runId: ctx.runId,
						orchestratorName: ctx.config.name,
						phase: currentPhase,
					},
				);
			}
			if (guards.consumedCount.value >= 1) {
				throw new ProtocolError(
					`multiple consume calls on same delegation: ${pd.label}`,
					{
						runId: ctx.runId,
						orchestratorName: ctx.config.name,
						phase: currentPhase,
					},
				);
			}
			if (!loadedResults) {
				throw new DelegationMissingResultError(
					`result file missing for ${pd.label}`,
					{
						runId: ctx.runId,
						orchestratorName: ctx.config.name,
						phase: currentPhase,
					},
				);
			}
			guards.consumedCount.value++;
			const validation = validateResult(loadedResults.data, schema);
			if (!validation.ok) {
				ctx.logger.emit({
					eventType: "delegation_validation_failed",
					runId: ctx.runId,
					phase: currentPhase,
					label: pd.label,
					zodErrorSummary: summarizeZodError(validation.error),
					timestamp: clock.nowWallIso(),
				});
				throw new DelegationSchemaError(
					`validation failed for ${pd.label}: ${summarizeZodError(validation.error)}`,
					{
						cause: validation.error,
						runId: ctx.runId,
						orchestratorName: ctx.config.name,
						phase: currentPhase,
					},
				);
			}
			ctx.logger.emit({
				eventType: "delegation_validated",
				runId: ctx.runId,
				phase: currentPhase,
				label: pd.label,
				timestamp: clock.nowWallIso(),
			});
			return validation.data;
		},

		consumePendingBatchResults<T>(schema: ZodSchema<T>): readonly T[] {
			const pd = assertPending();
			if (pd.kind !== "agent-batch") {
				throw new ProtocolError(
					"use consumePendingResult for single delegations",
					{
						runId: ctx.runId,
						orchestratorName: ctx.config.name,
						phase: currentPhase,
					},
				);
			}
			if (guards.consumedCount.value >= 1) {
				throw new ProtocolError(
					`multiple consume calls on same delegation: ${pd.label}`,
					{
						runId: ctx.runId,
						orchestratorName: ctx.config.name,
						phase: currentPhase,
					},
				);
			}
			if (!loadedResults) {
				throw new DelegationMissingResultError(
					`result files missing for ${pd.label}`,
					{
						runId: ctx.runId,
						orchestratorName: ctx.config.name,
						phase: currentPhase,
					},
				);
			}
			guards.consumedCount.value++;
			const rawArray = loadedResults.data as readonly unknown[];
			const validated: T[] = [];
			for (const raw of rawArray) {
				const validation = validateResult(raw, schema);
				if (!validation.ok) {
					ctx.logger.emit({
						eventType: "delegation_validation_failed",
						runId: ctx.runId,
						phase: currentPhase,
						label: pd.label,
						zodErrorSummary: summarizeZodError(validation.error),
						timestamp: clock.nowWallIso(),
					});
					throw new DelegationSchemaError(
						`validation failed for ${pd.label}: ${summarizeZodError(validation.error)}`,
						{
							cause: validation.error,
							runId: ctx.runId,
							orchestratorName: ctx.config.name,
							phase: currentPhase,
						},
					);
				}
				validated.push(validation.data);
			}
			ctx.logger.emit({
				eventType: "delegation_validated",
				runId: ctx.runId,
				phase: currentPhase,
				label: pd.label,
				timestamp: clock.nowWallIso(),
			});
			return validated;
		},

		refreshLock(): void {
			refreshLock(ctx.lockPath, ctx.handle, clock, ctx.logger, ctx.runId);
		},
	};
}
