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
import {
	contentDigest,
	contentMatchesDigest,
} from "../services/content-digest";
import {
	installImmutableFileAtomic,
	readRegularFileBytes,
} from "../services/immutable-file";
import { releaseLock } from "../services/lock";
import {
	type PendingExternalRequestRecord,
	type StateFile,
	writeStateAtomic,
} from "../services/state-io";
import type { DispatchContext } from "./context";
import { doExit } from "./context";
import { runDispatchLoop } from "./dispatch-loop";
import { emitFatalError } from "./terminal-handlers";

function isMissingFileError(error: unknown): boolean {
	return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function acceptedResolutionPath<S extends object>(
	ctx: DispatchContext<S>,
	pending: PendingExternalRequestRecord,
): string {
	return path.join(
		ctx.runDir,
		"accepted-external-resolutions",
		`${pending.label}.json`,
	);
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
	const expectedAcceptedResolutionPath = acceptedResolutionPath(ctx, pending);
	if (
		pending.manifestPath !== expectedManifestPath ||
		pending.resultPath !== expectedResultPath ||
		(pending.acceptedResolutionPath !== undefined &&
			pending.acceptedResolutionPath !== expectedAcceptedResolutionPath)
	) {
		throw new StateCorruptedError("external request paths are invalid");
	}

	try {
		const realRunDir = fs.realpathSync(ctx.runDir);
		for (const directoryName of [
			"external-requests",
			"external-results",
			"accepted-external-resolutions",
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
	let raw: Buffer;
	try {
		raw = readRegularFileBytes(pending.manifestPath);
	} catch (error) {
		throw new StateCorruptedError("external request manifest is unavailable", {
			cause: error,
			runId: ctx.runId,
			orchestratorName: ctx.config.name,
			phase: pending.resumeAt,
		});
	}
	if (!contentMatchesDigest(raw, pending.manifestDigest)) {
		throw new StateCorruptedError(
			"external request manifest digest does not match pending state",
			{
				runId: ctx.runId,
				orchestratorName: ctx.config.name,
				phase: pending.resumeAt,
			},
		);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw.toString("utf-8"));
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
	ctx.logger.emit({
		eventType: "external_request_reemit",
		runId: ctx.runId,
		phase: state.currentPhase,
		label: pending.label,
		requestId: pending.requestId,
		requestType: pending.requestType,
		timestamp: clock.nowWallIso(),
	});
	process.stdout.write(block);
	releaseLock(ctx.lockPath, ctx.handle, clock, ctx.logger, ctx.runId);
	doExit(0);
}

function parseAcceptedResolution(
	raw: Buffer,
	context: {
		readonly runId: string;
		readonly orchestratorName: string;
		readonly phase: string;
	},
): unknown {
	try {
		return JSON.parse(raw.toString("utf-8"));
	} catch (error) {
		throw new StateCorruptedError("accepted external resolution is malformed", {
			cause: error,
			...context,
		});
	}
}

function readAcceptedResolution(
	acceptedPath: string,
	expectedDigest: string | undefined,
	context: {
		readonly runId: string;
		readonly orchestratorName: string;
		readonly phase: string;
	},
): { readonly raw: Buffer; readonly digest: string; readonly data: unknown } {
	let raw: Buffer;
	try {
		raw = readRegularFileBytes(acceptedPath);
	} catch (error) {
		throw new StateCorruptedError(
			"accepted external resolution is unavailable",
			{ cause: error, ...context },
		);
	}
	const digest = contentDigest(raw);
	if (expectedDigest !== undefined && digest !== expectedDigest) {
		throw new StateCorruptedError(
			"accepted external resolution digest does not match pending state",
			context,
		);
	}
	return { raw, digest, data: parseAcceptedResolution(raw, context) };
}

function emitResolutionRead<S extends object>(
	ctx: DispatchContext<S>,
	pending: PendingExternalRequestRecord,
): void {
	ctx.logger.emit({
		eventType: "external_resolution_read",
		runId: ctx.runId,
		phase: pending.resumeAt,
		label: pending.label,
		requestId: pending.requestId,
		requestType: pending.requestType,
		timestamp: clock.nowWallIso(),
	});
}

async function enterDispatchLoopWithAcceptedResolution<S extends object>(
	ctx: DispatchContext<S>,
	state: StateFile<S>,
	pending: PendingExternalRequestRecord,
	resolution: unknown,
): Promise<never> {
	emitResolutionRead(ctx, pending);
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

	const errorContext = {
		runId: ctx.runId,
		orchestratorName: ctx.config.name,
		phase: pending.resumeAt,
	};
	const expectedAcceptedPath = acceptedResolutionPath(ctx, pending);

	if (
		pending.acceptedResolutionPath !== undefined &&
		pending.acceptedResolutionDigest !== undefined
	) {
		let accepted: ReturnType<typeof readAcceptedResolution>;
		try {
			accepted = readAcceptedResolution(
				pending.acceptedResolutionPath,
				pending.acceptedResolutionDigest,
				errorContext,
			);
		} catch (error) {
			await emitFatalError(ctx, state, pending.resumeAt, error);
			return undefined as never;
		}
		await enterDispatchLoopWithAcceptedResolution(
			ctx,
			state,
			pending,
			accepted.data,
		);
		return undefined as never;
	}

	let accepted: ReturnType<typeof readAcceptedResolution> | null = null;
	try {
		accepted = readAcceptedResolution(
			expectedAcceptedPath,
			undefined,
			errorContext,
		);
	} catch (error) {
		if (
			!(error instanceof StateCorruptedError && isMissingFileError(error.cause))
		) {
			await emitFatalError(ctx, state, pending.resumeAt, error);
			return undefined as never;
		}
	}

	if (accepted === null) {
		let candidateRaw: Buffer;
		try {
			candidateRaw = readRegularFileBytes(pending.resultPath);
		} catch (error) {
			if (isMissingFileError(error)) {
				await reemitExternalRequest(ctx, state, pending, manifest);
				return undefined as never;
			}
			await failMalformedResolution(ctx, state, pending, "unreadable", error);
			return undefined as never;
		}

		try {
			JSON.parse(candidateRaw.toString("utf-8"));
		} catch (error) {
			emitResolutionRead(ctx, pending);
			await failMalformedResolution(
				ctx,
				state,
				pending,
				"malformed_json",
				error,
			);
			return undefined as never;
		}

		try {
			installImmutableFileAtomic(expectedAcceptedPath, candidateRaw);
			accepted = readAcceptedResolution(
				expectedAcceptedPath,
				undefined,
				errorContext,
			);
		} catch (error) {
			await emitFatalError(
				ctx,
				state,
				pending.resumeAt,
				error instanceof StateCorruptedError
					? error
					: new StateCorruptedError(
							"failed to preserve accepted external resolution",
							{ cause: error, ...errorContext },
						),
			);
			return undefined as never;
		}
	}

	const acceptedPending: PendingExternalRequestRecord = {
		...pending,
		acceptedResolutionPath: expectedAcceptedPath,
		acceptedResolutionDigest: accepted.digest,
		acceptedAt: clock.nowWallIso(),
	};
	const stateWithAcceptedResolution: StateFile<S> = {
		...state,
		pendingExternalRequest: acceptedPending,
	};
	try {
		writeStateAtomic(
			ctx.runDir,
			stateWithAcceptedResolution,
			ctx.config.stateSchema,
		);
	} catch (error) {
		await emitFatalError(ctx, state, pending.resumeAt, error);
		return undefined as never;
	}

	await enterDispatchLoopWithAcceptedResolution(
		ctx,
		stateWithAcceptedResolution,
		acceptedPending,
		accepted.data,
	);
	return undefined as never;
}
