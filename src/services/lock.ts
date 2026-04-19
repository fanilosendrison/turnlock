import * as fs from "node:fs";
import { RunLockedError } from "../errors/concrete";
import type { Clock } from "../types/config";
import type { OrchestratorLogger } from "../types/events";
import { generateRunId } from "./run-id";

export { DEFAULT_IDLE_LEASE_MS } from "../constants";

import { DEFAULT_IDLE_LEASE_MS } from "../constants";

export interface LockFile {
	readonly ownerPid: number;
	readonly ownerToken: string;
	readonly acquiredAtEpochMs: number;
	readonly leaseUntilEpochMs: number;
}

export interface LockHandle {
	readonly ownerToken: string;
	readonly lockPath: string;
}

function overrideLock(lockPath: string, lockFile: LockFile): void {
	const tmpPath = `${lockPath}.tmp`;
	fs.writeFileSync(tmpPath, JSON.stringify(lockFile), { encoding: "utf-8" });
	fs.renameSync(tmpPath, lockPath);
}

export function acquireLock(
	lockPath: string,
	clock: Clock,
	logger: OrchestratorLogger,
	runId: string,
): LockHandle {
	const nowEpoch = clock.nowEpochMs();
	const ownerToken = generateRunId();
	const ownerPid = process.pid;
	const leaseUntilEpochMs = nowEpoch + DEFAULT_IDLE_LEASE_MS;
	const lockFile: LockFile = {
		ownerPid,
		ownerToken,
		acquiredAtEpochMs: nowEpoch,
		leaseUntilEpochMs,
	};

	try {
		const fd = fs.openSync(lockPath, "wx");
		try {
			fs.writeSync(fd, JSON.stringify(lockFile));
		} finally {
			fs.closeSync(fd);
		}
		return { ownerToken, lockPath };
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
			throw err;
		}
	}

	let existing: LockFile;
	try {
		existing = JSON.parse(fs.readFileSync(lockPath, "utf-8")) as LockFile;
	} catch {
		logger.emit({
			eventType: "lock_conflict",
			runId,
			reason: "expired_override",
			timestamp: clock.nowWallIso(),
		});
		overrideLock(lockPath, lockFile);
		return { ownerToken, lockPath };
	}

	if (nowEpoch <= existing.leaseUntilEpochMs) {
		throw new RunLockedError(
			`Run is locked by PID ${existing.ownerPid}, lease expires at ${new Date(existing.leaseUntilEpochMs).toISOString()}`,
			{
				ownerPid: existing.ownerPid,
				acquiredAtEpochMs: existing.acquiredAtEpochMs,
				leaseUntilEpochMs: existing.leaseUntilEpochMs,
				runId,
			},
		);
	}

	logger.emit({
		eventType: "lock_conflict",
		runId,
		reason: "expired_override",
		currentOwnerToken: existing.ownerToken,
		timestamp: clock.nowWallIso(),
	});
	overrideLock(lockPath, lockFile);
	return { ownerToken, lockPath };
}

export function refreshLock(
	lockPath: string,
	handle: LockHandle,
	clock: Clock,
	logger: OrchestratorLogger,
	runId: string,
): void {
	let existing: LockFile;
	try {
		existing = JSON.parse(fs.readFileSync(lockPath, "utf-8")) as LockFile;
	} catch {
		return;
	}

	if (existing.ownerToken !== handle.ownerToken) {
		logger.emit({
			eventType: "lock_conflict",
			runId,
			reason: "stolen_at_release",
			currentOwnerToken: existing.ownerToken,
			timestamp: clock.nowWallIso(),
		});
		return;
	}

	const updated: LockFile = {
		...existing,
		leaseUntilEpochMs: clock.nowEpochMs() + DEFAULT_IDLE_LEASE_MS,
	};
	overrideLock(lockPath, updated);
}

export function releaseLock(
	lockPath: string,
	handle: LockHandle,
	clock: Clock,
	logger: OrchestratorLogger,
	runId: string,
): void {
	let existing: LockFile;
	try {
		existing = JSON.parse(fs.readFileSync(lockPath, "utf-8")) as LockFile;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
		return;
	}

	if (existing.ownerToken !== handle.ownerToken) {
		logger.emit({
			eventType: "lock_conflict",
			runId,
			reason: "stolen_at_release",
			currentOwnerToken: existing.ownerToken,
			timestamp: clock.nowWallIso(),
		});
		return;
	}

	try {
		fs.unlinkSync(lockPath);
	} catch {
		// silent
	}
}
