/**
 * An optional value type that can either be a `Some<T>` or `null`.
 *
 * @template T - The type of the value when present.
 */
export type Option<T> = Some<T> | null;

/**
 * Represents a value that is present.
 *
 * @template T - The type of the value.
 */
export type Some<T> = {
  value: T;
};
