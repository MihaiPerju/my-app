/**
 * public-core-package.ts — the npm tarball `files` allowlist for the released
 * `@mistralai-capabilities/core` PACKAGE itself. This is release-artifact policy (what ships inside
 * the package a consumer runs `npm install` against), a distinct concern from the app-template
 * registry-pin projection in `scripts/registry/app-registry-pins.ts` (what a generated app's own
 * `template/package.json`/`bunfig.toml` contain for a given package index). Do not merge the two:
 * this module knows nothing about audiences or indexes, only about which package-root paths a
 * public Core tarball may carry.
 */

interface NpmPackageManifest {
  files?: string[];
}

/** The package-root surface allowed into the public Core tarball. */
export const PUBLIC_CORE_PACKAGE_FILES = [
  ".templateignore",
  "capability.json",
  "CHANGELOG.md",
  "INSTALL.md",
  "package",
  "template",
  "tsconfig.json",
] as const;

/** Add Core's explicit public package surface without mutating the internal package manifest. */
export function publicCorePackageManifest(source: string): string {
  // SAFETY: prepare-publish validates this package.json before pack-all projects its files list.
  const manifest = JSON.parse(source) as NpmPackageManifest;
  manifest.files = [...PUBLIC_CORE_PACKAGE_FILES];
  return `${JSON.stringify(manifest, null, 2)}\n`;
}
