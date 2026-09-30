/**
 * Branded types allow to create primitive types (eg. `string`s) that are
 * statically unassignable to each other. Useful to avoid mixing different
 * types of data that are represented by the same primitive type.
 *
 * @template T - The base type to brand.
 * @template U - The brand identifier (typically a unique string literal type).
 */
export type Branded<T, U> = T & { readonly __brand: U };

/**
 * Creates a branded value by casting `value` to `Branded<T, U>`.
 *
 * Use this constructor instead of a raw `as Branded<T, U>` cast so that
 * branding is explicit and easy to search for in the codebase.
 *
 * @template T - The base type of the value.
 * @template U - The brand identifier.
 * @param value - The value to brand.
 * @returns The same value cast to `Branded<T, U>`.
 *
 * @example
 * ```ts
 * type UserId = Branded<string, "UserId">;
 * const id = brand<string, "UserId">("user-123");
 * ```
 */
export const brand = <T, U>(value: T): Branded<T, U> => value as Branded<T, U>;
