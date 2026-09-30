// Each dictionary below exposes an escape-hatch value type the rule must reject.

// `Record` with an `unknown` value.
export type UnknownDict = Record<string, unknown>;

// `Record` with an `any` value.
export type AnyDict = Record<string, any>;

// An index signature whose value is the broad `object` type.
export type ObjectIndex = { [key: string]: object };

// A mapped type over a broad key with an unsafe value.
export type MappedDict = { [K in string]: unknown };

// An alias whose resolved type is one of the unsafe dictionaries above.
export type ReachesUnsafe = UnknownDict;

// Nested: only the outer node is reported. The inner `Record<string, unknown>` is
// suppressed because an enclosing type node is already an unsafe dictionary, so this
// construct contributes exactly one diagnostic, not two.
export type NestedUnsafe = Record<string, unknown | Record<string, unknown>>;
