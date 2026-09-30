import type { Option, Some } from "../types/option";

/**
 * Returns `true` if `option` is a `Some<T>` (i.e. non-null), narrowing the
 * type accordingly.
 *
 * @template T - The type of the wrapped value.
 * @param option - The option to test.
 * @returns `true` when `option` is `Some<T>`, `false` when it is `null`.
 *
 * @example
 * ```ts
 * const opt: Option<string> = some("hello");
 * if (isSome(opt)) {
 *   console.log(opt.value); // "hello"
 * }
 * ```
 */
export const isSome = <T>(option: Option<T>): option is Some<T> =>
  option !== null;

/**
 * Returns `true` if `option` is `null` (i.e. absent), narrowing the type
 * accordingly.
 *
 * @template T - The type of the value when present.
 * @param option - The option to test.
 * @returns `true` when `option` is `null`, `false` when it is `Some<T>`.
 *
 * @example
 * ```ts
 * const opt: Option<string> = none();
 * if (isNone(opt)) {
 *   console.log("no value");
 * }
 * ```
 */
export const isNone = <T>(option: Option<T>): option is null => option === null;

/**
 * Creates a `Some<T>` value.
 *
 * @template T - The type of the value.
 * @param value - The value to wrap.
 * @returns A `Some<T>` containing the value.
 */
export const some = <T>(value: T): Some<T> => ({ value });

/**
 * Creates an empty `Option<T>` value (null).
 *
 * @template T - The type of the value when present.
 * @returns `null`, representing the absence of a value.
 *
 * @example
 * ```ts
 * const empty: Option<string> = none();
 * // empty === null
 * ```
 *
 * @example
 * ```ts
 * // Use with some() for pattern matching
 * const result: Option<number> = condition ? some(42) : none();
 * ```
 */
export const none = <T>(): Option<T> => null;
