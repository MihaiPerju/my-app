/**
 * Anti-slop plugin vendoring guard.
 *
 * The plugin exists twice on purpose: `tools/oxlint/anti-slop/` is what this repo lints itself
 * with, and `capabilities/tooling/code-quality/template/tools/oxlint/anti-slop/` is what an app that
 * selects the code-quality capability receives. Oxlint resolves a `jsPlugins` specifier relative to
 * the config that declares it, and a generated app has no path back to this repo, so the template
 * genuinely needs its own copy.
 *
 * What it does not need is a second source of truth. `tools/` is canonical; the template copy is
 * derived and must stay byte-identical, or a rule fixed in one place goes on failing in the other —
 * and the divergence would only ever surface as a generated app that lints differently from the
 * registry that shipped it. Resync with
 *
 *     bun tests/registry/anti-slop/vendor.gen.ts
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";

import { capabilityDir, REGISTRY_ROOT, walk } from "../support/template-tree";

const CANONICAL = join(REGISTRY_ROOT, "tools", "oxlint", "anti-slop");
const VENDORED = join(capabilityDir("code-quality"), "template", "tools", "oxlint", "anti-slop");

const relativePaths = (root: string) =>
  walk(root)
    .map((path) => relative(root, path))
    .toSorted();

describe("anti-slop plugin vendoring", () => {
  test("the canonical plugin is not empty", () => {
    // Guards the guard: both trees being absent would otherwise pass every check below.
    expect(relativePaths(CANONICAL).length).toBeGreaterThan(0);
  });

  test("the template ships exactly the canonical file set", () => {
    expect(relativePaths(VENDORED)).toEqual(relativePaths(CANONICAL));
  });

  test("every vendored file is byte-identical to its canonical source", () => {
    const drift = relativePaths(CANONICAL).filter(
      (path) =>
        readFileSync(join(VENDORED, path), "utf8") !== readFileSync(join(CANONICAL, path), "utf8"),
    );
    expect(drift).toEqual([]);
  });
});
