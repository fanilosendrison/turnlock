import type { OrchestratorErrorKind } from "../errors/base";

export interface OrchestratorLogger {
	emit(event: OrchestratorEvent): void;
}

export type OrchestratorEvent =
	| {
			eventType: "orchestrator_start";
			runId: string;
			orchestratorName: string;
			initialPhase: string;
			timestamp: string;
	  }
	| {
			eventType: "phase_start";
			runId: string;
			phase: string;
			attemptCount: number;
			timestamp: string;
	  }
	| {
			eventType: "phase_end";
			runId: string;
			phase: string;
			durationMs: number;
			resultKind: "transition" | "delegate" | "done" | "fail";
			timestamp: string;
	  }
	| {
			eventType: "delegation_emit";
			runId: string;
			phase: string;
			label: string;
			kind: "prompt" | "batch";
			jobCount: number;
			timestamp: string;
	  }
	| {
			eventType: "delegation_result_read";
			runId: string;
			phase: string;
			label: string;
			jobCount: number;
			filesLoaded: number;
			timestamp: string;
	  }
	| {
			eventType: "delegation_validated";
			runId: string;
			phase: string;
			label: string;
			timestamp: string;
	  }
	| {
			eventType: "delegation_validation_failed";
			runId: string;
			phase: string;
			label: string;
			zodErrorSummary: string;
			timestamp: string;
	  }
	| {
			eventType: "retry_scheduled";
			runId: string;
			phase: string;
			label: string;
			attempt: number;
			delayMs: number;
			reason: string;
			timestamp: string;
	  }
	| {
			eventType: "phase_error";
			runId: string;
			phase: string;
			errorKind: OrchestratorErrorKind;
			message: string;
			timestamp: string;
	  }
	| {
			eventType: "lock_conflict";
			runId: string;
			reason: "expired_override" | "stolen_at_release";
			currentOwnerToken?: string;
			timestamp: string;
	  }
	| {
			eventType: "orchestrator_end";
			runId: string;
			orchestratorName: string;
			success: boolean;
			durationMs: number;
			phasesExecuted: number;
			timestamp: string;
	  };
