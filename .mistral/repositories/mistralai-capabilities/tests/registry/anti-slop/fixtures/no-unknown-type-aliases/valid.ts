// A concrete alias keeps a real contract; nothing to hide.
export type Concrete = { id: number };

// A union of concrete arms never reaches `unknown`.
export type ConcreteUnion = string | number;

// The type parameter is named `unknown`-adjacent but is a lexical binder, not the
// `unknown` keyword and not an alias it shadows. `type-alias-resolution.ts` treats
// `Unknown` as a type-parameter name, so `visibleTypeAlias` returns null and the
// body never resolves to the `unknown` keyword.
export type Box<Unknown> = Unknown;

// A generic alias whose parameter is substituted with a concrete type resolves to
// that concrete type, not `unknown`.
export type Wrapper<Value> = Value;
export type Applied = Wrapper<string>;
