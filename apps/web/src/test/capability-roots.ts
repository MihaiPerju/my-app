import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * The first-party capability TS sources, wherever this app keeps them. A checkout holds them at
 * `packages/ts/mistralai-capabilities`; a generated app links each into
 * `node_modules/@mistralai-capabilities/<id>/package/ts`. Scope to `package/ts` to skip the bundled `template/` copy.
 */
export function capabilityLibraryRoots(appRoot: string): string[] {
  const linked = join(appRoot, "node_modules", "@mistralai-capabilities");
  if (!existsSync(linked)) return [];
  return readdirSync(linked)
    .map((id) => join(linked, id, "package", "ts"))
    .filter((directory) => existsSync(directory));
}
