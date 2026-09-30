/**
 * A type representing values that can be converted to a string.
 *
 * This includes primitive types (number, string, boolean, null, undefined)
 * and objects that have a `toString()` method returning a string.
 *
 * @example
 * ```ts
 * function format(value: Stringifyable): string {
 *   return String(value);
 * }
 * ```
 */
export type Stringifyable =
  | number
  | string
  | boolean
  | null
  | undefined
  | { toString: () => string };
