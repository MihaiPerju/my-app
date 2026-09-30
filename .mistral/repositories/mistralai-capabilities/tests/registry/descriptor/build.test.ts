/**
 * Deploy declarations: `metadata.build` must name a Dockerfile and stage the template ships, and
 * `metadata.platform` may only mark a worker module for the workflows platform.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { readManifests } from "../../../scripts/shared/manifests";
import { REGISTRY_ROOT, templateDir } from "../support/template-tree";

const manifests = readManifests(REGISTRY_ROOT);

const buildOf = (path: string) =>
  manifests.find((manifest) => manifest.path === path)?.metadata?.build;

const declared = manifests.flatMap((manifest) => {
  const build = manifest.metadata?.build;
  return build ? [[manifest.path, build, manifest.metadata?.platform] as const] : [];
});

const stagesOf = (dockerfile: string): string[] =>
  [...readFileSync(dockerfile, "utf8").matchAll(/^FROM\s+\S+\s+AS\s+(\S+)/gim)].map(
    (match) => match[1] ?? "",
  );

describe("capability build", () => {
  test.each([
    ["backend/fastapi", "deploy/docker/Dockerfile.api", "api"],
    ["frontend/tanstack-start", "deploy/docker/Dockerfile.web", "runtime"],
  ])("%s deploys %s at stage %s", (path, dockerfile, target) => {
    expect(buildOf(path)).toEqual({ context: ".", dockerfile, target });
  });

  test("backend/workflows deploys the last stage, which is the worker runtime", () => {
    expect(buildOf("backend/workflows")).toEqual({
      context: ".",
      dockerfile: "deploy/docker/Dockerfile.worker",
    });
    const dockerfile = readFileSync(
      join(templateDir("backend/workflows"), "deploy/docker/Dockerfile.worker"),
      "utf8",
    );
    expect(
      dockerfile
        .trimEnd()
        .split("\n")
        .findLast((line) => /^FROM\s/i.test(line)),
    ).toMatch(/^FROM\s+workflows\s+AS\s+\S+/i);
  });

  test.each(declared)(
    "%s declares a Dockerfile and stage its template ships",
    (path, build, platform) => {
      expect(build.context, `${path}: context is relative to the app root`).toBe(".");
      const dockerfile = join(templateDir(path), build.dockerfile);
      expect(existsSync(dockerfile), `${path}: ${build.dockerfile} is not in the template`).toBe(
        true,
      );
      if (build.target === undefined) {
        expect(platform, `${path}: only a workflows worker may leave out target`).toBe("workflows");
        return;
      }
      expect(stagesOf(dockerfile), `${path}: no stage named ${build.target}`).toContain(
        build.target,
      );
    },
  );
});

describe("capability platform", () => {
  const platformOf = (path: string) =>
    manifests.find((manifest) => manifest.path === path)?.metadata?.platform;

  test.each([
    ["backend/workflows", "workflows"],
    ["backend/fastapi", undefined],
    ["frontend/tanstack-start", undefined],
  ] as const)("%s declares platform %p", (path, platform) => {
    expect(platformOf(path)).toBe(platform);
  });

  test.each(manifests.filter((manifest) => manifest.metadata?.platform !== undefined))(
    "$path marks a worker module for the workflows platform",
    (manifest) => {
      expect(manifest.metadata?.platform).toBe("workflows");
      expect(manifest.module?.serve).toBe("worker");
    },
  );
});
