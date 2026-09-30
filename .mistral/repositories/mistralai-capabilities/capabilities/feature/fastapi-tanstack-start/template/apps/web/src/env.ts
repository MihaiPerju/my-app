/**
 * The one client-side setting, decoded at module load. `import.meta.env.VITE_API_URL` stays a
 * literal access: Vite substitutes it statically, so a computed key is undefined. The zod schema is
 * the environment boundary — it does the shape checking that hand-rolled `typeof` guards used to.
 */

import { z } from "zod";

const API_BASE_URL_HINT =
  "VITE_API_URL must be empty, an absolute URL, or a same-origin path beginning with a single /";

/** One leading slash only — `//host` is protocol-relative, which is a different origin. */
const SAME_ORIGIN_PATH = /^\/(?!\/)/;

function isAbsoluteUrl(value: string): boolean {
  try {
    return Boolean(new URL(value).protocol);
  } catch {
    return false;
  }
}

// Undefined and empty both mean "no override, talk to this origin"; anything else must be a
// same-origin path or an absolute URL.
const apiBaseUrl = z
  .string()
  .refine((value) => value === "" || SAME_ORIGIN_PATH.test(value) || isAbsoluteUrl(value), {
    message: API_BASE_URL_HINT,
  })
  .optional()
  .default("");

// When validation is skipped, coerce anything unusable to the same-origin default rather than
// enforcing the URL shape.
const apiBaseUrlLoose = z.string().catch("");

const envSchema = z.object({ VITE_API_URL: apiBaseUrl });
const looseEnvSchema = z.object({ VITE_API_URL: apiBaseUrlLoose });

const schema = process.env.SKIP_ENV_VALIDATION ? looseEnvSchema : envSchema;

export const env = schema.parse({ VITE_API_URL: import.meta.env.VITE_API_URL });
