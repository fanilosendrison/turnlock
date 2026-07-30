import * as fs from "node:fs";
import * as path from "node:path";
import {
	type ExternalRequestManifest,
	externalRequestBinding,
	isExternalRequestManifest,
} from "../bindings/external-request";
import {
	ExternalResolutionMalformedError,
	StateCorruptedError,
} from "../errors/concrete";
import { clock } from "../services/clock";
import { releaseLock } from "../services/lock";
import type {
	PendingExternalRequestRecord,
	StateFile,
} from "../services/state-io";
import type { DispatchContext } from "./context";
import { doExit } from "./context";
import { runDispatchLoop } from "./dispatch-loop";
import { emitFatalError } from "./terminal-handlers";

function isMissingFileError(error: unknown): boolean {
	return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function assertConfinedPaths<S extends object>(
	ctx: DispatchContext<S>,
	pending: PendingExternalRequestRecord,
): void {
	const expectedManifestPath = path.join(
		ctx.runDir,
		"external-requests",
		`${pending.label}.json`,
	);
	const expectedResultPath = path.join(
		ctx.runDir,
		"external-results",
		`${pending.label}.json`,
	);
	if (
		pending.manifestPath !== expectedManifestPath ||
		pending.resultPath !== expectedResultPath
	) {
		throw new StateCorruptedError("external request paths are invalid");
	}

	try {
		const realRunDir = fs.realpathSync(ctx.runDir);
		for (const directoryName of [
			"external-requests",
			"external-results",
		] as const) {
			const realDirectory = fs.realpathSync(
				path.join(ctx.runDir, directoryName),
			);
			if (realDirectory !== path.join(realRunDir, directoryName)) {
				throw new StateCorruptedError(
					"external request directory escapes the run directory",
				);
			}
		}
	} catch (error) {
		if (error instanceof StateCorruptedError) throw error;
		throw new StateCorruptedError(
			"external request directories are unavailable",
			{ cause: error },
		);
	}
}

function readStoredManifest<S extends object>(
	ctx: DispatchContext<S>,
	pending: PendingExternalRequestRecord,
	originPhase: string,
): ExternalRequestManifest {
	let raw: string;
	try {
		if (!fs.lstatSync(pending.manifestPath).isFile()) {
			throw new Error("manifest path is not a regular file");
		}
		raw = fs.readFileSync(pending.manifestPath, "utf-8");
	} catch (error) {
		throw new StateCorruptedError("external request manifest is unavailable", {
			cause: error,
			runId: ctx.runId,
			orchestratorName: ctx.config.name,
			phase: pending.resumeAt,
		});
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		throw new StateCorruptedError("external request manifest is malformed", {
			cause: error,
			runId: ctx.runId,
			orchestratorName: ctx.config.name,
			phase: pending.resumeAt,
		});
	}
	if (
		!isExternalRequestManifest(parsed) ||
		parsed.runId !== ctx.runId ||
		parsed.orchestratorName !== ctx.config.name ||
		parsed.phase !== originPhase ||
		parsed.requestId !== pending.requestId ||
		parsed.label !== pending.label ||
		parsed.requestType !== pending.requestType ||
		parsed.resumeAt !== pending.resumeAt ||
		parsed.resultPath !== pending.resultPath ||
		parsed.emittedAt !== pending.emittedAt ||
		parsed.emittedAtEpochMs !== pending.emittedAtEpochMs
	) {
		throw new StateCorruptedError(
			"external request manifest does not match pending state",
			{
				runId: ctx.runId,
				orchestratorName: ctx.config.name,
				phase: pending.resumeAt,
			},
		);
	}
	return parsed;
}

async function failMalformedResolution<S extends object>(
	ctx: DispatchContext<S>,
	state: StateFile<S>,
	pending: PendingExternalRequestRecord,
	reason: "unreadable" | "malformed_json",
	cause: unknown,
): Promise<never> {
	ctx.logger.emit({
		eventType: "external_resolution_validation_failed",
		runId: ctx.runId,
		phase: pending.resumeAt,
		label: pending.label,
		requestId: pending.requestId,
		requestType: pending.requestType,
		reason,
		timestamp: clock.nowWallIso(),
	});
	await emitFatalError(
		ctx,
		state,
		pending.resumeAt,
		new ExternalResolutionMalformedError(
			reason === "unreadable"
				? "external resolution is unreadable"
				: "external resolution contains malformed JSON",
			{
				cause,
				runId: ctx.runId,
				orchestratorName: ctx.config.name,
				phase: pending.resumeAt,
			},
		),
	);
	return undefined as never;
}

async function reemitExternalRequest<S extends object>(
	ctx: DispatchContext<S>,
	state: StateFile<S>,
	pending: PendingExternalRequestRecord,
	manifest: ExternalRequestManifest,
): Promise<never> {
	ctx.logger.emit({
		eventType: "external_request_reemit",
		runId: ctx.runId,
		phase: state.currentPhase,
		label: pending.label,
		requestId: pending.requestId,
		requestType: pending.requestType,
		timestamp: clock.nowWallIso(),
	});
	let block: string;
	try {
		block = externalRequestBinding.buildProtocolBlock(
			manifest,
			pending.manifestPath,
			ctx.config.resumeCommand(ctx.runId),
		);
	} catch (error) {
		await emitFatalError(ctx, state, pending.resumeAt, error);
		return undefined as never;
	}
	process.stdout.write(block);
	releaseLock(ctx.lockPath, ctx.handle, clock, ctx.logger, ctx.runId);
	doExit(0);
}

export async function runExternalRequestResume<S extends object>(
	ctx: DispatchContext<S>,
	state: StateFile<S>,
	pending: PendingExternalRequestRecord,
): Promise<never> {
	let manifest: ExternalRequestManifest;
	try {
		assertConfinedPaths(ctx, pending);
		manifest = readStoredManifest(ctx, pending, state.currentPhase);
	} catch (error) {
		await emitFatalError(ctx, state, pending.resumeAt, error);
		return undefined as never;
	}

	let stats: fs.Stats;
	try {
		stats = fs.lstatSync(pending.resultPath);
	} catch (error) {
		if (isMissingFileError(error)) {
			await reemitExternalRequest(ctx, state, pending, manifest);
			return undefined as never;
		}
		await failMalformedResolution(ctx, state, pending, "unreadable", error);
		return undefined as never;
	}
	if (!stats.isFile()) {
		await failMalformedResolution(
			ctx,
			state,
			pending,
			"unreadable",
			new Error("resolution path is not a regular file"),
		);
		return undefined as never;
	}

	let raw: string;
	try {
		raw = fs.readFileSync(pending.resultPath, "utf-8");
	} catch (error) {
		await failMalformedResolution(ctx, state, pending, "unreadable", error);
		return undefined as never;
	}
	ctx.logger.emit({
		eventType: "external_resolution_read",
		runId: ctx.runId,
		phase: pending.resumeAt,
		label: pending.label,
		requestId: pending.requestId,
		requestType: pending.requestType,
		timestamp: clock.nowWallIso(),
	});

	let resolution: unknown;
	try {
		resolution = JSON.parse(raw);
	} catch (error) {
		await failMalformedResolution(ctx, state, pending, "malformed_json", error);
		return undefined as never;
	}

	const stateForDispatch: StateFile<S> = {
		...state,
		currentPhase: pending.resumeAt,
	};
	await runDispatchLoop(ctx, stateForDispatch, {
		label: pending.label,
		kind: "external-request",
		data: resolution,
	});
	return undefined as never;
}
