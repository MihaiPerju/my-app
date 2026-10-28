export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

type SchemaType =
  | "null"
  | "boolean"
  | "integer"
  | "number"
  | "string"
  | "array"
  | "object";

export type JsonSchema = {
  type?: SchemaType;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  anyOf?: JsonSchema[];
  additionalProperties?: boolean | JsonSchema;
};

export interface InferJsonSchemaOptions {
  /** Max number of keys visited per object. @default 100 */
  maxObjectKeys?: number;
  /** Max number of elements sampled per array. @default 20 */
  maxArraySampling?: number;
  /** Max recursive nesting depth. @default 10 */
  maxDepth?: number;
}

interface ResolvedOptions {
  maxObjectKeys: number;
  maxArraySampling: number;
  maxDepth: number;
}

const DEFAULTS: ResolvedOptions = {
  maxObjectKeys: 100,
  maxArraySampling: 20,
  maxDepth: 10,
};

const NULL_SCHEMA: JsonSchema = Object.freeze({ type: "null" as const });
const BOOLEAN_SCHEMA: JsonSchema = Object.freeze({
  type: "boolean" as const,
});
const INTEGER_SCHEMA: JsonSchema = Object.freeze({
  type: "integer" as const,
});
const NUMBER_SCHEMA: JsonSchema = Object.freeze({ type: "number" as const });
const STRING_SCHEMA: JsonSchema = Object.freeze({ type: "string" as const });
const EMPTY_SCHEMA: JsonSchema = Object.freeze({});

function resolveOptions(
  options: InferJsonSchemaOptions | undefined,
): ResolvedOptions {
  if (!options) return DEFAULTS;
  return {
    maxObjectKeys: options.maxObjectKeys ?? DEFAULTS.maxObjectKeys,
    maxArraySampling: options.maxArraySampling ?? DEFAULTS.maxArraySampling,
    maxDepth: options.maxDepth ?? DEFAULTS.maxDepth,
  };
}

/**
 * Infer a JSON Schema from a JSON value.
 *
 * Uses configurable limits to bound work on large/deep structures:
 * - `maxObjectKeys` (default 100): only the first N keys per object are visited
 * - `maxArrayElements` (default 20): only the first N elements per array are sampled
 * - `maxDepth` (default 10): recursion stops beyond this nesting level
 */
export function inferJsonSchema(
  value: JsonValue,
  options?: InferJsonSchemaOptions,
): JsonSchema {
  return infer(value, resolveOptions(options), 0);
}

function infer(
  value: unknown,
  opts: ResolvedOptions,
  depth: number,
): JsonSchema {
  if (depth > opts.maxDepth) return EMPTY_SCHEMA;
  if (value === null) return NULL_SCHEMA;

  switch (typeof value) {
    case "boolean":
      return BOOLEAN_SCHEMA;
    case "number":
      return Number.isInteger(value) ? INTEGER_SCHEMA : NUMBER_SCHEMA;
    case "string":
      return STRING_SCHEMA;
    case "object":
      return Array.isArray(value)
        ? inferArray(value, opts, depth)
        : inferObject(value as Record<string, unknown>, opts, depth);
    default:
      return EMPTY_SCHEMA;
  }
}

function inferArray(
  arr: unknown[],
  opts: ResolvedOptions,
  depth: number,
): JsonSchema {
  if (arr.length === 0) return { type: "array" };

  const limit = Math.min(arr.length, opts.maxArraySampling);
  let items = infer(arr[0], opts, depth + 1);

  for (let i = 1; i < limit; i++) {
    items = mergeSchemas(items, infer(arr[i], opts, depth + 1));
  }

  return { type: "array", items };
}

function inferObject(
  obj: Record<string, unknown>,
  opts: ResolvedOptions,
  depth: number,
): JsonSchema {
  const keys = Object.keys(obj);
  if (keys.length === 0) return { type: "object" };

  const limit = Math.min(keys.length, opts.maxObjectKeys);
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  const valueSchemas: JsonSchema[] = [];

  for (let i = 0; i < limit; i++) {
    const key = keys[i]!;
    const valueSchema = infer(obj[key], opts, depth + 1);
    properties[key] = valueSchema;
    valueSchemas.push(valueSchema);
    required.push(key);
  }

  const sharedValueSchema = inferSharedValueSchema(valueSchemas);
  if (
    keys.length === limit &&
    sharedValueSchema !== undefined &&
    sharedValueSchema.type === "object"
  ) {
    return { type: "object", additionalProperties: sharedValueSchema };
  }

  const schema: JsonSchema = { type: "object", properties, required };
  if (keys.length > limit) schema.additionalProperties = true;

  return schema;
}

// ---------------------------------------------------------------------------
// Schema merging (used to unify array element schemas)
// ---------------------------------------------------------------------------

function isEmpty(schema: JsonSchema): boolean {
  return schema.type === undefined && schema.anyOf === undefined;
}

function isNumericPair(a: JsonSchema, b: JsonSchema): boolean {
  return (
    (a.type === "integer" && b.type === "number") ||
    (a.type === "number" && b.type === "integer")
  );
}

function canMergeByType(a: JsonSchema, b: JsonSchema): boolean {
  if (a.type === undefined || b.type === undefined) return false;
  if (a.type === b.type) return true;
  return isNumericPair(a, b);
}

function inferSharedValueSchema(schemas: JsonSchema[]): JsonSchema | undefined {
  if (schemas.length < 2) return undefined;

  let sharedSchema = schemas[0]!;
  for (const schema of schemas.slice(1)) {
    const nextSharedSchema = mergeSchemas(sharedSchema, schema);
    if (nextSharedSchema.anyOf !== undefined) return undefined;
    sharedSchema = nextSharedSchema;
  }

  return sharedSchema;
}

export function mergeSchemas(a: JsonSchema, b: JsonSchema): JsonSchema {
  if (a === b) return a;
  if (isEmpty(a)) return b;
  if (isEmpty(b)) return a;

  if (a.type !== undefined && b.type !== undefined) {
    if (a.type === b.type) {
      if (a.type === "object") return mergeObjectSchemas(a, b);
      if (a.type === "array") return mergeArraySchemas(a, b);
      return a;
    }
    if (isNumericPair(a, b)) return NUMBER_SCHEMA;
    return { anyOf: [a, b] };
  }

  // At least one side is `anyOf` — merge variant lists
  const variants = a.anyOf ? [...a.anyOf] : [a];
  const incoming = b.anyOf ?? [b];

  for (const schema of incoming) {
    let merged = false;
    for (let i = 0; i < variants.length; i++) {
      const variant = variants[i]!;
      if (canMergeByType(variant, schema)) {
        variants[i] = mergeSchemas(variant, schema);
        merged = true;
        break;
      }
    }
    if (!merged) variants.push(schema);
  }

  return variants.length === 1 ? variants[0]! : { anyOf: variants };
}

function mergeObjectSchemas(a: JsonSchema, b: JsonSchema): JsonSchema {
  const aProps = a.properties ?? {};
  const bProps = b.properties ?? {};
  const aRequired = new Set(a.required ?? []);
  const bRequired = new Set(b.required ?? []);
  const aAdditionalSchema = getAdditionalPropertiesSchema(
    a.additionalProperties,
  );
  const bAdditionalSchema = getAdditionalPropertiesSchema(
    b.additionalProperties,
  );

  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];

  const visited = new Set<string>();

  for (const key of Object.keys(aProps)) {
    visited.add(key);
    const aSchema = aProps[key]!;
    const bSchema = bProps[key] ?? bAdditionalSchema;
    if (bSchema !== undefined) {
      properties[key] = mergeSchemas(aSchema, bSchema);
      if (aRequired.has(key) && bRequired.has(key)) required.push(key);
    } else {
      properties[key] = aSchema;
    }
  }

  for (const key of Object.keys(bProps)) {
    if (visited.has(key)) continue;
    const bSchema = bProps[key]!;
    properties[key] =
      aAdditionalSchema === undefined
        ? bSchema
        : mergeSchemas(aAdditionalSchema, bSchema);
  }

  const hasProperties = Object.keys(properties).length > 0;
  const schema: JsonSchema = { type: "object" };
  if (hasProperties) schema.properties = properties;
  if (required.length > 0) schema.required = required;
  const additionalProperties = mergeAdditionalProperties(
    a.additionalProperties,
    b.additionalProperties,
  );
  if (additionalProperties !== undefined) {
    schema.additionalProperties = additionalProperties;
  }

  return schema;
}

function getAdditionalPropertiesSchema(
  additionalProperties: JsonSchema["additionalProperties"],
): JsonSchema | undefined {
  return typeof additionalProperties === "object"
    ? additionalProperties
    : undefined;
}

function mergeAdditionalProperties(
  a: JsonSchema["additionalProperties"],
  b: JsonSchema["additionalProperties"],
): JsonSchema["additionalProperties"] {
  if (a === undefined) return b;
  if (b === undefined) return a;
  if (a === true || b === true) return true;
  if (a === false) return b;
  if (b === false) return a;
  return mergeSchemas(a, b);
}

function mergeArraySchemas(a: JsonSchema, b: JsonSchema): JsonSchema {
  if (!a.items && !b.items) return { type: "array" };
  if (!a.items) return b;
  if (!b.items) return a;
  return { type: "array", items: mergeSchemas(a.items, b.items) };
}
