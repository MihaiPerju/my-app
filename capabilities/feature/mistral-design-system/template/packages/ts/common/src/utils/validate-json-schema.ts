import type { Schema, ValidateFunction } from "ajv";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import Ajv2020 from "ajv/dist/2020";

export type JSONSchema = Exclude<Schema, boolean>;

export type ValidateJsonSchemaOutput<Value = unknown> =
  | {
      isValid: false;
      errorType: "invalid-schema" | "invalid-input";
      details: string;
    }
  | { isValid: true; value: Value };

const DRAFT_2020_12_TAG = "2020-12";

/**
 * Ajv ships two compilers because the JSON Schema spec was split mid-evolution:
 *
 * - Default `Ajv` targets draft-07 (and the older draft-06/04 dialects). It
 *   does not understand the 2019-09/2020-12 keywords like `prefixItems` or the
 *   restructured `$ref` resolution rules, and will reject schemas that declare
 *   a 2020-12 `$schema`.
 * - `Ajv2020` is a separate entry point pre-configured for the 2020-12 draft.
 *
 * We need 2020-12 because some MCP / OpenAI-style tool schemas we receive use
 * `prefixItems` (the draft-2020 replacement for tuple-form `items`). Falling
 * back to the default Ajv keeps draft-07 schemas (the bulk of internal tool
 * definitions) working without forcing every caller to upgrade.
 *
 * We pick the compiler purely from the schema's `$schema` URL - that's the
 * only signal we have about which dialect the author wrote against.
 */
const createAjv = (schema: JSONSchema) => {
  const schemaDialect =
    typeof schema.$schema === "string" ? schema.$schema : undefined;

  const ajv = schemaDialect?.includes(DRAFT_2020_12_TAG)
    ? new Ajv2020()
    : new Ajv();

  addFormats(ajv);

  // Allow $metadata as a custom keyword (used for workflow tool call linking).
  ajv.addKeyword("$metadata");

  // Workflow form schemas may carry the `errorMessage` extension so the browser
  // can show an author-written validation message. Only the form renderer acts
  // on it (via ajv-errors); here it just has to not trip strict mode, which
  // would reject the whole schema as invalid.
  ajv.addKeyword("errorMessage");

  return ajv;
};

/**
 * Compiled validators are expensive to produce (regex construction, keyword
 * resolution, deep tree traversal). Cache them by schema object identity so
 * repeated calls for the same schema - common in MCP tool validation and
 * streaming JSON Schema checks - pay the compile cost only once.
 *
 * WeakMap keys must be objects, which JSONSchema always is (booleans are
 * excluded by the type). Failed compilations are intentionally not cached so
 * a later call with a fixed schema object still compiles correctly.
 */
const validatorCache = new WeakMap<JSONSchema, ValidateFunction>();

export const validateJsonSchemaPayload = <Value = unknown>({
  schema,
  input,
}: {
  schema: JSONSchema;
  input: Value;
}): ValidateJsonSchemaOutput<Value> => {
  let validator = validatorCache.get(schema);

  if (!validator) {
    const ajv = createAjv(schema);
    try {
      validator = ajv.compile(schema);
      validatorCache.set(schema, validator);
    } catch (e) {
      return {
        isValid: false,
        errorType: "invalid-schema",
        details: e instanceof Error ? e.message : "Unknown error",
      };
    }
  }

  if (!validator(input)) {
    return {
      isValid: false,
      errorType: "invalid-input",
      details:
        validator.errors
          ?.map(
            (e) => `${e.instancePath ? e.instancePath + ": " : ""}${e.message}`,
          )
          .join(", ") ?? "Unknown error",
    };
  }

  return { isValid: true, value: input };
};
