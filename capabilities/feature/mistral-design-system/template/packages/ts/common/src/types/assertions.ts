/**
 * Type assertion utilities for compile-time type checking.
 * Useful for asserting type relationships in both test files and business logic.
 *
 * @template T - The type to assert (must extend `true`).
 */
export type Expect<T extends true> = T;

/**
 * Compares two types for equality at compile time.
 * Returns `true` if the types are equal, `false` otherwise.
 * Useful for asserting type relationships in both test files and business logic.
 *
 * @template T - The first type to compare.
 * @template U - The second type to compare.
 */
export type Equal<T, U> =
  (<G>() => G extends T ? 1 : 2) extends <G>() => G extends U ? 1 : 2
    ? true
    : false;
