// TL-F-001 multiprocess contender — spawned by the ownership contention test.
//
// Attempts acquireLock() on a pre-existing expired lock and reports the
// structured result as one JSON line on stdout.
//
// No barrier — all contenders race naturally, which mirrors real crash-recovery
// scenarios where multiple processes restart close together.

import { acquireLock } from "../../../src/services/lock";
import { createMockClock } from "../../helpers/mock-clock";
import { createMockLogger } from "../../helpers/mock-logger";

const LOCK_PATH = process.env.TL_LOCK_PATH;
const ID = process.env.TL_CONTENDER_ID;

if (!LOCK_PATH || !ID) {
	process.stderr.write("TL_LOCK_PATH and TL_CONTENDER_ID required\n");
	process.exit(99);
}

const clock = createMockClock("2026-04-19T12:00:00.000Z", 0, 0);
const logger = createMockLogger();

let outcome: string;
let ownerToken: string | undefined;
try {
	const handle = acquireLock(
		LOCK_PATH,
		clock,
		logger,
		"01HXCONTENDER000000000000000",
	);
	outcome = "ACQUIRED";
	ownerToken = handle.ownerToken;
} catch (err) {
	const msg = String(err);
	outcome = msg.includes("locked") ? "ACTIVE_CONFLICT" : "ERROR";
}

process.stdout.write(JSON.stringify({ id: ID, outcome, ownerToken }) + "\n");
