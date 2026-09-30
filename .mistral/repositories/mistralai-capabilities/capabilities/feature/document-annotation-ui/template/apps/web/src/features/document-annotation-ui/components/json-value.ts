/**
 * The JSON document domain the review UI walks.
 *
 * Extraction payloads arrive as opaque wire JSON (`ExtractedDocument.data` is a bag of `unknown`).
 * Every panel decodes one at its boundary with {@link decodeDocumentData} and works on `JsonValue`
 * from then on, so no downstream helper re-derives a representation from an unparsed value.
 *
 * The two tiers are deliberate, and split on one principle: Zod decodes values that arrive as
 * `unknown` from outside the program; `typeof` inside a type predicate narrows a value already
 * known to be in the domain. `isJsonValue` is the sound, whole-subtree decode a boundary calls.
 * The `isJson*` narrowers take a value that is already in the domain and answer which arm of the
 * union it is with a direct check — sound by construction, and O(1) rather than O(subtree).
 */
import { z } from "zod";

import type { ExtractedDocument } from "@mistralai-capabilities/feature-document-annotation-ui";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonArray | JsonObject;
export type JsonArray = Array<JsonValue>;
export type JsonObject = { [key: string]: JsonValue };

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

/** Whole-subtree decode. Call this where wire JSON enters the feature, not per field. */
export function isJsonValue(value: unknown): value is JsonValue {
  return jsonValueSchema.safeParse(value).success;
}

/**
 * Narrow an in-domain value to its object arm: a plain object, not an array and not `null`.
 */
export function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isJsonArray(value: JsonValue | undefined): value is JsonArray {
  return Array.isArray(value);
}

export function isJsonString(value: JsonValue | undefined): value is string {
  return typeof value === "string";
}

export function isJsonNumber(value: JsonValue | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function isJsonBoolean(value: JsonValue | undefined): value is boolean {
  return typeof value === "boolean";
}

/**
 * Narrow to the arms that render as text.
 *
 * Written as a predicate so `array.every(isJsonPrimitive)` narrows the array itself: a panel that
 * has checked every element is a leaf can then stringify one without the compiler still believing
 * it might be an object.
 */
export function isJsonPrimitive(value: JsonValue | undefined): value is JsonPrimitive {
  return !isJsonObject(value) && !isJsonArray(value);
}

/**
 * Every document the panel holds is an immutable snapshot — an edit spreads a new object rather than
 * mutating one — so the decode of a given snapshot never goes stale and is cached against its
 * identity. Without this, walking N fields would re-decode the whole payload N times.
 */
const decodedData = new WeakMap<ExtractedDocument, JsonObject>();

/** The document's extracted data as a decoded object; an undecodable payload reviews as empty. */
export function decodeDocumentData(document: ExtractedDocument): JsonObject {
  const cached = decodedData.get(document);
  if (cached !== undefined) return cached;
  const data = document.data;
  const decoded = isJsonValue(data) && isJsonObject(data) ? data : {};
  decodedData.set(document, decoded);
  return decoded;
}
