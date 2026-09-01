export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
	| JsonPrimitive
	| readonly JsonValue[]
	| {
			readonly [key: string]: JsonValue;
	  };
export interface ExternalRequest {
	readonly label: string;
	readonly requestType: string;
	readonly payload: JsonValue;
	readonly metadata?: JsonValue;
}
