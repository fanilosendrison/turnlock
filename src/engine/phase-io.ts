import type { ZodSchema } from "zod";
import {
	DelegationMissingResultError,
	DelegationSchemaError,
	ExternalResolutionMissingError,
	ExternalResolutionSchemaError,
	ProtocolError,
} from "../errors/concrete";
import { clock } from "../services/clock";
import type {
	PendingDelegationRecord,
	PendingExternalRequestRecord,
} from "../services/state-io";
import { summarizeZodError, validateResult } from "../services/validator";
import type { PhaseIO, PhaseResult } from "../types/phase";
import type { DispatchContext, LoadedResults } from "./context";
import { assertExternalRequest } from "./external-request-validation";
import { refreshOwnershipFromContext } from "./state-commit";

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
	pendingExternalAtEntry: PendingExternalRequestRecord | undefined;
	usedLabelsAtEntry: readonly string[];
	guards: PhaseIOGuards;
}): PhaseIO<S> {
	const {
		ctx,
		currentPhase,
		loadedResults,
		pendingAtEntry,
		pendingExternalAtEntry,
		usedLabelsAtEntry,
		guards,
	} = args;

	function errorContext() {
		return {
			runId: ctx.runId,
			orchestratorName: ctx.config.name,
			phase: currentPhase,
		};
	}

	function guardCommitted(): void {
		if (guards.committed.value) {
			throw new ProtocolError("PhaseResult already committed", errorContext());
		}
	}

	function commit<Output = void>(
		result: PhaseResult<S, Output>,
	): PhaseResult<S, Output> {
		guards.committed.value = true;
		guards.committedResult.value = result as PhaseResult<object>;
		return result;
	}

	function assertPendingDelegation(): PendingDelegationRecord {
		if (!pendingAtEntry) {
			if (pendingExternalAtEntry) {
				throw new ProtocolError(
					"pending external request cannot be consumed as a delegation",
					errorContext(),
				);
			}
			throw new ProtocolError(
				"no pending delegation to consume",
				errorContext(),
			);
		}
		return pendingAtEntry;
	}

	function assertPendingExternal(): PendingExternalRequestRecord {
		if (!pendingExternalAtEntry) {
			if (pendingAtEntry) {
				throw new ProtocolError(
					"pending delegation cannot be consumed as an external resolution",
					errorContext(),
				);
			}
			throw new ExternalResolutionMissingError(
				"no pending external resolution to consume",
				errorContext(),
			);
		}
		return pendingExternalAtEntry;
	}

	function guardSingleConsume(label: string, subject: string): void {
		if (guards.consumedCount.value >= 1) {
			throw new ProtocolError(
				`multiple consume calls on same ${subject}: ${label}`,
				errorContext(),
			);
		}
	}

	return {
		delegate(request, resumeAt, nextState) {
			guardCommitted();
			return commit({ kind: "delegate", request, resumeAt, nextState });
		},
		delegateBatch(request, resumeAt, nextState) {
			guardCommitted();
			return commit({ kind: "delegate", request, resumeAt, nextState });
		},
		requestExternal(request, resumeAt, nextState) {
			guardCommitted();
			assertExternalRequest(request, errorContext());
			if (!(resumeAt in ctx.config.phases)) {
				throw new ProtocolError(`unknown phase: ${resumeAt}`, errorContext());
			}
			if (usedLabelsAtEntry.includes(request.label)) {
				throw new ProtocolError(
					"duplicate external request label",
					errorContext(),
				);
			}
			return commit({
				kind: "external-request",
				request,
				resumeAt,
				nextState,
			});
		},
		done<FinalOutput>(output: FinalOutput): PhaseResult<S, FinalOutput> {
			guardCommitted();
			return commit({ kind: "done", output });
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
			const pd = assertPendingDelegation();
			if (pd.kind === "batch") {
				throw new ProtocolError(
					"use consumePendingBatchResults for batch delegations",
					errorContext(),
				);
			}
			guardSingleConsume(pd.label, "delegation");
			if (
				!loadedResults ||
				loadedResults.kind !== "prompt" ||
				loadedResults.label !== pd.label
			) {
				throw new DelegationMissingResultError(
					`result file missing for ${pd.label}`,
					errorContext(),
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
					{ cause: validation.error, ...errorContext() },
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
			const pd = assertPendingDelegation();
			if (pd.kind !== "batch") {
				throw new ProtocolError(
					"use consumePendingResult for single delegations",
					errorContext(),
				);
			}
			guardSingleConsume(pd.label, "delegation");
			if (
				!loadedResults ||
				loadedResults.kind !== "batch" ||
				loadedResults.label !== pd.label
			) {
				throw new DelegationMissingResultError(
					`result files missing for ${pd.label}`,
					errorContext(),
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
						{ cause: validation.error, ...errorContext() },
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

		consumePendingExternalResolution<T>(schema: ZodSchema<T>): T {
			const pending = assertPendingExternal();
			guardSingleConsume(pending.label, "external resolution");
			if (
				!loadedResults ||
				loadedResults.kind !== "external-request" ||
				loadedResults.label !== pending.label
			) {
				throw new ExternalResolutionMissingError(
					"external resolution is not loaded",
					errorContext(),
				);
			}
			guards.consumedCount.value++;
			const validation = validateResult(loadedResults.data, schema);
			if (!validation.ok) {
				ctx.logger.emit({
					eventType: "external_resolution_validation_failed",
					runId: ctx.runId,
					phase: currentPhase,
					label: pending.label,
					requestId: pending.requestId,
					requestType: pending.requestType,
					reason: "schema_invalid",
					timestamp: clock.nowWallIso(),
				});
				throw new ExternalResolutionSchemaError(
					"external resolution failed schema validation",
					{ cause: validation.error, ...errorContext() },
				);
			}
			ctx.logger.emit({
				eventType: "external_resolution_validated",
				runId: ctx.runId,
				phase: currentPhase,
				label: pending.label,
				requestId: pending.requestId,
				requestType: pending.requestType,
				timestamp: clock.nowWallIso(),
			});
			return validation.data;
		},

		refreshLock(): void {
			refreshOwnershipFromContext(ctx);
		},
	};
}
