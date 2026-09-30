declare const value: string;

// SAFETY: a single assertion carries its justification and is permitted.
const single = value as number;

// A chain made only of const assertions preserves narrowness and is allowed.
const constOnly = value as const as const;
