type Widget = { id: number };

declare function load(): { id: number };

// A const assertion is exempt entirely.
export const literal = [1, 2] as const;

// The marker sits immediately before the containing VariableDeclaration.
// SAFETY: value decoded at its boundary
export const decoded = load() as Widget;

// The marker sits before a ReturnStatement owner.
export function returned(): Widget {
	// SAFETY: result validated before return
	return load() as Widget;
}

// The marker sits before an ExpressionStatement owner.
declare function consume(widget: Widget): void;
// SAFETY: shape asserted for the consumer call
consume(load() as Widget);

// The marker sits before a ThrowStatement owner.
export function thrower(): never {
	// SAFETY: error payload shape verified
	throw load() as Widget;
}

// The marker sits before a PropertyDefinition owner.
export class Holder {
	// SAFETY: field value validated on construction
	field = load() as Widget;
}

// A block comment carrying the marker is accepted by `markerPattern`.
/* SAFETY: block-comment justification is honored */
export const blockJustified = load() as Widget;
