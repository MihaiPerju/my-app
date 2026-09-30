import type { ExtractedDocument } from "@mistralai-capabilities/feature-document-annotation-ui";

import { type ExtractionSchema, schemaProperty, schemaType } from "./extraction-schema";
import {
  decodeDocumentData,
  isJsonArray,
  isJsonBoolean,
  isJsonNumber,
  isJsonObject,
  isJsonString,
  isJsonValue,
  type JsonArray,
  type JsonObject,
  type JsonValue,
} from "./json-value";

export type InputKind = "text" | "number";

type SourceMap = NonNullable<ExtractedDocument["_sources"]>;

// `_sources` is a wire field on ExtractedDocument; read and write it through bracket notation so the
// no-underscore-dangle lint (which exempts quoted/computed access) is satisfied without renaming the
// API contract.
function documentSources(document: ExtractedDocument): SourceMap | undefined {
  return document["_sources"];
}

function isNumericSegment(segment: string): boolean {
  return segment !== "" && /^\d+$/.test(segment);
}

function pathSegments(path: string): Array<string> {
  return path.split(".").filter((segment) => segment !== "");
}

function collectDataPaths(value: JsonValue | undefined, prefix = ""): Array<string> {
  if (isJsonArray(value)) {
    const paths: Array<string> = [];
    value.forEach((item, index) => {
      paths.push(...collectDataPaths(item, prefix === "" ? String(index) : `${prefix}.${index}`));
    });
    return paths.length > 0 ? paths : prefix === "" ? [] : [prefix];
  }
  if (isJsonObject(value)) {
    const paths = Object.entries(value).flatMap(([key, child]) =>
      collectDataPaths(child, prefix === "" ? key : `${prefix}.${key}`),
    );
    return paths.length > 0 ? paths : prefix === "" ? [] : [prefix];
  }
  return prefix === "" ? [] : [prefix];
}

function collectSchemaPaths(
  schema: ExtractionSchema | null,
  data: JsonValue | undefined,
  prefix = "",
): Array<string> {
  const properties = schema?.properties ?? {};
  if (Object.keys(properties).length > 0) {
    return Object.entries(properties).flatMap(([key, childSchema]) => {
      const childPath = prefix === "" ? key : `${prefix}.${key}`;
      const childData = isJsonObject(data) ? data[key] : undefined;
      return collectSchemaPaths(childSchema, childData, childPath);
    });
  }

  if (schemaType(schema) === "array") {
    const items = schema?.items ?? null;
    if (isJsonArray(data) && data.length > 0) {
      return data.flatMap((item, index) => collectSchemaPaths(items, item, `${prefix}.${index}`));
    }
  }

  return prefix === "" ? [] : [prefix];
}

export function readFieldValue(document: ExtractedDocument, key: string): JsonValue | undefined {
  let current: JsonValue | undefined = decodeDocumentData(document);
  for (const segment of pathSegments(key)) {
    if (isJsonArray(current)) {
      if (!isNumericSegment(segment)) return undefined;
      current = current[Number(segment)];
      continue;
    }
    if (!isJsonObject(current)) return undefined;
    current = current[segment];
  }
  return current;
}

function emptyContainerFor(nextSegment: string | undefined): JsonObject | JsonArray {
  return nextSegment !== undefined && isNumericSegment(nextSegment) ? [] : {};
}

function writeValue(current: JsonValue, segments: Array<string>, value: JsonValue): JsonValue {
  const [head, ...tail] = segments;
  if (head === undefined) return value;
  if (isJsonArray(current)) {
    if (!isNumericSegment(head)) return current;
    const copy = [...current];
    copy[Number(head)] = writeValue(copy[Number(head)] ?? emptyContainerFor(tail[0]), tail, value);
    return copy;
  }
  const base: JsonObject = isJsonObject(current) ? current : {};
  return {
    ...base,
    [head]: writeValue(base[head] ?? emptyContainerFor(tail[0]), tail, value),
  };
}

export function writeFieldValue(
  document: ExtractedDocument,
  key: string,
  value: JsonValue,
): ExtractedDocument {
  const data = writeValue(decodeDocumentData(document), pathSegments(key), value);
  return { ...document, data: isJsonObject(data) ? data : {} };
}

function deleteValue(current: JsonValue, segments: Array<string>): JsonValue {
  const [head, ...tail] = segments;
  if (head === undefined) return current;

  if (isJsonArray(current)) {
    if (!isNumericSegment(head)) return current;
    const index = Number(head);
    if (index < 0 || index >= current.length) return current;
    if (tail.length === 0) return current.filter((_, position) => position !== index);
    const element = current[index];
    if (element === undefined) return current;
    const copy = [...current];
    copy[index] = deleteValue(element, tail);
    return copy;
  }

  if (!isJsonObject(current)) return current;
  if (tail.length === 0) {
    const { [head]: _removed, ...rest } = current;
    return rest;
  }
  const child = current[head];
  if (child === undefined) return current;
  return { ...current, [head]: deleteValue(child, tail) };
}

/**
 * Drop a field (or an array element) from the draft, keeping `_sources` provenance aligned.
 *
 * Removing an array element splices the data, so later `_sources` keys shift down the same way.
 * Removing an object field drops that field's source subtree. Without this, the panel renders a
 * shifted row but resolves its hover to the block the deleted row came from.
 */
function reindexSources(sources: SourceMap, key: string): SourceMap {
  const parent = pathSegments(key);
  const last = parent.pop();

  if (last === undefined || !isNumericSegment(last)) {
    const result: SourceMap = {};
    for (const [sourceKey, value] of Object.entries(sources)) {
      if (sourceKey === key || sourceKey.startsWith(`${key}.`)) continue;
      result[sourceKey] = value;
    }
    return result;
  }

  const removed = Number(last);
  const result: SourceMap = {};
  for (const [sourceKey, value] of Object.entries(sources)) {
    const segments = pathSegments(sourceKey);
    const sharesParent =
      segments.length > parent.length &&
      parent.every((segment, position) => segments[position] === segment);
    const indexSegment = sharesParent ? segments[parent.length] : undefined;
    if (indexSegment === undefined || !isNumericSegment(indexSegment)) {
      result[sourceKey] = value;
      continue;
    }
    const index = Number(indexSegment);
    if (index === removed) continue;
    segments[parent.length] = String(index > removed ? index - 1 : index);
    result[segments.join(".")] = value;
  }
  return result;
}

export function deleteFieldValue(document: ExtractedDocument, key: string): ExtractedDocument {
  const data = deleteValue(decodeDocumentData(document), pathSegments(key));
  const next: ExtractedDocument = { ...document, data: isJsonObject(data) ? data : {} };
  const sources = documentSources(document);
  return sources === undefined ? next : { ...next, ["_sources"]: reindexSources(sources, key) };
}

function schemaArrayItem(
  extractionSchema: ExtractionSchema | null,
  key: string,
): ExtractionSchema | null {
  const arraySchema = schemaForPath(extractionSchema, key);
  return schemaType(arraySchema) === "array" ? (arraySchema?.items ?? null) : null;
}

function emptyValueFromSchema(schema: ExtractionSchema | null): JsonValue {
  const type = schemaType(schema);
  if (type === "object") return withSchemaFields(schema, {});
  if (type === "array") return [];
  return null;
}

function emptyArrayItem(
  current: ReadonlyArray<JsonValue>,
  extractionSchema: ExtractionSchema | null,
  key: string,
): JsonValue {
  const itemSchema = schemaArrayItem(extractionSchema, key);
  if (itemSchema !== null) return emptyValueFromSchema(itemSchema);

  const template = current.find((item): item is JsonObject => isJsonObject(item));
  return template === undefined
    ? null
    : Object.fromEntries(Object.keys(template).map((field) => [field, null]));
}

/**
 * Append one element to the array at `key`, shaped like the elements already there.
 *
 * With a schema, the new row comes from the item schema, so a reviewer can add a row for an omitted
 * array and validation-error fields stay visible. Without a schema, a new object row copies the
 * existing keys with empty values; an array of primitives appends `null`.
 */
export function appendArrayItem(
  document: ExtractedDocument,
  key: string,
  extractionSchema?: ExtractionSchema | null,
): ExtractedDocument {
  const schema = extractionSchema ?? null;
  const current = readFieldValue(document, key);
  const arraySchema = schemaForPath(schema, key);
  if (current === undefined && schemaType(arraySchema) === "array") {
    return writeFieldValue(document, key, [emptyArrayItem([], schema, key)]);
  }
  if (!isJsonArray(current)) return document;

  return writeFieldValue(document, key, [...current, emptyArrayItem(current, schema, key)]);
}

function normalize(value: JsonValue | undefined): string | number | boolean | null {
  if (value === undefined || value === null) return null;
  if (isJsonString(value) && value.trim() === "") return null;
  if (isJsonNumber(value) || isJsonBoolean(value) || isJsonString(value)) return value;
  return JSON.stringify(value);
}

export function isFieldEdited(
  original: ExtractedDocument,
  edited: ExtractedDocument,
  key: string,
): boolean {
  return normalize(readFieldValue(original, key)) !== normalize(readFieldValue(edited, key));
}

/**
 * The extracted data with every schema-declared field the model omitted materialised so the reviewer
 * can fill it. The panel only renders keys present in the data, so a missing target field is
 * otherwise invisible. Recurses into objects; existing values win, only missing keys are added. A
 * missing scalar or object becomes an editable `null`; a missing array becomes `[]` so the array UI
 * renders. A present array is left as-is.
 */
export function withSchemaFields(
  extractionSchema: ExtractionSchema | null,
  data: JsonValue | undefined,
): JsonObject {
  const properties = extractionSchema?.properties ?? {};
  const base: JsonObject = isJsonObject(data) ? { ...data } : {};
  for (const [key, childSchema] of Object.entries(properties)) {
    // A `JsonObject` never stores `undefined`, so "read it back" and "was the key present" are the
    // same question — asking it once is what keeps the recursive calls out of `JsonValue | undefined`.
    const existing = base[key];
    const type = schemaType(childSchema);
    if (type === "object") {
      base[key] = withSchemaFields(childSchema, existing ?? {});
    } else if (type === "array") {
      base[key] = existing === undefined ? [] : materializeSchemaArray(childSchema, existing);
    } else if (existing === undefined) {
      base[key] = null;
    }
  }
  return base;
}

function materializeSchemaArray(arraySchema: ExtractionSchema | null, data: JsonValue): JsonValue {
  if (!isJsonArray(data)) return data;
  const itemSchema = arraySchema?.items ?? null;
  const itemType = schemaType(itemSchema);
  return data.map((item) => {
    if (itemType === "object") return withSchemaFields(itemSchema, item);
    if (itemType === "array") return materializeSchemaArray(itemSchema, item);
    return item;
  });
}

export function documentFieldKeys(
  extractionSchema: ExtractionSchema | null,
  original: ExtractedDocument,
  edited: ExtractedDocument,
): Array<string> {
  const originalData = decodeDocumentData(original);
  const editedData = decodeDocumentData(edited);
  const keys = new Set<string>();
  for (const key of collectSchemaPaths(extractionSchema, editedData)) keys.add(key);
  for (const key of collectDataPaths(originalData)) keys.add(key);
  for (const key of collectDataPaths(editedData)) keys.add(key);
  for (const key of Object.keys(documentSources(original) ?? {})) keys.add(key);
  for (const key of Object.keys(documentSources(edited) ?? {})) keys.add(key);
  return [...keys];
}

export function editedFieldKeys(
  extractionSchema: ExtractionSchema | null,
  original: ExtractedDocument,
  edited: ExtractedDocument,
): Array<string> {
  return documentFieldKeys(extractionSchema, original, edited).filter((key) =>
    isFieldEdited(original, edited, key),
  );
}

function schemaForPath(schema: ExtractionSchema | null, key: string): ExtractionSchema | null {
  let current: ExtractionSchema | null = schema;
  for (const segment of pathSegments(key)) {
    if (isNumericSegment(segment)) {
      current = current?.items ?? null;
      continue;
    }
    current = schemaProperty(current, segment);
  }
  return current;
}

export function inputKindForField(
  extractionSchema: ExtractionSchema | null,
  key: string,
  value: JsonValue | undefined,
): InputKind {
  const fieldType = schemaType(schemaForPath(extractionSchema, key));
  if (fieldType === "number" || fieldType === "integer" || isJsonNumber(value)) return "number";
  return "text";
}

/** The schema `title` for a field, if the schema declares one — else null. */
export function fieldTitle(extractionSchema: ExtractionSchema | null, key: string): string | null {
  const fieldSchema = schemaForPath(extractionSchema, key);
  return fieldSchema?.title ?? null;
}

export function fieldLabel(extractionSchema: ExtractionSchema | null, key: string): string {
  return (
    fieldTitle(extractionSchema, key) ??
    key
      .split(".")
      .map((part) => (isNumericSegment(part) ? `#${Number(part) + 1}` : part.replaceAll("_", " ")))
      .join(" › ")
  );
}

export function parseInputValue(
  raw: string,
  previous: JsonValue | undefined,
  kind?: InputKind,
): JsonValue {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  if (kind === "number" || isJsonNumber(previous)) {
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (isJsonBoolean(previous)) {
    if (trimmed.toLowerCase() === "true") return true;
    if (trimmed.toLowerCase() === "false") return false;
  }
  if (isJsonArray(previous) || isJsonObject(previous)) {
    try {
      const parsed: unknown = JSON.parse(raw);
      return isJsonValue(parsed) ? parsed : raw;
    } catch {
      return raw;
    }
  }
  return raw;
}

export function toInputValue(value: JsonValue | undefined): string {
  if (value === null || value === undefined) return "";
  if (isJsonString(value)) return value;
  if (isJsonNumber(value) || isJsonBoolean(value)) return String(value);
  return JSON.stringify(value);
}
