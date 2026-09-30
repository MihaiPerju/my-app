import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { basename, join, relative } from "node:path";

import { readTemplateJson } from "../support/registry-fixtures";
import { capabilityLocalIds, templateDir, walk } from "../support/template-tree";

/**
 * Generated-app invariants that only surface with a particular selection, a developer's global bun
 * policy, or inside the web image -- each found by building Chat-with-XXX apps on this registry.
 */

type Manifest = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
};

const coreBunfig = (): string => readFileSync(join(templateDir("core"), "bunfig.toml"), "utf8");

// SAFETY: repo-owned TOML; absent keys become undefined and fail the assertions below.
const coreInstall = (): {
  linker?: string;
  registry?: string;
  minimumReleaseAgeExcludes?: string[];
} => (Bun.TOML.parse(coreBunfig()) as { install?: Record<string, never> }).install ?? {};

/** The first-party packages `deps` pins from an index (not vendored). */
const indexPins = (deps: Record<string, string> = {}): string[] =>
  Object.entries(deps).flatMap(([name, spec]) =>
    /^@mistral(?:ai)?\//.test(name) && !/^(?:workspace|file|link|catalog):/.test(spec)
      ? [name]
      : [],
  );

/** Every first-party npm package a capability template pins from an index (not vendored). */
function firstPartyIndexPins(): string[] {
  return [...new Set(firstPartyIndexPinManifests().flatMap(({ names }) => names))].toSorted();
}

/**
 * Each template manifest that pins a first-party package from an index, with those names and the
 * ones bun installs from it (an optional peer is never fetched).
 */
function firstPartyIndexPinManifests(): { path: string; names: string[]; installed: string[] }[] {
  return capabilityLocalIds.flatMap((id) =>
    walk(templateDir(id)).flatMap((abs) => {
      const file = basename(abs);
      if (file !== "package.json" && file !== "package.json.hbs") return [];
      const manifest = readTemplateJson<Manifest>(abs.replace(/\.hbs$/, ""));
      const peers = indexPins(manifest.peerDependencies);
      const installed = [
        ...indexPins(manifest.dependencies),
        ...indexPins(manifest.devDependencies),
        ...indexPins(manifest.optionalDependencies),
        ...peers.filter((name) => manifest.peerDependenciesMeta?.[name]?.optional !== true),
      ];
      const names = [...new Set([...installed, ...peers])];
      return names.length === 0
        ? []
        : [{ path: `${id}/template/${relative(templateDir(id), abs)}`, names, installed }];
    }),
  );
}

describe("the generated app's root bunfig.toml", () => {
  // Without it a global registry (e.g. a socket proxy) is written into every bun.lock entry.
  test("pins the default install registry to public npm", () => {
    expect(coreInstall().registry).toBe("https://registry.npmjs.org");
  });

  // Capability-shipped workspace members reach apps/web only through hoisting. Package-mode `init`
  // vendors this file over the one the CLI wrote, so the CLI's own `linker` line does not survive.
  test("pins the hoisted linker", () => {
    expect(coreInstall().linker).toBe("hoisted");
  });

  // A global 48h `minimumReleaseAge` rejected `@mistralai/ui` the day it was bumped, failing
  // `mistral apps init` and every later `bun install`. Bun matches exclusions by exact name only,
  // and the local list replaces the global one, so every first-party pin must be named here.
  test("exempts every first-party package a template pins from the release-age quarantine", () => {
    const excludes = coreInstall().minimumReleaseAgeExcludes ?? [];
    expect(
      excludes.filter((name) => name.includes("*")),
      "bun does not expand globs",
    ).toEqual([]);
    expect(excludes.toSorted()).toEqual(firstPartyIndexPins());
    expect(excludes.length).toBeGreaterThan(0);
  });

  // The CLI copies plain template files before its first `bun install` and renders `.hbs` files
  // after it, together with the `.npmrc` that maps the private scopes. A plain manifest pinning a
  // private package reaches that first install and fetches it from public npm, which fails `init`.
  test("every manifest pinning a first-party package from the index is a .hbs carrier", () => {
    const plain = firstPartyIndexPinManifests()
      .filter(({ installed, path }) => installed.length > 0 && !path.endsWith(".hbs"))
      .map(({ path }) => path);
    expect(plain).toEqual([]);
  });
});

describe("the web image", () => {
  const dockerfile = readFileSync(
    join(templateDir("tanstack-start"), "deploy", "docker", "Dockerfile.web"),
    "utf8",
  );

  // The deps stage installed with bun's isolated linker while the host is hoisted, so in the dev
  // stack every route importing `@mistral/markdown` failed with `[TSCONFIG_ERROR]`.
  test("copies bunfig.toml into the deps stage before bun install", () => {
    const install = dockerfile.indexOf("bun install --frozen-lockfile");
    expect(install).toBeGreaterThan(-1);
    const copies = dockerfile
      .slice(0, install)
      .split("\n")
      .filter((line) => line.startsWith("COPY "));
    expect(copies.some((line) => line.split(/\s+/).includes("bunfig.toml"))).toBe(true);
  });

  // The hoisted linker only creates apps/web/node_modules for a version conflict, and the runtime
  // stage's COPY of a missing source fails the image build.
  test("the deps stage guarantees every node_modules the runtime stage copies", () => {
    const copied = [
      ...dockerfile.matchAll(/^COPY --from=build(?: --\S+)* (\S*node_modules) /gm),
    ].map((match) => match[1]!.replace(/^\/app\//, ""));
    expect(copied).toContain("apps/web/node_modules");
    const nested = copied.filter((path) => path !== "node_modules");
    const missing = nested.filter((path) => !dockerfile.includes(`mkdir -p ${path}`));
    expect(missing).toEqual([]);
  });

  // Under the hoisted linker Nitro traced only `tslib.es6.mjs` (the alias target) while the
  // externalized bare `tslib` import resolves to `modules/index.js` at runtime: the runtime image
  // 500'd with ERR_MODULE_NOT_FOUND. The whole package must be traced while the alias exists.
  test("the Nitro server output carries all of tslib, not just the aliased entry", () => {
    const plugin = readFileSync(
      join(
        templateDir("mistral-design-system"),
        "apps",
        "web",
        "vite-plugins",
        "mistral-design-system.ts",
      ),
      "utf8",
    );
    if (!/find: "tslib"/.test(plugin)) return;
    expect(plugin).toMatch(/traceDeps[^;]*\.push\("tslib\*"\)/);
  });
});

describe("the web shell's tests are selection-agnostic", () => {
  const SHELLS = ["frontend/tanstack-start", "feature/mistral-design-system"];
  const featureIds = capabilityLocalIds.flatMap((id) => {
    const featuresDir = join(templateDir(id), "apps", "web", "src", "features");
    return walk(featuresDir).map((abs) => relative(featuresDir, abs).split("/")[0]!);
  });
  // A route file's URL: pathless layout segments (`_app/`) and a trailing `index` do not count.
  const routes = capabilityLocalIds
    .filter((id) => !SHELLS.includes(id))
    .flatMap((id) => {
      const routesDir = join(templateDir(id), "apps", "web", "src", "routes");
      return walk(routesDir).map(
        (abs) =>
          `/${relative(routesDir, abs)
            .replace(/\.tsx?$/, "")
            .split("/")
            .filter((segment) => !segment.startsWith("_") && segment !== "index")
            .join("/")}`,
      );
    });

  // The web app and the shell ship without chat, speech or IDP; a test of their own naming those
  // routes or ids failed `check-types` in every app generated without them.
  test("the web app's and the shell's tests name no route or feature another capability contributes", () => {
    expect(featureIds.length).toBeGreaterThan(0);
    expect(routes.length).toBeGreaterThan(0);
    const offenders = SHELLS.flatMap((shell) =>
      walk(templateDir(shell))
        .filter((abs) => /\.test\.tsx?$/.test(abs))
        .flatMap((abs) => {
          const source = readFileSync(abs, "utf8");
          // String literals only: prose in comments may name a feature to explain a design choice.
          const named = [
            ...routes.filter((route) => new RegExp(`["']${route}[/?"']`).test(source)),
            ...[...new Set(featureIds)].filter((id) => new RegExp(`["']${id}["']`).test(source)),
          ];
          return named.map((name) => `${shell}/${relative(templateDir(shell), abs)}: ${name}`);
        }),
    );
    expect(offenders).toEqual([]);
  });
});
