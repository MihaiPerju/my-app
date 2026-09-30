/** The npm package that transports the private registry descriptor to the CLI. */
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { scanPackageManifests } from "../../../scripts/release/package-manifests";
import { readJson, REGISTRY_ROOT } from "../support/template-tree";

describe("descriptor package", () => {
  const packageDir = join(REGISTRY_ROOT, "packages", "registry");
  const manifest = () =>
    readJson<{ name?: string; private?: boolean; files?: string[] }>(
      join(packageDir, "package.json"),
    );

  test("is named so the CLI can `bun add` it by convention", () => {
    const registryId = readJson<{ id: string }>(join(REGISTRY_ROOT, "registry.json")).id;
    expect(manifest().name).toBe(`@${registryId}/registry`);
  });

  test("ships registry.json as its payload", () => {
    expect(manifest().files).toContain("registry.json");
  });

  test("carries no committed descriptor copy that could drift from the root one", () => {
    expect(existsSync(join(packageDir, "registry.json"))).toBe(false);
  });

  test("is published rather than skipped as build-only", () => {
    const descriptor = scanPackageManifests(REGISTRY_ROOT).find(
      ({ name }) => name === manifest().name,
    );

    expect(descriptor, "descriptor package is missing from release discovery").toBeDefined();
    expect(descriptor?.publishable, "descriptor package is marked build-only").toBe(true);
  });
});
