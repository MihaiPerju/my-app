declare function load(): { id: number };

// A known-typed const is widened to `unknown`, then asserted back to a narrower
// type. The rule reads the widened binding's evidence from `source`'s annotation,
// so no value-widening (`no-known-value-widening`) fires at the declaration itself
// because `load()` supplies no syntactic evidence. The SAFETY comment keeps
// `require-safety-comment-for-type-assertion` from also firing on the assertion.
export function widenThenAssert(): { id: number } {
	const source: { id: number } = load();
	const widened: unknown = source;
	// SAFETY: source carried its validated type before it was widened
	return widened as { id: number };
}

// Same flow with a parenthesized broad type. `broadTypeKind` unwraps the
// `TSParenthesizedType`, so the widening is still detected.
export function parenthesizedWidening(): { id: number } {
	const source: { id: number } = load();
	const widened: (unknown) = source;
	// SAFETY: source carried its validated type before it was widened
	return widened as { id: number };
}
