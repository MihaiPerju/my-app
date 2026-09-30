// Every alias here resolves to `unknown` through a different path the rule must follow.

// Direct: the alias is literally `unknown`.
export type DirectUnknown = unknown;

// Union: one arm is `unknown`, so the whole alias collapses to `unknown`.
export type UnionWithUnknown = string | unknown;

// Parenthesized: the rule unwraps `TSParenthesizedType` before matching.
export type ParenthesizedUnknown = (unknown);

// Indirect: this reaches `unknown` only by resolving another visible alias.
export type ReachesUnknownThroughAlias = DirectUnknown;
