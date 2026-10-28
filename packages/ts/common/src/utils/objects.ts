import { omitBy } from "remeda";

import type { Prettify } from "../types/helpers";

type KeysWithOnlyUndefinedValues<T extends object> = {
  [K in keyof T]-?: [T[K]] extends [undefined] ? K : never;
}[keyof T];

type KeysWithPossibleUndefinedValues<T extends object> = {
  [K in keyof T]-?: [T[K]] extends [undefined]
    ? never
    : undefined extends T[K]
      ? K
      : never;
}[keyof T];

type OmitUndefinedValuesResultForObject<T extends object> = Prettify<
  {
    [K in keyof T as K extends
      | KeysWithOnlyUndefinedValues<T>
      | KeysWithPossibleUndefinedValues<T>
      ? never
      : K]: T[K];
  } & {
    [K in KeysWithPossibleUndefinedValues<T>]?: Exclude<T[K], undefined>;
  }
>;

export type OmitUndefinedValuesResult<T extends object> = T extends unknown
  ? OmitUndefinedValuesResultForObject<T>
  : never;

/**
 * Removes keys whose value is `undefined`.
 *
 * This helper only applies to the top-level object shape and preserves the references of nested values that stay in the output.
 */
export function omitUndefinedValues<T extends object>(
  value: T,
): OmitUndefinedValuesResult<T> {
  return omitBy(
    value,
    (entryValue) => entryValue === undefined,
  ) as unknown as OmitUndefinedValuesResult<T>;
}
