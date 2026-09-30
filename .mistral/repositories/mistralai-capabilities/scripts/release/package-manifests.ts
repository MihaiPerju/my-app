/**
 * The single discovery and validation contract for npm packages included in a
 * release. Preparation and packing must see the same directories, names, and
 * build-only exclusions or they can produce a package set different from the
 * one they stamped.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import {
  type CapabilityIdentity,
  npmCapabilityName,
  uniqueCapabilityId,
} from "../shared/capability-identity";
import { type CapabilityManifest, readManifests } from "../shared/manifests";

export const CAPABILITY_PACKAGE_SCOPE = "@mistralai-capabilities";
/** The registry id backing {@link CAPABILITY_PACKAGE_SCOPE} (the scope without its `@`). */
export const REGISTRY_ID = CAPABILITY_PACKAGE_SCOPE.slice(1);

const BUILD_ONLY_PACKAGES = new Set([`${CAPABILITY_PACKAGE_SCOPE}/config`]);

/** The npm manifest fields decoded for the release pipeline. */
interface DecodedPackageJson {
  name?: string;
  version?: string;
  private?: boolean;
  license?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  publishConfig?: {
    access?: string;
    registry?: string;
  };
}

const dependencyMapSchema = z.record(z.string(), z.string()).optional();
const packageJsonSchema: z.ZodType<DecodedPackageJson> = z.looseObject({
  name: z.string().optional(),
  version: z.string().optional(),
  private: z.boolean().optional(),
  license: z.string().optional(),
  dependencies: dependencyMapSchema,
  devDependencies: dependencyMapSchema,
  peerDependencies: dependencyMapSchema,
  publishConfig: z
    .looseObject({
      access: z.string().optional(),
      registry: z.string().optional(),
    })
    .optional(),
});

// A capability.json MUST carry an explicit `packages` array of transport ids: `[]` marks a
// template-only capability delivered through sources.git, while an accidental omission is a
// release hazard (a package that should ship gets silently dropped), so the field is required.
const capabilityPackagesSchema = z.looseObject({ packages: z.array(z.string()) });

/** A decoded package manifest whose required publication name is validated. */
export interface PackageJson extends DecodedPackageJson {
  name: string;
}

export interface PackageManifest {
  dir: string;
  manifestPath: string;
  name: string;
  json: PackageJson;
  /** The kind-qualified identity of the owning capability, or absent for a shared package. */
  capability?: CapabilityIdentity;
  publishable: boolean;
}

/**
 * Read a capability's declared package transports, requiring the field to be
 * explicit. `capability.json` MUST carry a `packages` array; an accidental
 * omission is rejected rather than silently treated as template-only, which
 * would drop a capability that should ship an npm/py package from the release.
 * A template-only capability declares `packages: []` deliberately.
 */
function readDeclaredPackages(capabilityDir: string, capabilityId: string): string[] {
  const capPath = join(capabilityDir, "capability.json");
  let parsed: { packages: string[] };
  try {
    parsed = capabilityPackagesSchema.parse(JSON.parse(readFileSync(capPath, "utf8")));
  } catch (error) {
    throw new Error(
      `${capPath}: capability \`${capabilityId}\` must declare an explicit \`packages\` array ` +
        `(use \`[]\` for a template-only capability delivered through sources.git); omitting it ` +
        `risks silently dropping a package from the release, and the file must be valid JSON.`,
      { cause: error },
    );
  }
  return parsed.packages;
}

/**
 * Find every package or capability root and validate the common publication
 * invariants before either release phase acts on the result. Capability npm
 * names are the kind-qualified `@<registry>/<kind>-<id>`; two capabilities that
 * render the same npm name are rejected here, before preparation writes anything.
 */
export function scanPackageManifests(
  root: string,
  capabilityManifests?: readonly CapabilityManifest[],
): PackageManifest[] {
  const manifests: PackageManifest[] = [];

  // Shared packages are flat top-level directories; capability roots are
  // discovered recursively (always `<kind>/<id>`), so the canonical scan — not a
  // one-level `readdirSync` — is what feeds this set.
  const targets: { dir: string; capability: CapabilityIdentity | undefined }[] = [];
  const packagesDir = join(root, "packages");
  try {
    for (const entry of readdirSync(packagesDir)) {
      targets.push({ dir: join(packagesDir, entry), capability: undefined });
    }
  } catch {
    // No packages tier in this repo layout.
  }
  // Only walk the capability roots when the tier exists — a shared-only package tree ships no
  // `capabilities/`, and readCapabilityRoots would throw ENOENT. A present tier is scanned
  // canonically (recursive, kind-qualified), so a malformed capability surfaces its own error.
  if (existsSync(join(root, "capabilities"))) {
    const capabilities = capabilityManifests ?? readManifests(root);
    for (const { id, kind, path } of capabilities) {
      targets.push({ dir: join(root, "capabilities", path), capability: { kind, id } });
    }
  }

  for (const { dir, capability } of targets) {
    if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) continue;

    if (capability !== undefined) {
      // A capability ships an npm package only when it declares the `ts`
      // transport. Template-only capabilities (no `ts`) carry no package.json:
      // they are vendored through the descriptor's git source, so npm discovery
      // must not require — nor invent — a package for them. This also enforces
      // the explicit `packages` declaration for every capability root.
      if (!readDeclaredPackages(dir, capability.id).includes("ts")) continue;
    }

    // The capabilities tier is already gated to real roots by the recursive
    // scan; a shared package directory has no capability.json to gate on.
    const manifestPath = join(dir, "package.json");
    let decoded: DecodedPackageJson;
    try {
      decoded = packageJsonSchema.parse(JSON.parse(readFileSync(manifestPath, "utf8")));
    } catch (error) {
      throw new Error(
        `${manifestPath}: every ${capability === undefined ? "package" : "capability"} directory must carry a valid package.json`,
        { cause: error },
      );
    }

    const name = decoded.name;
    if (capability !== undefined) {
      const expected = npmCapabilityName(REGISTRY_ID, capability);
      if (name !== expected) {
        throw new Error(
          `${manifestPath}: expected package name '${expected}', got '${name ?? "missing"}'`,
        );
      }
    } else if (name === undefined || name.length === 0) {
      throw new Error(`${manifestPath}: package name is required`);
    }

    const json: PackageJson = { ...decoded, name };
    manifests.push({
      dir,
      manifestPath,
      name,
      json,
      capability,
      publishable: !BUILD_ONLY_PACKAGES.has(name),
    });
  }

  // Every scanned npm name must be unique across the whole release. A shared package
  // and a capability (or two capabilities) that render the same name would silently
  // fight over package ownership, so reject a duplicate before any release phase
  // writes — naming each owner: a capability's full id, a shared package's manifest
  // path. The config/registry packages keep their non-capability names, but no
  // package is exempt from the duplicate-name check.
  const byName = new Map<string, string[]>();
  for (const manifest of manifests) {
    const owner =
      manifest.capability === undefined
        ? manifest.manifestPath
        : uniqueCapabilityId(REGISTRY_ID, manifest.capability);
    const owners = byName.get(manifest.name);
    if (owners === undefined) byName.set(manifest.name, [owner]);
    else owners.push(owner);
  }
  for (const [name, owners] of byName) {
    if (owners.length > 1) {
      throw new Error(
        `npm package name '${name}' is rendered by more than one package: ${owners.toSorted((a, b) => a.localeCompare(b)).join(", ")}.`,
      );
    }
  }

  return manifests;
}
