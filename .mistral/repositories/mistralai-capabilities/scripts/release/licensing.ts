/**
 * Which published artifacts carry the repository's Apache-2.0 grant.
 *
 * A licence only operates towards whoever receives the code, and most of this
 * repository never leaves it: the source is private and the private capability
 * packages go to Gemfury and Cloudsmith under whatever agreement the consumer
 * already has. Declaring Apache-2.0 on those would offer terms nobody meant to
 * offer, so the grant follows the same `metadata.public` flag the publication
 * gate reads. A public capability declares `Apache-2.0` and is staged the root
 * `LICENSE`; everything else declares itself proprietary and ships no licence
 * text at all.
 */

import { localCapabilityId } from "../shared/capability-identity";
import type { CapabilityManifest } from "../shared/manifests";
import { CAPABILITY_PACKAGE_SCOPE, type PackageManifest } from "./package-manifests";

export const PUBLIC_LICENSE = "Apache-2.0";
/** npm's own spelling for "no rights granted". Deliberately not an SPDX identifier. */
export const PRIVATE_NPM_LICENSE = "UNLICENSED";
/** uv validates `[project].license` as an SPDX expression, and rejects `UNLICENSED`. */
export const PRIVATE_PYTHON_LICENSE = "LicenseRef-Proprietary";

/**
 * Shared packages licensed like a public capability. The descriptor is how an
 * external consumer discovers this registry at all, so it goes to npmjs.org
 * whatever the capabilities listed in it are.
 */
export const PUBLIC_SHARED_PACKAGES: ReadonlySet<string> = new Set([
  `${CAPABILITY_PACKAGE_SCOPE}/registry`,
]);

/** The `<kind>/<id>` of every capability that opted into public publication. */
export const publicCapabilityIds = (
  manifests: readonly CapabilityManifest[],
): ReadonlySet<string> =>
  new Set(
    manifests
      .filter(({ metadata }) => metadata?.public === true)
      .map((manifest) => localCapabilityId(manifest)),
  );

/** The two PEP 639 licence keys of a `[project]` table, as uv reads them. */
export interface PythonLicenseDeclaration {
  license?: string;
  "license-files"?: string[];
}

/** Read a `pyproject.toml`'s licence declaration, ignoring a same-named key in a later table. */
export function readPythonLicense(source: string): PythonLicenseDeclaration {
  // SAFETY: uv owns this schema. Only the two licence keys are read and every caller compares them
  // against an expected value, so a `pyproject.toml` that declares something else fails the
  // comparison rather than being trusted through the assertion.
  const { project } = Bun.TOML.parse(source) as { project?: PythonLicenseDeclaration };
  return project ?? {};
}

export const publiclyLicensed = (
  { capability, name }: Pick<PackageManifest, "capability" | "name">,
  publicIds: ReadonlySet<string>,
): boolean =>
  capability === undefined
    ? PUBLIC_SHARED_PACKAGES.has(name)
    : publicIds.has(localCapabilityId(capability));
