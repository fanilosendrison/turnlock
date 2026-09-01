import { MAX_EVENT_FIELD_LENGTH, MAX_EXTERNAL_LABEL_LENGTH, } from "../constants.js";
import { ProtocolError } from "../errors/concrete.js";
import { isJsonValue } from "../services/json-value.js";
export function assertExternalRequest(request, options) {
    if (typeof request !== "object" || request === null) {
        throw new ProtocolError("external request must be an object", options);
    }
    const candidate = request;
    if (typeof candidate.label !== "string" ||
        candidate.label.length > MAX_EXTERNAL_LABEL_LENGTH ||
        !/^[a-z][a-z0-9-]*$/.test(candidate.label)) {
        throw new ProtocolError(`external request label must be kebab-case and at most ${MAX_EXTERNAL_LABEL_LENGTH} characters`, options);
    }
    if (typeof candidate.requestType !== "string" ||
        candidate.requestType.trim().length === 0 ||
        candidate.requestType.length > MAX_EVENT_FIELD_LENGTH ||
        /[\u0000-\u001f\u007f]/.test(candidate.requestType)) {
        throw new ProtocolError(`external request type must be printable, non-empty, and at most ${MAX_EVENT_FIELD_LENGTH} characters`, options);
    }
    if (!("payload" in candidate) || !isJsonValue(candidate.payload)) {
        throw new ProtocolError("external request payload must be a JSON value", options);
    }
    if ("metadata" in candidate && !isJsonValue(candidate.metadata)) {
        throw new ProtocolError("external request metadata must be a JSON value when present", options);
    }
}
//# sourceMappingURL=external-request-validation.js.map