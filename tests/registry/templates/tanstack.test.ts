import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { readTemplateJson } from "../support/registry-fixtures";
import { capabilityDir, readJson, templateDir } from "../support/template-tree";

/**
 * The TanStack family moves in lockstep, converging on one `@tanstack/router-core`. A caret on a
 * direct dep lets the packages float, so a fresh `bun install` resolves `-core` packages against
 * different versions and the SSR build dies on missing exports. These tests keep the direct deps
 * exact and the `-core` packages pinned via overrides.
 */
const isExact = (spec: string) => /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/.test(spec);
const tanstack = (deps: Record<string, string> = {}): Record<string, string> =>
  Object.fromEntries(Object.entries(deps).filter(([name]) => name.startsWith("@tanstack/")));

describe("tanstack coherence", () => {
  const webPkg = readTemplateJson<{
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  }>(join(templateDir("tanstack-start"), "apps", "web", "package.json"));
  const WEB = { ...tanstack(webPkg.dependencies), ...tanstack(webPkg.devDependencies) };
  const corePkg = readTemplateJson<{
    overrides?: Record<string, string>;
    workspaces?: { catalog?: Record<string, string> };
  }>(join(templateDir("core"), "package.json"));
  const OVERRIDES = tanstack(corePkg.overrides ?? {});

  // `apps/web/package.json` is plain JSON, so a private pin there would reach every app, including
  // one generated without the design system. Its own dependency-only member carries it instead.
  test("the design system pins its private UI dependency in its own member, not apps/web or core", () => {
    const ownedPeers = readJson<{ peerDependencies?: Record<string, string> }>(
      join(capabilityDir("mistral-design-system"), "package.json"),
    ).peerDependencies;
    const member = readTemplateJson<{ dependencies?: Record<string, string> }>(
      join(
        templateDir("mistral-design-system"),
        "packages",
        "ts",
        "mistral-design-system",
        "package.json",
      ),
    ).dependencies;
    const name = "@mistralai/ui";
    expect(member?.[name]).toBe(ownedPeers?.[name]);
    expect(isExact(member?.[name] ?? "")).toBe(true);
    expect(webPkg.dependencies).not.toHaveProperty(name);
    expect(corePkg.workspaces?.catalog).not.toHaveProperty(name);
  });

  // Every app ships this manifest verbatim, so a first-party entry would reach an app generated
  // without the capability that provides it: a `workspace:*` member bun cannot find, or a private
  // package the app has no reason to fetch.
  test("apps/web names no first-party @mistral or @mistralai package", () => {
    const firstParty = Object.keys({ ...webPkg.dependencies, ...webPkg.devDependencies }).filter(
      (name) => /^@mistral(?:ai)?\//.test(name),
    );
    expect(firstParty).toEqual([]);
  });

  // A caret/range on a direct @tanstack dep is the exact skew that broke the SSR build. The
  // router/start family releases in lockstep so an exact pin is mandatory there; react-query rides a
  // separate train but is pinned exactly too, so the rule stays one blanket "nothing @tanstack floats".
  test("every @tanstack/* dep in the web app is pinned exactly", () => {
    const floated = Object.entries(WEB)
      .filter(([, spec]) => !isExact(spec))
      .map(([name, spec]) => `${name}@${spec}`);
    expect(floated, `web app floats @tanstack deps: ${floated.join(", ")}`).toEqual([]);
  });

  // Exact direct pins keep the app's own deps coherent, but a sibling capability could still pull a
  // second copy of a `-core` package; root overrides force one version tree-wide. `router-core` is
  // where the router side converges, `start-server-core`/`start-plugin-core` the start side (the
  // half the earlier fix missed). All three must be present and exact, or the family can float.
  test("core overrides pin the tanstack -core packages that must not float", () => {
    for (const name of [
      "@tanstack/router-core",
      "@tanstack/start-server-core",
      "@tanstack/start-plugin-core",
    ]) {
      const spec = OVERRIDES[name];
      expect(spec, `core overrides missing ${name}`).toBeDefined();
      expect(isExact(spec!), `core override ${name}@${spec} is not exact`).toBe(true);
    }
  });

  // Per-side exactness is not enough: the web app and the root overrides pin the same packages in
  // two files that cannot see each other. Two different exact versions pass both tests above while
  // re-opening the skew this fixes. Every package named in both files must name one version.
  test("the web app and core overrides agree on every shared @tanstack pin", () => {
    const disagreements = Object.keys(WEB)
      .filter((name) => name in OVERRIDES && WEB[name] !== OVERRIDES[name])
      .map((name) => `${name}: web ${WEB[name]} != override ${OVERRIDES[name]}`);
    expect(disagreements, disagreements.join("; ")).toEqual([]);
  });
});
