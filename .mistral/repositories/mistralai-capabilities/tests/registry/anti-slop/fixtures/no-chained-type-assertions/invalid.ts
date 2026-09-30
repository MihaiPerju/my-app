declare const value: string;

// SAFETY: fixture exercises the `as unknown as T` double-assertion chain.
const doubleAs = value as unknown as number;

// SAFETY: fixture exercises the angle-bracket assertion chain.
const angle = <number>(<unknown>value);

// SAFETY: fixture exercises the parenthesized assertion chain.
const parenthesized = (value as unknown) as number;

// SAFETY: fixture exercises a mixed `as const` + `as T` chain.
const mixedConst = value as const as number;
