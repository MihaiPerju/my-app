/**
 * Guards the packages that must resolve to exactly one copy in a generated app.
 *
 * A capability package declares React deps as peers and dev-deps, so the CLI's `file:` vendoring
 * nests a second copy; two React contexts mean a hook cannot see the app's provider. A root
 * `overrides` entry collapses each name `apps/web` pins and a package peer-depends on to one version.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { capabilityDir, capabilityLocalIds, readJson, templateDir } from "../support/template-tree";

type Manifest = {
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  overrides?: Record<string, string>;
};

/**
 * What the app pins: `apps/web`'s own dependencies, the dependency-only `packages/ts/*` members a
 * capability template ships for it (`@mistralai/ui`, `pdfjs-dist`, ...; a member that pins a private
 * package ships as `package.json.hbs`), and the real `dependencies` of every capability package,
 * which the CLI installs at the app root. The hoisted linker lifts all of them next to each other.
 */
function appPins() {
  const pins = {
    ...readJson<Manifest>(join(templateDir("tanstack-start"), "apps", "web", "package.json"))
      .dependencies,
  };
  for (const id of capabilityLocalIds) {
    const members = join(templateDir(id), "packages", "ts");
    const paths = [
      join(capabilityDir(id), "package.json"),
      ...(existsSync(members)
        ? readdirSync(members).flatMap((member) =>
            ["package.json", "package.json.hbs"].map((file) => join(members, member, file)),
          )
        : []),
    ];
    for (const path of paths) {
      if (!existsSync(path)) continue;
      for (const [name, spec] of Object.entries(readJson<Manifest>(path).dependencies ?? {})) {
        if (!name.startsWith("@mistralai-capabilities/")) pins[name] ??= spec;
      }
    }
  }
  return pins;
}

/** Every peer spec any capability's PUBLISHED package declares, keyed by dependency name. */
function peerSpecs(): Map<string, string[]> {
  const specs = new Map<string, string[]>();
  for (const id of capabilityLocalIds) {
    const path = join(capabilityDir(id), "package.json");
    if (!existsSync(path)) continue;
    for (const [name, spec] of Object.entries(readJson<Manifest>(path).peerDependencies ?? {})) {
      specs.set(name, [...(specs.get(name) ?? []), spec]);
    }
  }
  return specs;
}

const EXACT = /^\d+\.\d+\.\d+$/;

describe("single-copy dependencies", () => {
  // SAFETY: Manifest is this test's schema for the repo-owned core package.json; a mismatch fails
  // the assertions reading it here.
  const coreManifest = JSON.parse(
    readFileSync(join(templateDir("core"), "package.json"), "utf8"),
  ) as Manifest;
  const overrides = coreManifest.overrides ?? {};
  const web = appPins();
  const peers = peerSpecs();

  test("a floating peer range against an exactly-pinned web dependency is overridden", () => {
    // An exact pin in `apps/web` is the app's statement that this name is a singleton. A peer
    // declared at the SAME exact version cannot split (radix, react-resizable-panels); a peer
    // declared as a range can float one patch ahead, and then bun has two versions to install and
    // nests one. Only an override forces them back onto one copy.
    const unprotected = [...peers]
      .filter(([name, specs]) => {
        const pin = web[name];
        if (!pin || !EXACT.test(pin)) return false;
        return specs.some((spec) => spec !== pin) && !(name in overrides);
      })
      .map(
        ([name, specs]) =>
          `${name}: web pins ${web[name]}, peers declare ${[...new Set(specs)].join(", ")}`,
      );
    expect(unprotected).toEqual([]);
  });

  test("each override agrees with the version apps/web pins", () => {
    // A drifting override is worse than none: it silently downgrades the app's own copy. Only
    // literal versions are comparable -- `catalog:` and `workspace:*` resolve elsewhere.
    const disagreeing = Object.entries(overrides)
      .filter(
        ([name, spec]) => EXACT.test(spec) && EXACT.test(web[name] ?? "") && web[name] !== spec,
      )
      .map(([name, spec]) => `${name}: web pins ${web[name]}, override says ${spec}`);
    expect(disagreeing).toEqual([]);
  });

  test("overrides holds no comment keys", () => {
    // bun 1.3 and 1.4 disagree on a `//` key here, so a lockfile written on the host fails
    // `bun install --frozen-lockfile` in the image. Keep notes in a top-level `//overrides`.
    expect(Object.keys(overrides).filter((name) => name.startsWith("//"))).toEqual([]);
  });
});
