/**
 * @mistralai-capabilities/backend-fastapi — npm package entry.
 *
 * This capability ships an app module, not a library: everything it contributes is the vendored
 * template (template/apps/api). The npm package is how that template zone and this capability's
 * `capability.json` reach an app installed from the npm registry, which is why `packages`
 * declares `"ts"` — and it keeps the capability a type-checkable workspace member.
 */

export type FastApiCapability = never;
