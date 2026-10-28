import type { Stringifyable } from "../types/string";
import { binaryStringToUint8Array } from "./encoding";

/**
 * Splits user-visible text into Unicode grapheme clusters.
 *
 * Use this when each returned item will be displayed or animated separately.
 * The runtime must provide `Intl.Segmenter` or load a polyfill before calling.
 */
export function splitTextIntoGraphemes(text: string): string[] {
  return Array.from(
    new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text),
    ({ segment }) => segment,
  );
}

/**
 * Splits a string that is expected to contain only ASCII characters.
 *
 * This function does not validate the input. Use `splitTextIntoGraphemes` for
 * user-visible or otherwise Unicode-capable text.
 */
export function splitAsciiString(text: string): string[] {
  return Array.from(text);
}

function capitalizeWord(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}

/**
 * A regular expression to extract the last code block from a given string.
 */
const CODE_BLOCK_REGEX = /(?:.+\s|)```(json)?\s*(?<json>.*)\s*```(?:\s.+|)/ms;

/**
 * Extracts the last code block from a given string, typically returned by an LLM.
 *
 * This function looks for a Markdown-style code block (e.g., ```` ```json ... ``` ````)
 * and returns its inner content. If no code block is found, the original string is trimmed and returned.
 *
 * Useful when parsing structured responses (e.g., JSON) from LLMs that are wrapped in triple backticks.
 *
 * @param text - The input string potentially containing a code block.
 * @returns The inner content of the first code block if found, otherwise the trimmed original string.
 */
export function extractJSONFromCodeBlock(text: string): string {
  const match = CODE_BLOCK_REGEX.exec(text);
  return match && match.groups?.json ? match.groups.json.trim() : text.trim();
}

/**
 * Removes shared indentation from a multiline string
 * while preserving meaningful indentation. Nice for
 * multiline strings defined inside a nested code block.
 *
 * @example
 * deIndent`
 *   function hello() {
 *     return "world";
 *   }
 * `
 * // Returns:
 * `
 * function hello() {
 *   return "world";
 * }
 * `
 *
 */
export function deIndent(str: string): string;
export function deIndent(
  strings: TemplateStringsArray,
  ...values: Stringifyable[]
): string;
export function deIndent(
  strings: TemplateStringsArray | string,
  ...values: Stringifyable[]
): string {
  const str =
    typeof strings === "string"
      ? strings
      : strings.reduce((result, part, i) => {
          return result + part + (i < values.length ? String(values[i]) : "");
        }, "");

  const lines = str.split("\n");
  // Skip first line from indent calculation if it starts with non-whitespace
  const skipFirst = /^\S/.test(lines[0] ?? "");

  let minIndent = Infinity;
  for (let i = skipFirst ? 1 : 0; i < lines.length; i++) {
    const line = lines[i];
    if (line?.trim()) {
      const indent = line.search(/\S/);
      if (indent >= 0) minIndent = Math.min(minIndent, indent);
    }
  }

  if (minIndent === 0 || minIndent === Infinity) return str;

  return lines
    .map((line, i) => (i === 0 && skipFirst ? line : line.slice(minIndent)))
    .join("\n")
    .trim();
}

/**
 * Safely stringify a value.
 *
 * @param value - The value to stringify.
 * @returns The stringified value.
 */
export function safeJSONStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Stringifies values for text-oriented payloads without double-encoding strings.
 *
 * Use this when the destination accepts text and callers may already have
 * serialized JSON. Use `JSON.stringify` directly only when the destination
 * explicitly needs JSON encoding semantics, such as a structured HTTP body.
 *
 * When `value` is already a string it is returned as-is regardless of `space`,
 * since re-serializing it would double-encode the content.
 */
export function stringify(
  value: unknown,
  replacer?: Parameters<typeof JSON.stringify>[1],
  space?: Parameters<typeof JSON.stringify>[2],
): string {
  if (typeof value === "string") {
    return value;
  }

  try {
    const serialized = JSON.stringify(value, replacer, space);
    // eslint-disable-next-line typescript/no-unnecessary-condition -- `JSON.stringify` can return undefined for some values (functions, symbols, undefined) even though TypeScript types it as string, so we need a runtime check
    if (serialized !== undefined) {
      return serialized;
    }
  } catch {
    // Fall back below for values JSON cannot represent, such as BigInt.
  }

  return String(value);
}

/**
 * Removes every trailing occurrence of a single character from a string.
 */
export function trimTrailingChar(value: string, char: string): string {
  if (char.length !== 1) {
    throw new Error("trimTrailingChar expects exactly one character.");
  }

  let endIndex = value.length;
  while (endIndex > 0 && value[endIndex - 1] === char) {
    endIndex -= 1;
  }

  return value.slice(0, endIndex);
}

export function toTitleCase(value: string): string {
  return value
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/-/g, " ")
    .replace(/_/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .map(capitalizeWord)
    .join(" ");
}

/**
 * Decodes a base64 string to a UTF-8 string.
 * @param base64 - The base64 string to decode.
 * @returns The decoded UTF-8 string.
 */
export function base64ToUtf8(base64: string): string {
  const binary = atob(base64);
  return new TextDecoder().decode(binaryStringToUint8Array(binary));
}
