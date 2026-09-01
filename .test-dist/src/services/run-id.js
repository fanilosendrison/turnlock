import { ulid } from "ulid";
const RUN_ID_REGEX = /^[0-9A-HJKMNP-TV-Z]{26}$/;
export function generateRunId() {
    return ulid();
}
export function isValidRunId(runId) {
    return RUN_ID_REGEX.test(runId);
}
//# sourceMappingURL=run-id.js.map