/**
 * release/rc/github-rest.ts — the little bit of GitHub REST the candidate pipeline needs,
 * and the guarded readers that keep its responses from being trusted on sight.
 *
 * `actions/github-script` would bring octokit, but it can only run JavaScript
 * pasted into a YAML string. The scripts here decide whether to publish a pull
 * request's code and what to tell reviewers about it, which is exactly the kind
 * of logic that has to be typed and tested, so they run as `bun scripts/release/rc/*.ts`
 * and talk to the API through this instead.
 */

import { z } from "zod";

/**
 * The JSON domain a GitHub REST response arrives as. The API is trusted for
 * nothing: a body is decoded once, on arrival, and every read afterwards
 * narrows an in-domain value to the arm a caller needs rather than asserting a
 * shape the compiler never checked.
 */
export type JsonValue = string | number | boolean | null | JsonArray | JsonObject;
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

/**
 * The one place an `unknown` off the wire is admitted: a whole-body decode, so
 * nothing downstream has to wonder whether it is holding JSON.
 */
function isJsonValue(value: unknown): value is JsonValue {
  return jsonValueSchema.safeParse(value).success;
}

/**
 * Narrow a decoded value to its object arm: a plain object, not an array and not `null`.
 *
 * The split is deliberate: `isJsonValue` decodes `unknown` off the wire and keeps Zod; these
 * narrowers take a value already in the domain, so a direct `typeof` check answers which arm it is.
 */
function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isJsonNumber(value: JsonValue | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isJsonString(value: JsonValue | undefined): value is string {
  return typeof value === "string";
}

/** `value.key` when `value` is an object carrying that key, else undefined. */
export function field(value: JsonValue | undefined, key: string): JsonValue | undefined {
  return isJsonObject(value) ? value[key] : undefined;
}

/** `value.key` when it is a string, else undefined. */
export function stringField(value: JsonValue | undefined, key: string): string | undefined {
  const found = field(value, key);
  return isJsonString(found) ? found : undefined;
}

export function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

const HEADERS = (token: string) => ({
  accept: "application/vnd.github+json",
  authorization: `Bearer ${token}`,
  "x-github-api-version": "2022-11-28",
});

/**
 * Read a response body through the domain decode.
 *
 * `Response.json()` is typed `any`, which is how an unchecked payload gets to
 * spread through a caller unnoticed. Landing it in an explicit `unknown` and
 * running the schema is what makes the `JsonValue` the readers below assume
 * an actual guarantee rather than a comment.
 */
async function readJsonBody(response: Response, label: string): Promise<JsonValue> {
  const body: unknown = await response.json();
  if (!isJsonValue(body)) throw new Error(`${label} → response body is not JSON`);
  return body;
}

/** A GET that follows `Link: rel="next"`, returning each page's parsed body. */
export async function paginate(path: string, token: string): Promise<JsonValue[]> {
  const pages: JsonValue[] = [];
  let url: string | undefined = `https://api.github.com${path}`;
  while (url) {
    const response: Response = await fetch(url, { headers: HEADERS(token) });
    if (!response.ok) {
      throw new Error(`GET ${url} → ${response.status} ${await response.text()}`);
    }
    pages.push(await readJsonBody(response, `GET ${url}`));
    url = /<([^>]+)>;\s*rel="next"/.exec(response.headers.get("link") ?? "")?.[1];
  }
  return pages;
}

/** One request. A non-2xx is thrown, never returned as a body to be misread. */
export async function request(
  method: string,
  path: string,
  token: string,
  body?: JsonValue,
): Promise<JsonValue> {
  const response = await fetch(`https://api.github.com${path}`, {
    method,
    headers: { ...HEADERS(token), "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`${method} ${path} → ${response.status} ${await response.text()}`);
  }
  return readJsonBody(response, `${method} ${path}`);
}
