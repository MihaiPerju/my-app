/**
 * The slice of JSON Schema the review UI actually reads.
 *
 * A document type's `json_schema` is an arbitrary wire object. The panels only ever ask it four
 * questions — what type is this field, what are its properties, what shape are its array items, and
 * what should the label say — so that subset is decoded once, at the boundary, into a named
 * contract. Unrecognised keywords are dropped rather than carried around as `unknown`.
 */
import { z } from "zod";

export type ExtractionSchema = {
  readonly type?: string | Array<string>;
  readonly title?: string;
  readonly properties?: Record<string, ExtractionSchema>;
  readonly items?: ExtractionSchema;
};

const extractionSchemaSchema: z.ZodType<ExtractionSchema> = z.lazy(() =>
  z.object({
    type: z.union([z.string(), z.array(z.string())]).optional(),
    title: z.string().optional(),
    properties: z.record(z.string(), extractionSchemaSchema).optional(),
    items: extractionSchemaSchema.optional(),
  }),
);

/**
 * Whether a wire payload is a schema this feature can read.
 *
 * A predicate rather than a decoder, because the decode is subtractive: every keyword the panels
 * read is validated, and an object that declares none of them still satisfies the contract — it
 * just tells the panel nothing, which is the same outcome the previous untyped walk produced.
 */
export function isExtractionSchema(value: unknown): value is ExtractionSchema {
  return extractionSchemaSchema.safeParse(value).success;
}

/**
 * The declared type of a field, collapsing JSON Schema's `"type": ["string", "null"]` union form to
 * its first named type — which is the one the panel renders an input for.
 */
export function schemaType(schema: ExtractionSchema | null): string | undefined {
  const type = schema?.type;
  return Array.isArray(type) ? type[0] : type;
}

/** The child schema at `key`, or null when the schema declares no such property. */
export function schemaProperty(
  schema: ExtractionSchema | null,
  key: string,
): ExtractionSchema | null {
  return schema?.properties?.[key] ?? null;
}
