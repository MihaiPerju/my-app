/** Shared readers for registry invariant tests. Keep test policy in the suites that consume them. */
import { expect } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { capabilities, renderHbs, toLocalId } from "./selection";
import {
  capabilityDir,
  capabilityLocalIds,
  readJson,
  REGISTRY_ROOT,
  templateDir,
} from "./template-tree";

export function readTemplateJson<T>(path: string): T {
  // SAFETY: T is the caller's schema for a repo-owned template; a mismatch fails its assertions.
  return JSON.parse(readTemplateText(path)) as T;
}

/** A template file by its rendered path, its `.hbs` carrier rendered with every capability present. */
export function readTemplateText(path: string): string {
  if (existsSync(path)) return readFileSync(path, "utf8");
  return renderHbs(readFileSync(`${path}.hbs`, "utf8"), new Set(capabilityLocalIds));
}

/** Core's committed root Python manifest: the raw content the pin generator patches. */
export function readCorePyprojectRaw(): string {
  return readFileSync(join(templateDir("core"), "pyproject.toml"), "utf8");
}

/** Unescaped expressions the CLI does not deliberately support in capability templates. */
export function unsupportedHbsExpressions(source: string): string[] {
  const unsupported: string[] = [];
  for (const match of source.matchAll(/(?<!\\)\{\{[\s\S]*?\}\}/g)) {
    const token = match[0];
    const expression = token.slice(2, -2).trim();
    if (expression === "projectName" || expression === "/if" || expression === "/unless") continue;
    const gate = /^#(?:if|unless) \(has "([^"]+)"\)$/.exec(expression);
    // An authored gate may name a capability bare (when unambiguous) or as `kind/id`; it is
    // supported when it resolves to a real capability. toLocalId throws on an unknown/ambiguous
    // reference, which is exactly the unsupported case.
    if (gate) {
      try {
        toLocalId(gate[1]!);
        continue;
      } catch {
        // falls through to `unsupported`
      }
    }
    unsupported.push(token);
  }
  return unsupported;
}

export const REGISTRY_ID = readJson<{ id: string }>(join(REGISTRY_ROOT, "registry.json")).id;
export const PY_NAMESPACE = REGISTRY_ID.replace(/-/g, "_");

type UvSource = Record<string, string | boolean>;

type PyProject = {
  project?: {
    name?: string;
    dependencies?: string[];
    "optional-dependencies"?: Record<string, string[]>;
  };
  tool?: {
    uv?: { sources?: Record<string, UvSource>; "build-backend"?: { "module-name"?: string } };
  };
};

export type PyCapability = {
  id: string;
  dir: string;
  pyproject: PyProject;
  moduleName?: string;
};

let cachedPyCapabilities: PyCapability[] | undefined;

/** Every capability that declares a Python package, parsed once for all invariant suites. */
export function pyCapabilities(): PyCapability[] {
  cachedPyCapabilities ??= [...capabilities]
    .filter(([, capability]) => (capability.packages ?? []).includes("py"))
    .map(([id]) => {
      const dir = join(capabilityDir(id), "package", "py");
      const manifest = join(dir, "pyproject.toml");
      expect(existsSync(manifest), `${id} declares "py" but ships no pyproject.toml`).toBe(true);
      // SAFETY: this is a repo-owned pyproject; malformed fields fail the consuming guards.
      const pyproject = Bun.TOML.parse(readFileSync(manifest, "utf8")) as PyProject;
      return {
        id,
        dir,
        pyproject,
        moduleName: pyproject.tool?.uv?.["build-backend"]?.["module-name"],
      };
    });
  return cachedPyCapabilities;
}

/** Return sibling namespace segments imported by Python statements in `source`. */
export function siblingImports(source: string): Set<string> {
  const found = new Set<string>();
  const dotted = new RegExp(
    `^[ \\t]*(?:from|import)[ \\t]+${PY_NAMESPACE}\\.([A-Za-z0-9_]+)`,
    "gm",
  );
  for (const [, segment] of source.matchAll(dotted)) found.add(segment!);

  const bare = new RegExp(
    `^[ \\t]*from[ \\t]+${PY_NAMESPACE}[ \\t]+import[ \\t]+(\\([^)]*\\)|.*)`,
    "gm",
  );
  for (const [, clause] of source.matchAll(bare)) {
    for (const item of clause!.replace(/[()]/g, "").split(",")) {
      const name = item.trim().split(/[ \t]/)[0];
      if (name) found.add(name);
    }
  }
  return found;
}
