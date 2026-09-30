/**
 * @mistralai-capabilities/feature-search — npm package entry.
 *
 * This capability ships no library: everything it contributes is the search backend wiring, carried
 * in the vendored template (template/). The npm package is how that template zone and this
 * capability's `capability.json` reach an app installed from the npm registry, which is why
 * `packages` declares `"ts"` — and it keeps the capability a type-checkable workspace member.
 */

/** Marker type: this capability exposes no runtime surface. */
export type SearchCapability = never;
