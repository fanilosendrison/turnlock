import { parseProtocolBlock, } from "../../src/services/protocol.js";
export function createMockStdio() {
    let stdout = "";
    let stderr = "";
    return {
        get stdout() {
            return stdout;
        },
        get stderr() {
            return stderr;
        },
        writeStdout(chunk) {
            stdout += chunk;
        },
        writeStderr(chunk) {
            stderr += chunk;
        },
        clear() {
            stdout = "";
            stderr = "";
        },
        getProtocolBlocks() {
            const blocks = [];
            let remaining = stdout;
            while (remaining.includes("@@TURNLOCK@@")) {
                try {
                    const parsed = parseProtocolBlock(remaining);
                    if (parsed === null)
                        break;
                    blocks.push(parsed);
                }
                catch {
                    break;
                }
                const idx = remaining.indexOf("@@END@@");
                if (idx === -1)
                    break;
                remaining = remaining.slice(idx + "@@END@@".length);
            }
            return blocks;
        },
        getEvents() {
            const out = [];
            const lines = stderr.split(/\r?\n/).filter((l) => l.length > 0);
            for (const line of lines) {
                try {
                    out.push(JSON.parse(line));
                }
                catch {
                    // skip non-json lines
                }
            }
            return out;
        },
    };
}
//# sourceMappingURL=mock-stdio.js.map