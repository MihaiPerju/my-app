/**
 * Focused suite for `scripts/registry/app-registry-pins.ts`'s core `package.json` projector
 * (`patchCorePackageJson`) and the `minimumReleaseAgeExcludes` projection it shares with
 * `patchRegistryBunfig`. Split out of `package-registries.test.ts`, which otherwise mixes these
 * narrow per-file projector assertions in with broad cross-capability registry-state audits and
 * the release descriptor / publish-plan suite -- a distinct concern with its own large fixture set.
 */
import { describe, expect, test } from "bun:test";

import {
  patchCorePackageJson,
  patchRegistryBunfig,
  readRegistryPinCarriers,
  type RegistryPinCarrier,
} from "../../../scripts/registry/app-registry-pins";
import {
  INTERNAL_PACKAGE_REGISTRY_IDS,
  PACKAGE_REGISTRY_IDS,
} from "../../../scripts/release/package-registries";
import { REGISTRY_ROOT } from "../support/template-tree";

/** The declared carrier at `<kind>/<id>`, failing the test run when it no longer carries pins. */
function pinCarrier(carriers: readonly RegistryPinCarrier[], path: string): RegistryPinCarrier {
  const carrier = carriers.find(({ manifest }) => manifest.path === path);
  if (carrier === undefined) throw new Error(`${path} does not declare metadata.registryPins`);
  return carrier;
}

const coreCarrier = pinCarrier(readRegistryPinCarriers(REGISTRY_ROOT), "base/core");
const canonicalCorePins = {
  packageJson: coreCarrier.canonical.get("package.json")!,
  bunfig: coreCarrier.canonical.get("bunfig.toml")!,
};

/** The committed private-name exclusion list, as it appears in `bunfig.toml`'s single-line array.
 * A single constant here (rather than the same literal repeated in every fixture below) is the
 * test-file counterpart of the source's single `REVIEWED_PRIVATE_MIN_RELEASE_AGE_EXCLUDES`: one
 * place names today's reviewed private packages, so a future addition or removal only has to be
 * edited once. */
const CANONICAL_MIN_RELEASE_AGE_EXCLUDES_LINE =
  'minimumReleaseAgeExcludes = ["@mistral/workflow-ui", "@mistralai/ui"]';

/** A JSON document's own top-level keys, in source order. */
function topLevelKeys(source: string): string[] {
  // SAFETY: callers pass core's committed package.json or this projector's own output from it;
  // non-object JSON would throw from Object.keys and fail the test rather than a false pass.
  return Object.keys(JSON.parse(source) as object);
}

/** A JSON document's `workspaces` object's own keys, in source order. */
function workspaceKeys(source: string): string[] {
  // SAFETY: callers pass core's committed package.json or this projector's own output from it,
  // both of which carry a `workspaces` object; a missing one throws from Object.keys instead of
  // silently returning `[]`.
  return Object.keys((JSON.parse(source) as { workspaces: object }).workspaces);
}

describe("app-registry-pins: core's package.json projector", () => {
  // Authenticated indexes never reserialize core's app-root package.json: `patchCorePackageJson`
  // must hand back the exact committed bytes, for every internal index.
  test("authenticated indexes get core's package.json back byte for byte", () => {
    for (const id of INTERNAL_PACKAGE_REGISTRY_IDS) {
      expect(patchCorePackageJson(canonicalCorePins.packageJson, id)).toBe(
        canonicalCorePins.packageJson,
      );
    }
  });

  test("the anonymous package.json projection strips only private-scope overrides, preserving everything else", () => {
    // SAFETY: patchCorePackageJson serializes this projection itself, from a validated input below.
    const projected = JSON.parse(patchCorePackageJson(canonicalCorePins.packageJson, "public")) as {
      overrides?: Record<string, string>;
      workspaces?: { catalog?: Record<string, string>; packages?: string[] };
      scripts?: Record<string, string>;
      packageManager?: string;
      name?: string;
    };
    // SAFETY: repo-owned package.json; a shape mismatch fails the assertions below on `undefined`.
    const canonical = JSON.parse(canonicalCorePins.packageJson) as {
      overrides?: Record<string, string>;
      workspaces?: { catalog?: Record<string, string>; packages?: string[] };
      scripts?: Record<string, string>;
      packageManager?: string;
      name?: string;
    };

    for (const name of Object.keys(canonical.overrides ?? {})) {
      if (/^@mistral(ai)?\//.test(name)) {
        expect(projected.overrides, name).not.toHaveProperty(name);
      } else {
        expect(projected.overrides?.[name], name).toBe(canonical.overrides?.[name]);
      }
    }
    expect(projected.workspaces?.catalog).toEqual(canonical.workspaces?.catalog);
    expect(projected.workspaces?.packages).toEqual(canonical.workspaces?.packages);
    expect(projected.scripts).toEqual(canonical.scripts);
    expect(projected.scripts?.["dev:web"]).toBe(canonical.scripts?.["dev:web"]);
    expect(projected.packageManager).toBe(canonical.packageManager);
    expect(projected.name).toBe(canonical.name);
  });

  // Minimal-diff regression test: the projector used to reserialize the whole manifest through its
  // zod schema, whose `.passthrough()` reorders keys to schema-declared-then-extras instead of the
  // file's own order (for example, floating `type` in front of `workspaces`, and every `//`
  // comment to the very end). Comparing line by line proves the anonymous output differs from the
  // canonical bytes ONLY by the specific removed entries, in place, not a full reordering.
  test("the anonymous package.json projection is a minimal diff: key order and formatting otherwise match canonical", () => {
    const projected = patchCorePackageJson(canonicalCorePins.packageJson, "public");
    const canonicalLines = canonicalCorePins.packageJson.split("\n");
    const projectedLines = projected.split("\n");

    const removedLines = new Set(canonicalLines.filter((line) => !projectedLines.includes(line)));
    for (const line of removedLines) {
      // Every removed line either names a private scope directly, or is the opening/closing/typed
      // brace of a block this projector may edit -- never an unrelated line silently dropped by a
      // reorder or reformat.
      expect(
        /@mistral(ai)?\//.test(line) ||
          /^\s*[{}[\],]?\s*$/.test(line) ||
          /"overrides":\s*\{/.test(line),
        `unexpectedly removed/moved line, not a private-scope entry: ${JSON.stringify(line)}`,
      ).toBe(true);
    }

    // Every kept top-level key is at the same index in both files' own top-level key lists: no
    // schema-order reshuffling of the keys this projector leaves alone (zod's `.passthrough()`
    // would otherwise float `type` in front of `workspaces` and every `//` comment to the end).
    const canonicalKeys = topLevelKeys(canonicalCorePins.packageJson);
    const projectedKeys = topLevelKeys(projected);
    expect(projectedKeys).toEqual(canonicalKeys.filter((key) => projectedKeys.includes(key)));
    // The nested `workspaces.//packages` comment (mentioning `@mistral/*`) is dropped, not merely
    // reordered to the end of `workspaces` -- the same schema-order hazard, one level down.
    const canonicalWorkspaceKeys = workspaceKeys(canonicalCorePins.packageJson);
    const projectedWorkspaceKeys = workspaceKeys(projected);
    expect(projectedWorkspaceKeys).toEqual(
      canonicalWorkspaceKeys.filter((key) => projectedWorkspaceKeys.includes(key)),
    );
    expect(canonicalWorkspaceKeys).not.toEqual(projectedWorkspaceKeys);
    expect(projected.endsWith("\n")).toBe(true);
  });

  test("the anonymous package.json projection drops only comments mentioning a private scope", () => {
    const withNeutralComment = canonicalCorePins.packageJson.replace(
      '"overrides": {',
      '"//overrides": "Neutral commentary naming no private scope.",\n  "overrides": {',
    );
    const projected = patchCorePackageJson(withNeutralComment, "public");
    expect(projected).toContain("Neutral commentary naming no private scope.");
    expect(projected).not.toContain("//packages");
  });

  test("the public Mistral npm exemption survives every package.json surface", () => {
    const source = JSON.stringify({
      name: "canonical-app",
      "//public": "The @mistralai/mistralai SDK is public.",
      workspaces: {
        "//public": "Use @mistralai/mistralai@2 in this workspace.",
        packages: ["apps/*"],
        catalog: { "@mistralai/mistralai": "^2" },
      },
      dependencies: { "@mistralai/mistralai": "catalog:" },
      overrides: { "@mistralai/mistralai": "^2", "@mistral/common": "workspace:*" },
      resolutions: { "@mistralai/mistralai": "^2", "@mistralai/ui": "workspace:*" },
      scripts: { sdk: "echo @mistralai/mistralai@2" },
    });
    const projected = patchCorePackageJson(source, "public");
    // SAFETY: patchCorePackageJson validates this fixture and serializes the parsed result.
    const manifest = JSON.parse(projected) as {
      overrides: Record<string, string>;
      resolutions: Record<string, string>;
      dependencies: Record<string, string>;
      workspaces: { catalog: Record<string, string> };
    };
    expect(manifest.overrides).toEqual({ "@mistralai/mistralai": "^2" });
    expect(manifest.resolutions).toEqual({ "@mistralai/mistralai": "^2" });
    expect(manifest.dependencies["@mistralai/mistralai"]).toBe("catalog:");
    expect(manifest.workspaces.catalog["@mistralai/mistralai"]).toBe("^2");
    expect(projected).toContain("The @mistralai/mistralai SDK is public.");
    expect(projected).toContain("Use @mistralai/mistralai@2 in this workspace.");
    expect(projected).toContain("echo @mistralai/mistralai@2");
  });

  test("the exemption is exact: nearby names and mixed comments remain blocked", () => {
    for (const name of ["@mistralai/mistralai-private", "@mistralai/mistralai/other"]) {
      expect(() =>
        patchCorePackageJson(
          JSON.stringify({ name: "app", scripts: { test: `echo ${name}` } }),
          "public",
        ),
      ).toThrow("still names an unreviewed Mistral-scoped npm package");
      expect(() =>
        patchCorePackageJson(
          JSON.stringify({ name: "app", dependencies: { [name]: "^2" } }),
          "public",
        ),
      ).toThrow("names an unreviewed Mistral-scoped npm package");
    }
    const projected = patchCorePackageJson(
      JSON.stringify({
        name: "app",
        "//mixed": "Public @mistralai/mistralai but private @mistralai/ui",
        "//public": "Public @mistralai/mistralai",
      }),
      "public",
    );
    expect(projected).not.toContain("//mixed");
    expect(projected).toContain("//public");
  });

  test("the anonymous package.json projection fails closed on a private scope in a real dependency", () => {
    const withPrivateDependency = canonicalCorePins.packageJson.replace(
      '"devDependencies": {',
      '"devDependencies": {\n    "@mistral/private-tool": "1.0.0",',
    );
    expect(() => patchCorePackageJson(withPrivateDependency, "public")).toThrow(
      "devDependencies names an unreviewed Mistral-scoped npm package with no anonymous projection: @mistral/private-tool",
    );
  });

  test("the anonymous package.json projection fails closed on a private scope in the workspace catalog", () => {
    const withPrivateCatalogEntry = canonicalCorePins.packageJson.replace(
      '"catalog": {',
      '"catalog": {\n      "@mistralai/private-catalog-entry": "1.0.0",',
    );
    expect(() => patchCorePackageJson(withPrivateCatalogEntry, "public")).toThrow(
      "workspaces.catalog names an unreviewed Mistral-scoped npm package with no anonymous projection: @mistralai/private-catalog-entry",
    );
  });

  test("the package.json projection fails closed on malformed JSON, for every index", () => {
    for (const id of PACKAGE_REGISTRY_IDS) {
      expect(() => patchCorePackageJson("{not json", id)).toThrow("is not valid JSON");
    }
  });

  test("the package.json projection fails closed on an unrecognized shape, for every index", () => {
    for (const id of PACKAGE_REGISTRY_IDS) {
      expect(() => patchCorePackageJson('{"name": "x", "unexpectedField": 1}', id)).toThrow(
        "has an unrecognized field `unexpectedField`",
      );
      expect(() => patchCorePackageJson("[]", id)).toThrow("has an unexpected shape");
    }
  });

  test("the anonymous package.json projection fails closed on a residual private-scope substring", () => {
    // A private scope hiding in a field this projector does not treat as a dependency map (here
    // `packageManager`) must still trip the final serialized-output guard, not ride along silently.
    const withResidualScope = canonicalCorePins.packageJson.replace(
      /"packageManager": "[^"]*"/,
      '"packageManager": "@mistral/toolchain@1.0.0"',
    );
    expect(() => patchCorePackageJson(withResidualScope, "public")).toThrow(
      "anonymous projection of core's package.json still names an unreviewed Mistral-scoped npm package",
    );
  });
});

describe("app-registry-pins: bunfig.toml minimumReleaseAgeExcludes", () => {
  // Authenticated indexes keep the reviewed private names in `minimumReleaseAgeExcludes`; the
  // anonymous index drops them and gains no other private-scope name.
  test("authenticated indexes keep bunfig.toml's minimumReleaseAgeExcludes unchanged", () => {
    for (const id of INTERNAL_PACKAGE_REGISTRY_IDS) {
      const projected = patchRegistryBunfig(canonicalCorePins.bunfig, id);
      expect(projected).toContain(CANONICAL_MIN_RELEASE_AGE_EXCLUDES_LINE);
    }
  });

  // This runs the real committed bunfig.toml through the anonymous projection, so a private name
  // added there without a matching entry in the source's `REVIEWED_PRIVATE_MIN_RELEASE_AGE_EXCLUDES`
  // fails this test (via the projector's own fail-closed throw below), not just a synthetic fixture.
  test("the anonymous bunfig.toml projection empties minimumReleaseAgeExcludes of today's private names", () => {
    const projected = patchRegistryBunfig(canonicalCorePins.bunfig, "public");
    expect(projected).toContain("minimumReleaseAgeExcludes = []");
    expect(projected).not.toContain("@mistral/workflow-ui");
    expect(projected).not.toContain("@mistralai/ui");
    // The generated anonymous scope table is still appended, unaffected by the exclude rewrite.
    expect(projected).toContain('"@mistralai-capabilities" = "https://registry.npmjs.org/"');
    expect(() => Bun.TOML.parse(projected)).not.toThrow();
  });

  test("the public bunfig projection keeps the exempt SDK but drops reviewed private names", () => {
    const withPublicSdk = canonicalCorePins.bunfig.replace(
      '"@mistralai/ui"]',
      '"@mistralai/ui", "@mistralai/mistralai"]',
    );
    expect(patchRegistryBunfig(withPublicSdk, "public")).toContain(
      'minimumReleaseAgeExcludes = ["@mistralai/mistralai"]',
    );
    expect(patchRegistryBunfig(withPublicSdk, "cloudsmith")).toContain(
      'minimumReleaseAgeExcludes = ["@mistral/workflow-ui", "@mistralai/ui", "@mistralai/mistralai"]',
    );
  });

  test("the bunfig.toml minimumReleaseAgeExcludes projection fails closed on an unreviewed private name", () => {
    const withUnreviewedPrivateName = canonicalCorePins.bunfig.replace(
      CANONICAL_MIN_RELEASE_AGE_EXCLUDES_LINE,
      'minimumReleaseAgeExcludes = ["@mistral/workflow-ui", "@mistralai/ui", "@mistral/unreviewed"]',
    );
    expect(() => patchRegistryBunfig(withUnreviewedPrivateName, "public")).toThrow(
      "names an unreviewed Mistral-scoped package for the anonymous index: @mistral/unreviewed",
    );
  });

  test("the bunfig.toml minimumReleaseAgeExcludes projection fails closed on a malformed or duplicate array", () => {
    const malformed = canonicalCorePins.bunfig.replace(
      CANONICAL_MIN_RELEASE_AGE_EXCLUDES_LINE,
      "minimumReleaseAgeExcludes = [1, 2]",
    );
    expect(() => patchRegistryBunfig(malformed, "public")).toThrow(
      "must be a flat array of strings",
    );

    const duplicate = canonicalCorePins.bunfig.replace(
      CANONICAL_MIN_RELEASE_AGE_EXCLUDES_LINE,
      'minimumReleaseAgeExcludes = ["@mistral/workflow-ui", "@mistral/workflow-ui"]',
    );
    expect(() => patchRegistryBunfig(duplicate, "public")).toThrow("has a duplicate entry");

    const multiline = canonicalCorePins.bunfig.replace(
      CANONICAL_MIN_RELEASE_AGE_EXCLUDES_LINE,
      'minimumReleaseAgeExcludes = [\n  "@mistral/workflow-ui",\n]',
    );
    expect(() => patchRegistryBunfig(multiline, "public")).toThrow(
      "could not find a single-line `minimumReleaseAgeExcludes` array",
    );
  });
});
