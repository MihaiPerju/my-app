// A dictionary with a concrete value type gives callers a real contract.
export type StringDict = Record<string, string>;

// A `Record` whose value is a named local alias resolving to a concrete type.
export type Id = string;
export type AliasedDict = Record<string, Id>;

// A bare reference to a locally declared alias: the rule exempts plain alias
// consumer uses (no type arguments, outside a type-alias declaration).
export declare const registry: StringDict;

// A type-parameter constraint is exempt even when it names an unsafe dictionary,
// because the constraint bounds a binder rather than declaring a value contract.
export function pick<T extends Record<string, unknown>>(input: T): T {
	return input;
}
