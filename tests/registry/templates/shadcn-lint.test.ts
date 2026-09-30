import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { templateDir } from "../support/template-tree";

type RuleSetting = string | number | readonly [string | number, ...unknown[]];

interface OxlintConfig {
  jsPlugins?: Array<{ name?: string; specifier?: string }>;
  rules?: Record<string, RuleSetting>;
}

interface PackageManifest {
  devDependencies?: Record<string, string>;
}

const codeQuality = templateDir("code-quality");

describe("shadcn lint setup", () => {
  test("registers the plugin without choosing design-system policy", () => {
    // SAFETY: repo-owned Oxlint config; malformed plugin/rule shapes fail the assertions below.
    const config = JSON.parse(
      readFileSync(join(codeQuality, ".oxlintrc.json"), "utf8"),
    ) as OxlintConfig;

    expect(config.jsPlugins).toContainEqual({ name: "shadcn", specifier: "@shadcn/lint" });
    expect(Object.keys(config.rules ?? {}).filter((rule) => rule.startsWith("shadcn/"))).toEqual(
      [],
    );
  });

  test("installs shadcn lint with an Oxlint version that supports JS plugins", () => {
    // SAFETY: repo-owned code-quality dependency workspace.
    const manifest = JSON.parse(
      readFileSync(join(codeQuality, "packages/ts/code-quality/package.json"), "utf8"),
    ) as PackageManifest;
    expect(manifest.devDependencies?.["@shadcn/lint"]).toBe("0.1.0");
    expect(manifest.devDependencies?.oxlint).toBe("1.83.0");
  });
});
