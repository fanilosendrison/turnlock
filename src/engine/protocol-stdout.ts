import { writeSync } from "node:fs";

function isInProcessTest(): boolean {
	if (process.env.TURNLOCK_TEST === "0") return false;
	return (
		process.env.TURNLOCK_TEST === "1" ||
		process.env.NODE_TEST_CONTEXT !== undefined
	);
}

export function writeProtocolStdout(block: string): void {
	if (isInProcessTest()) {
		process.stdout.write(block);
		return;
	}

	// Node's process.exit() can truncate buffered pipe writes. Protocol blocks
	// must be completely observable before the managed exit, including signal
	// exits, so production writes directly to the stdout descriptor.
	writeSync(process.stdout.fd, block);
}
