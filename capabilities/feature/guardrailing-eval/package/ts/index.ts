/**
 * @mistralai-capabilities/feature-guardrailing-eval — npm package entry.
 *
 * This capability ships no TypeScript library: its measurable surface is the Python guardrailing-eval
 * harness (`package/py`) and the vendored template (`template/`). The npm package is how that
 * template zone and this capability's `capability.json` reach an app installed from the npm
 * registry, which is why `packages` declares `"ts"` — and it keeps the capability a type-checkable
 * workspace member.
 */

/** Marker type: this capability exposes no TypeScript runtime surface. */
export type GuardrailEvalCapability = never;
