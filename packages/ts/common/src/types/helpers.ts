/**
 * Returns the union of value types in an object type.
 *
 * @template T - The object type to extract values from.
 */
export type ValueOf<T> = T[keyof T];

/**
 * Forces TypeScript to flatten and display complex intersection and mapped types
 * in a more readable format in IDE tooltips, error messages, and type checking.
 *
 * @template T - The type to prettify/flatten.
 */
export type Prettify<T> = {
  [K in keyof T]: T[K];
} & {};

/**
 * Creates a new type where specified properties are optional while keeping
 * all other properties required. Useful for creating flexible APIs where
 * certain fields have defaults or are conditionally required.
 *
 * @template T - The source object type.
 * @template K - The keys to make optional (must be actual keys that exist on `T`).
 */
export type WithPartial<T, K extends keyof T> = Prettify<
  Omit<T, K> & Partial<Pick<T, K>>
>;

/**
 * Creates a new type where specified properties are required while keeping
 * all other properties are untouched.
 *
 * @template T - The source object type.
 * @template K - The keys to make required.
 */
export type WithRequired<T, K extends keyof T> = Prettify<
  Omit<T, K> & Required<Pick<T, K>>
>;

/**
 * A strict version of TypeScript's built-in `Omit` utility type that preserves
 * discriminated union structure, unlike the standard `Omit` which flattens unions
 * into a single object type with optional properties.
 *
 * @template T - The source type (object or union of objects).
 * @template K - The keys to omit (must be actual keys that exist on `T`).
 */
export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;

/**
 * An object with only fields found in all members of an union of objects.
 *
 * @template T - The union of object types to find the intersection of.
 *
 * @example
 * type A = { a: string; b: number };
 * type B = { a: string; c: boolean };
 * type C = IntersectionOfObjectUnion<A | B>; // { a: string }
 */
export type IntersectionOfObjectUnion<T extends object> = Pick<
  T,
  KeysInAllMembers<T>
>;

type KeysInAllMembers<T> = {
  [K in keyof T]: K;
}[keyof T];

/**
 * A tuple is an array with a fixed length
 *
 * @template T - The type of elements in the tuple.
 */
export type Tuple<T> = [] | [T, ...T[]];
