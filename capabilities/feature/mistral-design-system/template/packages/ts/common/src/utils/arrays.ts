import { type ShamelessAny } from "../types/shameless-any";

/**
 * Maps over a tuple while preserving its exact length and structure at the type level.
 *
 * Unlike regular `Array.prototype.map`, this function maintains tuple types,
 * ensuring that the output tuple has the same number of elements as the input.
 * This is particularly useful when working with fixed-length arrays where
 * type safety matters.
 *
 * @template List - The input tuple type (readonly array).
 * @template MapFn - The mapping function type.
 *
 * @param list - The tuple to map over.
 * @param mapFn - The function to apply to each element.
 *
 * @returns A new tuple with the same length as the input, where each element
 * is the result of applying `mapFn` to the corresponding input element
 *
 * @example
 * ```ts
 * // Transform numbers to strings
 * const numbers = [1, 2, 3] as const;
 * const strings = mapTuple(numbers, (n) => String(n));
 * // Type: readonly ["1", "2", "3"]
 * ```
 *
 * @example
 * ```ts
 * // Transform mixed-type tuples
 * const mixed = [1, 'hello', true] as const;
 * const lengths = mapTuple(mixed, (item) => String(item).length);
 * // Type: readonly [1, 5, 4]
 * ```
 *
 * @example
 * ```ts
 * // Extract properties from objects
 * const users = [
 *   { id: 1, name: 'Alice' },
 *   { id: 2, name: 'Bob' }
 * ] as const;
 * const names = mapTuple(users, (user) => user.name);
 * // Type: readonly ["Alice", "Bob"]
 * ```
 */
export function mapTuple<
  List extends readonly ShamelessAny[],
  MapFn extends (item: List[number]) => ShamelessAny,
>(list: List, mapFn: MapFn): { [K in keyof List]: ReturnType<MapFn> };
export function mapTuple(
  list: unknown[],
  mapFn: (item: unknown) => unknown,
): unknown[] {
  return list.map(mapFn);
}
