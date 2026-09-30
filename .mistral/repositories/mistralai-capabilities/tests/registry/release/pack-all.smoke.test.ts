/**
 * Smoke test for pack-all.ts, run as a subprocess against a throwaway workspace so the real
 * packing pipeline runs, not a stub.
 *
 * It catches two faults. A broken topological publish order packs a dependency after its
 * dependent, so a consumer resolves a version not yet on the index. And a dependency cycle must
 * abort the build instead of passing silently. Capability roots live at `capabilities/<kind>/<id>`
 * and publish as `@<registry>/<kind>-<id>`.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  patchCorePackageJson,
  patchRegistryBunfig,
} from "../../../scripts/registry/app-registry-pins";
import { planFor, type PlanEntry } from "../../../scripts/release/publish-plan";
import { REGISTRY_ROOT } from "../support/template-tree";

const SCRIPT = join(REGISTRY_ROOT, "scripts", "release", "pack-all.ts");
const SCOPE = "@mistralai-capabilities";
const INTERNAL_DESCRIPTOR_README = `internal registry documentation
https://github.com/mistralai/mistralai-capabilities
https://npm-proxy.fury.io/mistralai/
https://npm.cloudsmith.io/mistral-ai/sdk-distribution/
`;
const FIXTURE_LICENSE = "Apache License\nVersion 2.0\n";

type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue | undefined };

let root: string;

function writeJson(rel: string, value: JsonValue): void {
  const path = join(root, rel);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
  if (rel === "packages/registry/package.json") {
    writeFileSync(join(root, "packages", "registry", "README.md"), INTERNAL_DESCRIPTOR_README);
  }
}

/** An npm manifest named `@<scope>/<suffix>` (a capability's `<kind>-<id>` or a shared name). */
function pkg(suffix: string, deps: string[] = []) {
  return {
    name: `${SCOPE}/${suffix}`,
    version: "0.0.0",
    private: true,
    dependencies: Object.fromEntries(deps.map((d) => [`${SCOPE}/${d}`, "workspace:*"])),
  };
}

/** The selection kinds the descriptor-building tests declare (build-registry requires kinds). */
const KINDS = [
  { id: "base", title: "Base", weight: 0, min: 1, max: 1 },
  { id: "feature", title: "Features", weight: 10, min: 0 },
  { id: "tooling", title: "Tooling", weight: 20, min: 0 },
];

function writeConfig(): void {
  writeJson("registry.config.json", {
    id: "mistralai-capabilities",
    sources: {
      ts: "https://example.test/ts/",
      py: "https://example.test/py/",
      git: "https://github.com/mistralai/mistralai-capabilities.git",
    },
    kinds: KINDS,
  });
}

function run(version: string) {
  const proc = Bun.spawnSync(["bun", SCRIPT, version], {
    cwd: root,
    // Never inherit ~/.npm: a developer's root-owned or corrupt cache must not decide whether this
    // repo test passes. The throwaway workspace cleanup removes this cache with the fixture.
    env: { ...process.env, npm_config_cache: join(root, ".npm-cache") },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: proc.exitCode,
    output: proc.stdout.toString() + proc.stderr.toString(),
  };
}

const DESIGN_SYSTEM_TEMPLATE = join("capabilities", "feature", "mistral-design-system", "template");
const CORE_LOGGING_FILE = join("packages", "py", "utils", "src", "utils", "logging.py");

/**
 * Write the public-capable pin carrier and every template file the registry projection rewrites.
 * Each carries the anchor its generator refuses to guess at: the `mistralai` index, wrapper
 * username, and Docker build credential block.
 */
function writeCore(isPublic = false): void {
  writeJson("capabilities/base/core/capability.json", {
    id: "core",
    version: "0.0.0",
    kind: "base",
    packages: ["ts"],
    metadata: {
      public: isPublic,
      registryPins: [
        "bunfig.toml",
        "gitignore",
        "package.json",
        "pyproject.toml",
        join("tools", "uv.sh"),
      ],
    },
  });
  writeJson("capabilities/base/core/package.json", pkg("base-core"));
  const capability = join(root, "capabilities", "base", "core");
  const template = join(capability, "template");
  mkdirSync(join(capability, "package", "ts"), { recursive: true });
  mkdirSync(join(template, "tools"), { recursive: true });
  mkdirSync(join(template, "deploy", "docker"), { recursive: true });
  mkdirSync(join(template, "packages", "py", "utils", "src", "utils"), { recursive: true });
  writeFileSync(join(capability, "package", "ts", "index.ts"), "export {};\n");
  writeFileSync(
    join(capability, "CHANGELOG.md"),
    `# Changelog\n\n## [Unreleased]\n\n- ${isPublic ? "audience-safe" : "internal"} fixture\n`,
  );
  writeFileSync(
    join(capability, "INSTALL.md"),
    isPublic
      ? "# Install\n\n- Package-index settings are prepared for anonymous installation.\n"
      : "# Install\n\n" +
          "- **Toolchain / services** — a **private package registry pull token** exported as\n" +
          "  `MISTRAL_REGISTRY_TOKEN`; both `bun install` and `uv sync` fail without it, because the private\n" +
          "  `@mistralai` npm scopes and the Mistral PyPI packages resolve only against that index.\n",
  );
  writeFileSync(join(capability, "tsconfig.json"), "{}\n");
  writeFileSync(
    join(template, "bunfig.toml"),
    '[install]\nregistry = "https://registry.npmjs.org"\n' +
      'minimumReleaseAgeExcludes = ["@mistral/workflow-ui", "@mistralai/ui"]\n',
  );
  writeFileSync(
    join(template, CORE_LOGGING_FILE),
    '"""Shared audience-neutral logging fixture."""\n',
  );
  writeJson("capabilities/base/core/template/package.json", {
    name: "fixture-app",
    private: true,
    workspaces: {
      "//packages":
        "Mentions the private @mistral/* packages, which the anonymous projection drops.",
      packages: ["apps/*", "packages/ts/*"],
      catalog: {
        react: "^19",
      },
    },
    scripts: {
      "dev:web": "nx run web:dev",
    },
    devDependencies: {
      typescript: "^6",
    },
    overrides: {
      "@mistral/common": "workspace:*",
      react: "19.0.0",
    },
    packageManager: "bun@1.4.0",
  });
  if (isPublic) {
    for (const relativePath of ["pyproject.toml", "gitignore", join("tools", "uv.sh")]) {
      writeFileSync(
        join(template, relativePath),
        readFileSync(join(REGISTRY_ROOT, "capabilities", "base", "core", "template", relativePath)),
      );
    }
  } else {
    writeFileSync(
      join(template, "pyproject.toml"),
      '[[tool.uv.index]]\nname = "mistralai"\nurl = "https://example.test/py/"\nexplicit = true\n',
    );
    writeFileSync(join(template, "gitignore"), ".env.gemfury\n");
    writeFileSync(
      join(template, "tools", "uv.sh"),
      '#!/usr/bin/env bash\nexport UV_DEFAULT_INDEX="https://pypi.org/simple"\n' +
        "# --- BEGIN private-index credentials (omitted in the public core projection) ---\n" +
        "export MISTRAL_REGISTRY_USER=mistralai\n" +
        'export UV_INDEX_MISTRALAI_PASSWORD="$MISTRAL_REGISTRY_TOKEN"\n' +
        "# --- END private-index credentials ---\n" +
        'exec uv "$@"\n',
    );
  }
}

/**
 * The second, private pin carrier: the capability that pins private npm packages and so ships the
 * app's `.npmrc`.
 */
function writeDesignSystem(): void {
  writeJson("capabilities/feature/mistral-design-system/capability.json", {
    id: "mistral-design-system",
    version: "0.0.0",
    kind: "feature",
    packages: ["ts"],
    metadata: { public: false, registryPins: [".npmrc.hbs", ".npmrc.example"] },
  });
  writeJson(
    "capabilities/feature/mistral-design-system/package.json",
    pkg("feature-mistral-design-system"),
  );
  mkdirSync(join(root, DESIGN_SYSTEM_TEMPLATE), { recursive: true });
  writeFileSync(join(root, DESIGN_SYSTEM_TEMPLATE, ".npmrc.hbs"), "");
  writeFileSync(join(root, DESIGN_SYSTEM_TEMPLATE, ".npmrc.example"), "");
}

/** The `<kind>-<id>` carrier's tarball packed for `id`. */
function carrierTarball(id: string, suffix = "base-core"): string {
  const dir = join(root, "dist", "npm", "pins", id);
  const tgz = readdirSync(dir).find(
    (file) => file.includes(`-${suffix}-`) && file.endsWith(".tgz"),
  );
  expect(tgz, `no ${suffix} tarball for ${id}`).toBeDefined();
  return join(dir, tgz!);
}

function coreTarball(id: string): string {
  return carrierTarball(id);
}

/** A file inside the core tarball packed for `id`. */
function coreFileIn(id: string, member: string): string {
  const out = Bun.spawnSync(["tar", "-xzOf", coreTarball(id), `package/${member}`]);
  expect(out.exitCode, `${member} missing from core tarball for ${id}`).toBe(0);
  return out.stdout.toString();
}

/** The `.npmrc` carrier inside the design-system tarball packed for `id`. */
function pinnedNpmrcIn(id: string): string {
  const tarball = carrierTarball(id, "feature-mistral-design-system");
  const out = Bun.spawnSync(["tar", "-xzOf", tarball, "package/template/.npmrc.hbs"]);
  expect(out.exitCode, `.npmrc.hbs missing from the design-system tarball for ${id}`).toBe(0);
  return out.stdout.toString();
}

/** Member names inside the core tarball packed for `id`. */
function coreMembersIn(id: string): string[] {
  const out = Bun.spawnSync(["tar", "-tzf", coreTarball(id)]);
  expect(out.exitCode).toBe(0);
  return out.stdout.toString().trim().split("\n");
}

/** A file inside the descriptor tarball packed for `id`. */
function descriptorFileIn(id: string, member: string): string {
  const dir = join(root, "dist", "npm", "descriptor", id);
  const tgz = readdirSync(dir).find((f) => f.endsWith(".tgz"));
  expect(tgz, `no descriptor tarball for ${id}`).toBeDefined();
  // SAFETY: the assertion above proves this fixture's descriptor tarball exists.
  const out = Bun.spawnSync(["tar", "-xzOf", join(dir, tgz!), `package/${member}`]);
  expect(out.exitCode, `${member} missing from descriptor tarball for ${id}`).toBe(0);
  return out.stdout.toString();
}

/** The descriptor registry.json inside the descriptor tarball packed for `id`. */
function descriptorIn(id: string): {
  sources: Record<string, string>;
  kinds: { id: string; min: number }[];
  capabilities: {
    id: string;
    version: string;
    compatibility?: Record<string, string[]>;
  }[];
} {
  // SAFETY: buildDescriptor just wrote this payload; its shape is the script's own output.
  return JSON.parse(descriptorFileIn(id, "registry.json"));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cap-pack-"));
  // No `workspaces` field: pack-all globs packages/ and capabilities/ itself, and leaving it
  // out keeps `npm pack` from trying to resolve a workspace it cannot install.
  writeJson("package.json", { name: "mistralai-capabilities", private: true });
  // prepare-publish.ts drops this into every other package root; the descriptor stage is built
  // file by file, so pack-all copies it in itself.
  writeFileSync(join(root, "LICENSE"), FIXTURE_LICENSE);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("pack-all publish order", () => {
  test("packs every dependency before its dependents", () => {
    // The descriptor package + the config buildDescriptor derives its `id`/`sources` from,
    // both required for a clean exit.
    writeJson("packages/registry/package.json", {
      name: `${SCOPE}/registry`,
      version: "0.0.0",
      private: true,
    });
    writeConfig();
    // A stale committed descriptor, as a release checkout carries it: pack-all must rebuild from
    // the stamped manifests and ignore this, not ship its 0.0.0 through to consumers.
    writeJson("registry.json", {
      id: "mistralai-capabilities",
      descriptorVersion: 3,
      sources: {
        ts: "https://example.test/ts/",
        py: "https://example.test/py/",
      },
      kinds: KINDS,
      capabilities: [{ id: "widget", version: "0.0.0", kind: "feature", packages: ["ts"] }],
    });
    writeCore();
    writeDesignSystem();
    const canonicalPinBytes = [
      join(DESIGN_SYSTEM_TEMPLATE, ".npmrc.hbs"),
      join(DESIGN_SYSTEM_TEMPLATE, ".npmrc.example"),
      join("capabilities", "base", "core", "template", "bunfig.toml"),
      join("capabilities", "base", "core", "template", "package.json"),
      join("capabilities", "base", "core", "template", "pyproject.toml"),
      join("capabilities", "base", "core", "template", "gitignore"),
      join("capabilities", "base", "core", "template", "tools", "uv.sh"),
    ].map((path) => ({
      path,
      content: readFileSync(join(root, path), "utf8"),
    }));

    // Chain widget -> consumer -> mid, with `consumer` also depending on core. `widget` lives in
    // capabilities/ (discovered LAST); its dependents live in packages/ (discovered FIRST).
    // Only a real topological sort can recover widget -> consumer -> mid from that discovery
    // order, and only an in-place per-index expansion keeps core ahead of `consumer`.
    // Written as prepare-publish.ts would leave it: stamped to the release version before pack.
    writeJson("capabilities/feature/widget/capability.json", {
      id: "widget",
      version: "9.9.9",
      kind: "feature",
      packages: ["ts"],
      metadata: { public: false },
    });
    writeJson("capabilities/feature/widget/package.json", pkg("feature-widget"));
    writeJson("packages/consumer/package.json", pkg("consumer", ["feature-widget", "base-core"]));
    writeJson("packages/mid/package.json", pkg("mid", ["consumer"]));

    const res = run("9.9.9");
    expect(res.exitCode, res.output).toBe(0);

    // SAFETY: pack-all just wrote this plan in this test; its shape is the script's own output.
    const plan = JSON.parse(
      readFileSync(join(root, "dist", "npm", "publish-plan.json"), "utf8"),
    ) as PlanEntry[];
    // Shared entries (no per-index `registry`) carry the topological order.
    const order = plan.filter((e) => e.registry === undefined).map((e) => e.name);
    const at = (suffix: string) => order.indexOf(`${SCOPE}/${suffix}`);

    expect(at("feature-widget")).toBeGreaterThanOrEqual(0);
    expect(at("feature-widget")).toBeLessThan(at("consumer"));
    expect(at("consumer")).toBeLessThan(at("mid"));
    const publishGroup = (name: string): number => {
      const group = plan.find((entry) => entry.name === name)?.publishGroup;
      if (group === undefined) throw new Error(`${name} has no publish group`);
      return group;
    };
    expect(publishGroup(`${SCOPE}/feature-widget`)).toBeLessThan(publishGroup(`${SCOPE}/consumer`));
    expect(publishGroup(`${SCOPE}/consumer`)).toBeLessThan(publishGroup(`${SCOPE}/mid`));

    // Both carriers ship the app's registry pins, so they are packed per index like the descriptor
    // and must NOT appear as a shared tarball -- one shared copy would ship every consumer the
    // same host, which is the whole defect this routing exists to prevent.
    expect(at("base-core")).toBe(-1);
    expect(at("feature-mistral-design-system")).toBe(-1);
    for (const [suffix, name] of [
      ["registry", "registry"],
      ["base-core", "core"],
      ["feature-mistral-design-system", "mistral-design-system"],
    ] as const) {
      const variants = plan
        .filter((e) => e.name === `${SCOPE}/${suffix}`)
        .map((e) => e.registry)
        .toSorted();
      expect(variants, `${name} variants`).toEqual(
        suffix === "registry" ? ["cloudsmith", "gemfury", "public"] : ["cloudsmith", "gemfury"],
      );
    }

    // Per-index expansion must not cost core its topological slot. Every publish step walks
    // the plan in order, so a dependent uploaded before the core version its stamped manifest
    // pins opens a window where a consumer resolves the dependent and 404s on core.
    const full = plan.map((e) => e.name);
    const lastCore = full.lastIndexOf(`${SCOPE}/base-core`);
    expect(lastCore).toBeGreaterThanOrEqual(0);
    expect(lastCore, "core must precede the dependent that pins it").toBeLessThan(
      full.indexOf(`${SCOPE}/consumer`),
    );

    // Each index's staged carrier tarballs carry that index's pins, while the checkout retains the
    // fixture's exact canonical bytes instead of being rewritten to any registry projection.
    expect(pinnedNpmrcIn("gemfury")).toContain("npm-proxy.fury.io");
    expect(pinnedNpmrcIn("cloudsmith")).toContain("npm.cloudsmith.io");
    expect(coreFileIn("gemfury", "template/pyproject.toml")).toContain("pypi.fury.io");
    expect(coreFileIn("cloudsmith", "template/pyproject.toml")).toContain("dl.cloudsmith.io");
    // core's bun scope table maps the capability scope to the same index, and no private scope.
    expect(coreFileIn("gemfury", "template/bunfig.toml")).toContain(
      '"@mistralai-capabilities" = { url = "https://npm-proxy.fury.io/mistralai/"',
    );
    expect(coreFileIn("cloudsmith", "template/bunfig.toml")).toContain(
      '"@mistralai-capabilities" = { url = "https://npm.cloudsmith.io/mistral-ai/sdk-distribution/"',
    );
    expect(coreFileIn("cloudsmith", "template/bunfig.toml")).not.toContain('"@mistral" =');
    const coreMembers = coreMembersIn("gemfury");
    expect(coreMembers).toContain("package/capability.json");
    expect(coreMembers).toContain("package/package/ts/index.ts");
    expect(coreMembers).toContain("package/template/bunfig.toml");
    for (const { path, content } of canonicalPinBytes) {
      expect(readFileSync(join(root, path), "utf8"), path).toBe(content);
    }

    // The descriptor is rebuilt from the capability manifests at pack time, so it carries the
    // release version pack-all was invoked with -- not the 0.0.0 the committed manifests hold.
    const widget = descriptorIn("gemfury").capabilities.find((c) => c.id === "widget");
    expect(widget?.version, "descriptor must carry the stamped version").toBe("9.9.9");

    // Nothing is public in this fixture. The public catalog must not retain the base kind's
    // impossible `min: 1` requirement after filtering every private capability out.
    expect(descriptorIn("public").capabilities).toEqual([]);
    expect(descriptorIn("public").kinds).toEqual([]);
  }, 60_000);

  test("packs a capability root discovered at its concrete kind/id path", () => {
    writeJson("packages/registry/package.json", {
      name: `${SCOPE}/registry`,
      version: "0.0.0",
      private: true,
    });
    writeConfig();
    writeCore();

    // A root at its `<kind>/<id>` path. pack-all's descriptor/package-set check only agrees when
    // scanPackageManifests discovers it recursively and keys it by its identity `feature/scoped`
    // rather than the kind segment -- a one-level readdir would miss it and abort.
    writeJson("capabilities/feature/scoped/capability.json", {
      id: "scoped",
      version: "9.9.9",
      kind: "feature",
      packages: ["ts"],
      metadata: { public: false },
    });
    writeJson("capabilities/feature/scoped/package.json", pkg("feature-scoped"));

    const res = run("9.9.9");
    expect(res.exitCode, res.output).toBe(0);

    const scoped = descriptorIn("gemfury").capabilities.find((c) => c.id === "scoped");
    expect(scoped?.version, "the capability must be packed and stamped").toBe("9.9.9");
  }, 60_000);

  test("aborts on a dependency cycle rather than emitting a bogus order", () => {
    writeCore();
    writeJson("capabilities/feature/x/capability.json", {
      id: "x",
      version: "0.0.0",
      kind: "feature",
      packages: ["ts"],
      metadata: { public: false },
    });
    writeJson("capabilities/feature/x/package.json", pkg("feature-x", ["feature-y"]));
    writeJson("capabilities/feature/y/capability.json", {
      id: "y",
      version: "0.0.0",
      kind: "feature",
      packages: ["ts"],
      metadata: { public: false },
    });
    writeJson("capabilities/feature/y/package.json", pkg("feature-y", ["feature-x"]));

    const res = run("9.9.9");
    expect(res.exitCode).not.toBe(0);
    expect(res.output.toLowerCase()).toContain("cycle");
  });

  test("aborts when a ts-packaged capability has no npm package", () => {
    writeCore();
    writeJson("capabilities/feature/orphan/capability.json", {
      id: "orphan",
      version: "9.9.9",
      kind: "feature",
      packages: ["ts"],
      metadata: { public: false },
    });

    const res = run("9.9.9");
    expect(res.exitCode).not.toBe(0);
    expect(res.output).toContain("must carry a valid package.json");

    writeFileSync(join(root, "capabilities/feature/orphan/package.json"), "{not json\n");
    const malformed = run("9.9.9");
    expect(malformed.exitCode).not.toBe(0);
    expect(malformed.output).toContain("must carry a valid package.json");
  });

  test("a template-only capability is vendored via git, not required as an npm package", () => {
    // A capability that declares `packages: []` ships no npm package and no package.json — it is
    // delivered through the descriptor's git source. It must NOT fail the descriptor/package
    // correspondence check, must not appear in the publish plan, and must not be packed, while its
    // ts-packaged siblings still are. It still appears in the rebuilt descriptor.
    writeJson("packages/registry/package.json", {
      name: `${SCOPE}/registry`,
      version: "0.0.0",
      private: true,
    });
    writeJson("registry.config.json", {
      id: "mistralai-capabilities",
      sources: {
        ts: "https://example.test/ts/",
        py: "https://example.test/py/",
        git: "https://example.test/repo.git",
      },
      kinds: KINDS,
    });
    writeCore();
    writeJson("capabilities/tooling/testing/capability.json", {
      id: "testing",
      version: "9.9.9",
      kind: "tooling",
      packages: [],
      metadata: { public: false },
    });

    const res = run("9.9.9");
    expect(res.exitCode, res.output).toBe(0);

    // SAFETY: pack-all just wrote this plan in this test; its shape is the script's own output.
    const plan = JSON.parse(
      readFileSync(join(root, "dist", "npm", "publish-plan.json"), "utf8"),
    ) as PlanEntry[];
    expect(plan.some((e) => e.name === `${SCOPE}/tooling-testing`)).toBe(false);
    expect(plan.some((e) => e.name === `${SCOPE}/base-core`)).toBe(true);

    // The template-only capability is still projected into the rebuilt descriptor.
    const testing = descriptorIn("gemfury").capabilities.find((c) => c.id === "testing");
    expect(testing?.version, "template-only capability must appear in the descriptor").toBe(
      "9.9.9",
    );
  }, 60_000);

  test("constructs a public plan and descriptor from strict public metadata", () => {
    writeJson("packages/registry/package.json", {
      name: `${SCOPE}/registry`,
      version: "0.0.0",
      private: true,
    });
    writeConfig();
    writeCore(true);
    writeJson("capabilities/feature/public-widget/capability.json", {
      id: "public-widget",
      version: "9.9.9",
      kind: "feature",
      packages: ["ts"],
      compatibility: {
        feature: ["feature/public-widget"],
        tooling: ["tooling/private-tool"],
      },
      metadata: { public: true },
    });
    writeJson("capabilities/feature/public-widget/package.json", pkg("feature-public-widget"));
    writeJson("capabilities/feature/private-widget/capability.json", {
      id: "private-widget",
      version: "9.9.9",
      kind: "feature",
      packages: ["ts"],
      metadata: { public: false },
    });
    writeJson("capabilities/feature/private-widget/package.json", pkg("feature-private-widget"));
    writeJson("capabilities/tooling/private-tool/capability.json", {
      id: "private-tool",
      version: "9.9.9",
      kind: "tooling",
      packages: [],
      metadata: { public: false },
    });

    const res = run("9.9.9");
    expect(res.exitCode, res.output).toBe(0);
    // SAFETY: pack-all just wrote this plan in this test; its shape is the script's own output.
    const plan = JSON.parse(
      readFileSync(join(root, "dist", "npm", "publish-plan.json"), "utf8"),
    ) as PlanEntry[];
    expect(planFor("public", plan).map((entry) => entry.name)).toEqual([
      `${SCOPE}/base-core`,
      `${SCOPE}/feature-public-widget`,
      `${SCOPE}/registry`,
    ]);
    expect(
      plan.find((entry) => entry.name === `${SCOPE}/base-core` && entry.registry === "public")
        ?.requiredVariants,
    ).toEqual(["gemfury", "cloudsmith", "public"]);
    expect(
      plan.find(
        (entry) => entry.name === `${SCOPE}/feature-public-widget` && entry.registry === undefined,
      )?.requiredVariants,
    ).toEqual(["public"]);
    expect(plan.some((entry) => entry.name === `${SCOPE}/feature-private-widget`)).toBe(true);
    expect(
      plan.some(
        (entry) => entry.name === `${SCOPE}/feature-private-widget` && entry.registry === "public",
      ),
    ).toBe(false);
    const publicDescriptor = descriptorIn("public");
    expect(publicDescriptor.sources.ts).toBe("https://registry.npmjs.org/");
    expect(publicDescriptor.sources.py).toBe("https://pypi.org/simple/");
    expect(publicDescriptor.sources.git).toBeUndefined();
    expect(publicDescriptor.capabilities.map(({ id }) => id)).toEqual(["core", "public-widget"]);
    expect(
      publicDescriptor.capabilities.find(({ id }) => id === "public-widget")?.compatibility,
    ).toEqual({
      feature: ["mistralai-capabilities/feature/public-widget"],
    });
    expect(publicDescriptor.kinds.map(({ id }) => id)).toEqual(["base", "feature"]);

    for (const id of ["public", "gemfury", "cloudsmith"]) {
      const rootPackage = coreFileIn(id, "template/package.json");
      expect(rootPackage, id).not.toContain("@mistralai/ui");
    }
    expect(coreMembersIn("public")).toContain("package/CHANGELOG.md");
    expect(coreMembersIn("public")).toContain("package/INSTALL.md");
    expect(coreMembersIn("gemfury")).toContain("package/CHANGELOG.md");
    expect(coreMembersIn("gemfury")).toContain("package/INSTALL.md");
    expect(coreFileIn("public", "INSTALL.md")).toBe(
      readFileSync(join(root, "capabilities", "base", "core", "INSTALL.md"), "utf8"),
    );
    expect(coreFileIn("public", "CHANGELOG.md")).toBe(
      readFileSync(join(root, "capabilities", "base", "core", "CHANGELOG.md"), "utf8"),
    );
    // SAFETY: pack-all emitted this package manifest from a validated JSON fixture.
    const publicPackageManifest = JSON.parse(coreFileIn("public", "package.json")) as {
      files?: string[];
    };
    expect(publicPackageManifest.files).toEqual([
      ".templateignore",
      "capability.json",
      "CHANGELOG.md",
      "INSTALL.md",
      "package",
      "template",
      "tsconfig.json",
    ]);

    const capabilityRoot = join(root, "capabilities", "base", "core");
    const canonicalPackageJson = readFileSync(
      join(capabilityRoot, "template", "package.json"),
      "utf8",
    );
    const canonicalBunfig = readFileSync(join(capabilityRoot, "template", "bunfig.toml"), "utf8");

    // Authenticated indexes get core's package.json back byte for byte; the app-template pin
    // projector, not a separate overlay file, is what produces every variant now.
    for (const id of ["gemfury", "cloudsmith"] as const) {
      expect(coreFileIn(id, "template/package.json"), id).toBe(canonicalPackageJson);
      expect(coreFileIn(id, "template/bunfig.toml"), id).toBe(
        patchRegistryBunfig(canonicalBunfig, id),
      );
    }
    expect(coreFileIn("public", "template/package.json")).toBe(
      patchCorePackageJson(canonicalPackageJson, "public"),
    );
    expect(coreFileIn("public", "template/bunfig.toml")).toBe(
      patchRegistryBunfig(canonicalBunfig, "public"),
    );

    // The anonymous projection drops only the private `@mistral/*` override and the comment
    // mentioning it, preserving every workspace glob, the catalog, `dev:web`, and `packageManager`.
    // SAFETY: app-registry-pins emitted this projection from a validated JSON fixture.
    const projectedRootPackage = JSON.parse(coreFileIn("public", "template/package.json")) as {
      workspaces?: { catalog?: Record<string, string>; packages?: string[] };
      overrides?: Record<string, string>;
      scripts?: Record<string, string>;
      packageManager?: string;
    };
    expect(projectedRootPackage.overrides).toEqual({ react: "19.0.0" });
    expect(projectedRootPackage.workspaces?.catalog).toEqual({ react: "^19" });
    expect(projectedRootPackage.workspaces?.packages).toEqual(["apps/*", "packages/ts/*"]);
    expect(projectedRootPackage.scripts).toEqual({ "dev:web": "nx run web:dev" });
    expect(projectedRootPackage.packageManager).toBe("bun@1.4.0");
    const serializedProjection = JSON.stringify(projectedRootPackage);
    expect(serializedProjection).not.toContain("@mistral/common");
    expect(serializedProjection).not.toContain("//packages");

    for (const id of ["gemfury", "cloudsmith"]) {
      const internalBunfig = coreFileIn(id, "template/bunfig.toml");
      expect(internalBunfig, `${id}: capability scope`).toContain("@mistralai-capabilities");
      expect(internalBunfig, `${id}: keeps the reviewed private names`).toContain(
        '["@mistral/workflow-ui", "@mistralai/ui"]',
      );
    }
    expect(coreFileIn("public", "template/bunfig.toml")).toContain(
      "minimumReleaseAgeExcludes = []",
    );

    const canonicalLogging = readFileSync(
      join(capabilityRoot, "template", CORE_LOGGING_FILE),
      "utf8",
    );
    for (const id of ["public", "gemfury", "cloudsmith"]) {
      expect(coreFileIn(id, join("template", CORE_LOGGING_FILE)), `${id}: canonical logging`).toBe(
        canonicalLogging,
      );
      expect(
        coreMembersIn(id).some((member) => member.includes("/variants/")),
        `${id} must not pack a variants overlay directory`,
      ).toBe(false);
    }

    const publicCoreText = coreMembersIn("public")
      .filter((member) => !member.endsWith("/"))
      .map((member) => {
        const out = Bun.spawnSync(["tar", "-xzOf", coreTarball("public"), member]);
        expect(out.exitCode, `${member} unreadable in public core tarball`).toBe(0);
        return out.stdout.toString();
      })
      .join("\n");
    expect(publicCoreText).not.toMatch(
      /MISTRAL_REGISTRY_TOKEN|NODE_AUTH_TOKEN|UV_INDEX_MISTRALAI|GEMFURY_PULL_TOKEN|npm-proxy\.fury\.io|pypi\.fury\.io|npm\.cloudsmith\.io|dl\.cloudsmith\.io/i,
    );
    expect(publicCoreText).not.toMatch(
      /capabilities\/feature\/search|@mistral\/common|mistralai-agents-sdk-alpha|mistralai\.workflows|mistral\.obs\.internal/i,
    );

    const publicReadme = descriptorFileIn("public", "README.md");
    expect(publicReadme).not.toContain("github.com/mistralai");
    expect(publicReadme).not.toContain("fury.io");
    expect(publicReadme).not.toContain("cloudsmith.io");
    // `files` lists only registry.json, but npm packs a package-root LICENSE regardless — the same
    // rule that puts the audience-specific README in every variant.
    for (const id of ["public", "gemfury", "cloudsmith"]) {
      expect(descriptorFileIn(id, "LICENSE"), id).toBe(FIXTURE_LICENSE);
    }
    expect(descriptorFileIn("gemfury", "README.md")).toBe(INTERNAL_DESCRIPTOR_README);
    expect(readFileSync(join(root, "packages", "registry", "README.md"), "utf8")).toBe(
      INTERNAL_DESCRIPTOR_README,
    );
  }, 60_000);

  test("fails closed on an invalid public dependency graph", () => {
    writeCore();
    writeJson("capabilities/feature/public-widget/capability.json", {
      id: "public-widget",
      version: "9.9.9",
      kind: "feature",
      dependencies: ["private-widget"],
      packages: ["ts"],
      metadata: { public: true },
    });
    writeJson("capabilities/feature/public-widget/package.json", pkg("feature-public-widget"));
    writeJson("capabilities/feature/private-widget/capability.json", {
      id: "private-widget",
      version: "9.9.9",
      kind: "feature",
      packages: ["ts"],
      metadata: { public: false },
    });
    writeJson("capabilities/feature/private-widget/package.json", pkg("feature-private-widget"));

    const res = run("9.9.9");
    expect(res.exitCode).not.toBe(0);
    expect(res.output).toContain("public capability eligibility failed");
    expect(res.output).toContain("private-widget");
  });

  test("rejects a shared package without a package name", () => {
    writeCore();
    writeJson("packages/nameless/package.json", { version: "0.0.0" });

    const res = run("9.9.9");
    expect(res.exitCode).not.toBe(0);
    expect(res.output).toContain("package name is required");
  });
});
