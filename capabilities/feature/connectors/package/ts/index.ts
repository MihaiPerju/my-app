/**
 * @mistralai-capabilities/feature-connectors — npm package entry.
 *
 * This capability ships no library: everything it contributes is the connector slots, carried
 * in the vendored template (template/). The npm package is how that template zone and this
 * capability's `capability.json` reach an app installed from the npm registry, which is why
 * `packages` declares `"ts"` — and it keeps the capability a type-checkable workspace member.
 */

/** Marker type: this capability exposes no runtime surface. */
export type ConnectorsCapability = never;
