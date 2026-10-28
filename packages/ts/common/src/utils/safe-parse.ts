import { z } from "zod";

import { type Option } from "../types/option";
import { none, some } from "./option";

/**
 * Safely parses a JSON string without throwing errors.
 *
 * @param json - The JSON string to parse.
 * @returns An `Option` containing the parsed object if successful, or null if parsing fails.
 */
export function safeParse(json: string): Option<object | null> {
  try {
    return some(JSON.parse(json));
  } catch {
    return none();
  }
}

/**
 * Safely parses a JSON string and validates it against a Zod schema.
 *
 * @template T - The Zod schema type used for validation.
 * @param json - The JSON string to parse and validate.
 * @param schema - The Zod schema to validate the parsed data against.
 * @returns A `SafeParseReturnType` with either `{ success: true, data: T }` or `{ success: false, error: ZodError }`.
 */
export const safeJSONParse = <T extends z.ZodType>(
  json: string,
  schema: T,
): z.ZodSafeParseResult<z.output<T>> => {
  try {
    return schema.safeParse(JSON.parse(json));
  } catch {
    return {
      success: false as const,
      error: new z.ZodError([
        {
          message: "Failed to parse JSON",
          code: z.ZodIssueCode.custom,
          path: [],
          input: undefined,
        },
      ]),
    } as z.ZodSafeParseResult<z.output<T>>;
  }
};
