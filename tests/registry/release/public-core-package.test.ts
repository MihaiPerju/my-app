import { describe, expect, test } from "bun:test";

import {
  publicCorePackageManifest,
  PUBLIC_CORE_PACKAGE_FILES,
} from "../../../scripts/release/public-core-package";

// This module is release-artifact policy for the npm tarball of the `@mistralai-capabilities/core`
// PACKAGE itself (its `files` allowlist), a distinct concern from the app-template registry-pin
// projection covered in registry-pins.test.ts / package-registries.test.ts.
describe("public Core package allowlist", () => {
  test("has the reviewed package-root surface", () => {
    expect(PUBLIC_CORE_PACKAGE_FILES).toEqual([
      ".templateignore",
      "capability.json",
      "CHANGELOG.md",
      "INSTALL.md",
      "package",
      "template",
      "tsconfig.json",
    ]);
  });

  test("replaces files with the public allowlist, without mutating other manifest fields", () => {
    // SAFETY: publicCorePackageManifest serializes this fixture shape itself immediately above.
    const projected = JSON.parse(
      publicCorePackageManifest(
        '{"name":"@mistralai-capabilities/base-core","version":"1.2.3","files":["internal"]}\n',
      ),
    ) as { files?: string[]; name?: string; version?: string };

    expect(projected.name).toBe("@mistralai-capabilities/base-core");
    expect(projected.version).toBe("1.2.3");
    expect(projected.files).toEqual([...PUBLIC_CORE_PACKAGE_FILES]);
  });

  test("serializes as pretty-printed JSON with a trailing newline", () => {
    const projected = publicCorePackageManifest('{"name":"@mistralai-capabilities/base-core"}\n');
    expect(projected.endsWith("}\n")).toBe(true);
    expect(projected).toContain('"files": [\n');
  });
});
