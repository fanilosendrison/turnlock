import {
	type OrchestratorConfig,
	PROTOCOL_VERSION,
} from "../../../dist/index.js";

const protocolVersion: number = PROTOCOL_VERSION;
const configShape: OrchestratorConfig<Record<string, never>> | undefined =
	undefined;

void protocolVersion;
void configShape;
