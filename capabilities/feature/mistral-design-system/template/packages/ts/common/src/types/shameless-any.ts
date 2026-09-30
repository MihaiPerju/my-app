/**
 * A type alias for `any` that should be used sparingly.
 *
 * This type exists to make it explicit when `any` is intentionally used,
 * typically in type constraints or utility types where `any` is necessary
 * but we want to avoid using it directly throughout the codebase.
 *
 * @example
 * ```ts
 * // Used in type constraints where we need maximum flexibility
 * type FlexibleFunction<T extends ShamelessAny> = (arg: T) => T;
 * ```
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- `any` is ok in some cases like type constraints
export type ShamelessAny = any;
