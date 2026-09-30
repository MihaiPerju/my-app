declare function load(): { id: number };

// The asserted binding never widened: its type flows through unchanged, so there is
// no widen-then-assert pattern. (The SAFETY comment satisfies the separate
// assertion rule.)
export function preciseFlow(): { id: number } {
	const value: { id: number } = load();
	// SAFETY: value keeps its validated type end to end
	return value as { id: number };
}

// Shadowing: the outer `widened` is a widened `unknown`, but the assertion resolves
// to the inner, freshly declared `widened`, which was never widened. The rule must
// resolve the shadowing binding and stay silent.
export function shadowing(): { id: number } {
	const widened: unknown = load();
	void widened;
	{
		const widened = load();
		// SAFETY: the inner binding is a fresh, precise value
		return widened as { id: number };
	}
}
