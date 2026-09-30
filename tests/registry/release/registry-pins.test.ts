import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { readRegistryPinCarriers, registryPins } from "../../../scripts/registry/app-registry-pins";
import { DEFAULT_PACKAGE_REGISTRY } from "../../../scripts/release/package-registries";

// A pin carrier may live at any valid capability root, and more than one may exist. Pins resolve
// each template from the metadata declaration, not a literal path, or a renamed carrier would
// silently ship unprojected registry state.
describe("registryPins resolves every declared registry pin carrier", () => {
  test("each carrier's pins land in its own template, for the files it ships", () => {
    const root = mkdtempSync(join(tmpdir(), "cap-registry-pins-"));
    try {
      const pythonRoot = join(root, "capabilities", "base", "python-carrier");
      const npmRoot = join(root, "capabilities", "feature", "npm-carrier");
      const pythonTemplate = join(pythonRoot, "template");
      const npmTemplate = join(npmRoot, "template");
      mkdirSync(join(pythonTemplate, "tools"), { recursive: true });
      mkdirSync(npmTemplate, { recursive: true });
      writeFileSync(
        join(pythonRoot, "capability.json"),
        JSON.stringify({
          id: "python-carrier",
          version: "0.0.0",
          kind: "base",
          metadata: { registryPins: ["pyproject.toml", "gitignore", join("tools", "uv.sh")] },
        }),
      );
      writeFileSync(
        join(npmRoot, "capability.json"),
        JSON.stringify({
          id: "npm-carrier",
          version: "0.0.0",
          kind: "feature",
          metadata: { registryPins: [".npmrc.hbs", ".npmrc.example"] },
        }),
      );
      writeFileSync(
        join(pythonTemplate, "pyproject.toml"),
        '[[tool.uv.index]]\nname = "mistralai"\nurl = "https://example.test/py/"\nexplicit = true\n',
      );
      writeFileSync(join(pythonTemplate, "gitignore"), ".env.gemfury\n");
      writeFileSync(
        join(pythonTemplate, "tools", "uv.sh"),
        '#!/usr/bin/env bash\nexport UV_DEFAULT_INDEX="https://pypi.org/simple"\n' +
          '# --- BEGIN private-index credentials ---\nexport MISTRAL_REGISTRY_USER=mistralai\ntoken="$MISTRAL_REGISTRY_TOKEN"\n# --- END private-index credentials ---\n' +
          'exec uv "$@"\n',
      );
      writeFileSync(join(npmTemplate, ".npmrc.hbs"), "");
      writeFileSync(join(npmTemplate, ".npmrc.example"), "");
      // A file at a projected path that the carrier does not list is left alone: the npm carrier's
      // own `gitignore` must not run through core's ignore-file projector.
      writeFileSync(join(npmTemplate, "gitignore"), "node_modules\n");

      const found = readRegistryPinCarriers(root);
      expect(found.map(({ manifest }) => manifest.path).toSorted()).toEqual([
        "base/python-carrier",
        "feature/npm-carrier",
      ]);
      const pinned = found.map(({ canonical, template }) =>
        registryPins(DEFAULT_PACKAGE_REGISTRY, canonical, template).map(({ path }) =>
          relative(root, path),
        ),
      );
      expect(pinned.flat().toSorted()).toEqual(
        [
          join("capabilities", "base", "python-carrier", "template", "gitignore"),
          join("capabilities", "base", "python-carrier", "template", "pyproject.toml"),
          join("capabilities", "base", "python-carrier", "template", "tools", "uv.sh"),
          join("capabilities", "feature", "npm-carrier", "template", ".npmrc.example"),
          join("capabilities", "feature", "npm-carrier", "template", ".npmrc.hbs"),
        ].toSorted(),
      );
      // The generators read those nested files and rewrite the anchors without throwing.
      for (const { canonical, template } of found) {
        expect(() =>
          registryPins(DEFAULT_PACKAGE_REGISTRY, canonical, template).map((pin) => pin.generate()),
        ).not.toThrow();
      }

      // A listed file the template does not ship is a mistake, not a no-op.
      rmSync(join(npmTemplate, ".npmrc.example"));
      expect(() => readRegistryPinCarriers(root)).toThrow(
        "feature/npm-carrier lists .npmrc.example in metadata.registryPins but its template does not ship it",
      );

      // So is a listed file no projector knows how to rewrite.
      writeFileSync(
        join(npmRoot, "capability.json"),
        JSON.stringify({
          id: "npm-carrier",
          version: "0.0.0",
          kind: "feature",
          metadata: { registryPins: [".npmrc.hbs", "gitignore.local"] },
        }),
      );
      expect(() => readRegistryPinCarriers(root)).toThrow(
        "feature/npm-carrier lists gitignore.local in metadata.registryPins, which has no projector",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
