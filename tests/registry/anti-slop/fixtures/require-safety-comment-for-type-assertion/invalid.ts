type Widget = { id: number };

declare function load(): { id: number };

// A bare `as T` with no justifying comment.
export const bare = load() as Widget;

// An angle-bracket assertion with no justifying comment.
export const angle = <Widget>load();

// A preceding comment that does not contain the SAFETY marker.
// this explains something unrelated
export const wrongMarker = load() as Widget;

// The statement kind (VariableDeclaration) is a comment owner, but the marker is
// attached in the wrong place: a trailing comment is never read as a justification.
export const trailing = load() as Widget; // SAFETY: trailing comments do not count
