/** Route declarations: what `capability add` writes into apps.json, and never into the descriptor. */
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { RouteDeclarationsSchema } from "../../../scripts/registry/build-registry";
import { readManifests } from "../../../scripts/shared/manifests";
import { readJson, REGISTRY_ROOT, templateDir } from "../support/template-tree";

const manifests = readManifests(REGISTRY_ROOT);

const routesOf = (path: string) => manifests.find((manifest) => manifest.path === path)?.routes;

// The CLI adds routes to `metadata.appDir`, or else to the one `apps/<dir>` the template writes,
// and skips them when neither names a single directory.
const routeTarget = (appDir: string | undefined, templateApps: readonly string[]) =>
  appDir ?? (templateApps.length === 1 ? `apps/${templateApps[0]}` : undefined);

describe("capability routes", () => {
  test.each([["feature/mcp-apps", [{ path: "/mcp", mcp: true }]]])(
    "%s declares %j",
    (path, routes) => {
      expect(routesOf(path)).toEqual(routes);
    },
  );

  test.each([
    ["an mcp route", [{ path: "/mcp", mcp: true }]],
    ["a plain route", [{ path: "/hooks" }]],
    ["a nested route", [{ path: "/api/v2" }, { path: "/mcp", mcp: false }]],
  ])("accepts %s", (_, routes) => {
    expect(RouteDeclarationsSchema.safeParse(routes).success).toBe(true);
  });

  test.each([
    ["an empty list", []],
    ["a relative path", [{ path: "mcp" }]],
    ["a trailing slash", [{ path: "/mcp/" }]],
    ["the root", [{ path: "/" }]],
    ["a dot segment", [{ path: "/a/../mcp" }]],
    ["a non-boolean mcp", [{ path: "/mcp", mcp: "yes" }]],
    ["an unknown key", [{ path: "/mcp", prefix: true }]],
    ["a repeated path", [{ path: "/mcp" }, { path: "/mcp", mcp: true }]],
  ])("rejects %s", (_, routes) => {
    expect(RouteDeclarationsSchema.safeParse(routes).success).toBe(false);
  });

  test.each([
    ["a declared appDir", "apps/api", ["api", "worker"], "apps/api"],
    ["a single template app", undefined, ["api"], "apps/api"],
    ["two template apps", undefined, ["api", "worker"], undefined],
    ["no template app", undefined, [], undefined],
  ])("resolves the route target from %s", (_, appDir, templateApps, expected) => {
    expect(routeTarget(appDir, templateApps)).toEqual(expected);
  });

  test("routes land on a module that serves HTTP", () => {
    const httpDirs = new Set(
      manifests
        .filter((manifest) => manifest.module !== undefined && manifest.module.serve !== "worker")
        .map((manifest) => manifest.metadata?.appDir),
    );
    const stranded = manifests
      .filter((manifest) => manifest.routes !== undefined && manifest.module === undefined)
      .filter((manifest) => {
        const apps = join(templateDir(manifest.path), "apps");
        const templateApps = existsSync(apps)
          ? readdirSync(apps, { withFileTypes: true })
              .filter((entry) => entry.isDirectory())
              .map((entry) => entry.name)
          : [];
        return !httpDirs.has(routeTarget(manifest.metadata?.appDir, templateApps));
      })
      .map((manifest) => manifest.path);
    expect(stranded).toEqual([]);
  });

  // Released CLIs parse descriptor rows strictly, so a `routes` key there would fail every command.
  test("registry.json carries no routes", () => {
    const descriptor = readJson<{ capabilities: { id: string; routes?: unknown }[] }>(
      join(REGISTRY_ROOT, "registry.json"),
    );
    expect(descriptor.capabilities.filter((cap) => "routes" in cap).map((cap) => cap.id)).toEqual(
      [],
    );
  });
});
