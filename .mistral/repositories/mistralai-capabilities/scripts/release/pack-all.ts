#!/usr/bin/env bun
/**
 * pack-all.ts — pack every publishable npm package into `dist/npm/`, and write
 * the leaf-first publish plan next to the tarballs. Packing is separate from
 * publishing so one tarball serves every registry. Two kinds of package cannot: the
 * descriptor (`sources` names the host a consumer installs from) and each capability
 * declaring `metadata.registryPins` (its template carries registry connection state).
 * They are packed once per index of their audience and routed by `registry` in the plan.
 *
 *   bun scripts/release/pack-all.ts <version>
 */

import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { $ } from "bun";

import { readRegistryPinCarriers, registryPins } from "../registry/app-registry-pins";
import { buildDescriptor } from "../registry/build-registry";
import { validatedPublicCapabilities } from "../registry/publication-check";
import {
  INTERNAL_PACKAGE_REGISTRY_IDS,
  PACKAGE_REGISTRIES,
  PACKAGE_REGISTRY_IDS,
  PACKAGE_REGISTRY_LANGUAGES,
  PUBLIC_PACKAGE_REGISTRY,
} from "./package-registries";
import {
  CAPABILITY_PACKAGE_SCOPE as SCOPE,
  REGISTRY_ID,
  scanPackageManifests,
} from "./package-manifests";
import {
  localCapabilityId,
  type CapabilityIdentity,
  npmCapabilityName,
  uniqueCapabilityId,
} from "../shared/capability-identity";
import { readManifests } from "../shared/manifests";
import { publicCorePackageManifest } from "./public-core-package";
import { OUT_DIR, PLAN_PATH, planFor, type PlanEntry } from "./publish-plan";

const version = process.argv[2];
if (!version) {
  console.error("usage: pack-all.ts <version>");
  process.exit(1);
}

/** Packed per registry below rather than in the shared pass. */
const DESCRIPTOR_PACKAGE = `${SCOPE}/registry`;
interface Manifest {
  dir: string;
  name: string;
  internalDeps: string[];
  capability?: CapabilityIdentity;
  /** Strict opt-in; shared packages are internal unless handled explicitly. */
  public: boolean;
}

/** The repo-root descriptor, in the only shape this script touches. */
interface Descriptor {
  sources: Record<string, string>;
  kinds: { id: string }[];
  capabilities: {
    id: string;
    kind: string;
    packages: string[];
    compatibility?: Record<string, string[]>;
  }[];
}

const root = process.cwd();
rmSync(OUT_DIR, { recursive: true, force: true });
mkdirSync(OUT_DIR, { recursive: true });

// Read capability manifests once, then feed the same validated objects to publication policy,
// npm package discovery, and descriptor construction.
const capabilityManifests = readManifests(root);
// The declared carriers ship registry pins a consumer cannot re-resolve after generation. Capture
// their canonical inputs once, before any variant is written.
const pinCarriers = new Map(
  readRegistryPinCarriers(root, capabilityManifests).map((carrier) => [
    npmCapabilityName(REGISTRY_ID, carrier.manifest),
    carrier,
  ]),
);
const publicCapabilities = new Set(
  validatedPublicCapabilities(capabilityManifests, REGISTRY_ID, "capabilities", root).map(
    localCapabilityId,
  ),
);
const manifests: Manifest[] = scanPackageManifests(root, capabilityManifests)
  .filter(({ name, publishable }) => publishable && name !== DESCRIPTOR_PACKAGE)
  .map(({ capability, dir, json, name }) => {
    const allDeps = { ...json.dependencies, ...json.devDependencies, ...json.peerDependencies };
    return {
      dir,
      name,
      internalDeps: Object.keys(allDeps).filter((dependency) => dependency.startsWith(`${SCOPE}/`)),
      capability,
      // Shared packages never become public merely because they are present in the
      // internal build. The descriptor is the sole explicit shared public package
      // and is packed separately below.
      public: capability !== undefined && publicCapabilities.has(localCapabilityId(capability)),
    };
  });

const allNames = new Set(manifests.map((m) => m.name));
const manifestByName = new Map(manifests.map((manifest) => [manifest.name, manifest]));
for (const manifest of manifests.filter(({ public: isPublic }) => isPublic)) {
  const privateDependencies = manifest.internalDeps.filter((dependency) => {
    const dependencyManifest = manifestByName.get(dependency);
    return dependencyManifest !== undefined && !dependencyManifest.public;
  });
  if (privateDependencies.length > 0) {
    throw new Error(
      `public npm package ${manifest.name} depends on non-public package(s): ${privateDependencies.join(", ")}`,
    );
  }
}
const seen = new Set<string>();
const ordered: Manifest[] = [];
let progress = true;
while (ordered.length < manifests.length && progress) {
  progress = false;
  for (const m of manifests) {
    if (seen.has(m.name)) continue;
    const blockers = m.internalDeps.filter((d) => allNames.has(d) && !seen.has(d));
    if (blockers.length === 0) {
      ordered.push(m);
      seen.add(m.name);
      progress = true;
    }
  }
}
if (ordered.length < manifests.length) {
  console.error(`Dependency cycle among ${SCOPE}/* packages; cannot order publish.`);
  process.exit(1);
}
const publishGroupByName = new Map<string, number>();
for (const manifest of ordered) {
  const dependencyGroups = manifest.internalDeps.flatMap((dependency) => {
    const group = publishGroupByName.get(dependency);
    return group === undefined ? [] : [group];
  });
  publishGroupByName.set(
    manifest.name,
    dependencyGroups.length === 0 ? 0 : Math.max(...dependencyGroups) + 1,
  );
}
const descriptorPublishGroup = Math.max(-1, ...publishGroupByName.values()) + 1;

// Packed per index below, but ordered here with everything else so their dependents still follow
// them. An absent one would leave every index without the package declared to carry its app pins.
for (const name of pinCarriers.keys()) {
  if (!ordered.some((m) => m.name === name)) {
    console.error(
      `${name} declares metadata.registryPins but has no publishable npm package; ` +
        "the per-index pin writer projects packaged carriers only.",
    );
    process.exit(1);
  }
}

// Validate the descriptor/package correspondence before creating any tarballs. The descriptor is
// what tells the CLI a capability exists; omitting its npm artifact produces a release that looks
// complete but cannot install that capability through the default package transport. Only
// ts-packaged capabilities (those declaring the `ts` transport) ship an npm package; template-only
// capabilities (`packages: []`) are vendored through `sources.git` and have no npm artifact to
// compare, so they are excluded from both sides of this check.
const source = buildDescriptor(root, capabilityManifests);
// SAFETY: buildDescriptor constructs and serializes this exact descriptor shape above; parsing
// only gives this script an independent copy to compare and later rewrite per registry.
const sourceDescriptor = JSON.parse(source) as Descriptor;
// Template-only capabilities (empty `packages`) publish no npm tarball -- they are git-delivered
// -- so they appear in the descriptor but never in the discovered npm package set. Compare only
// the capabilities that actually publish a package, mirroring scanPackageManifests' own skip.
const describedPackages = sourceDescriptor.capabilities
  .filter(({ packages }) => packages.includes("ts"))
  .map(({ id, kind }) => npmCapabilityName(REGISTRY_ID, { kind, id }))
  .toSorted();
const discoveredPackages = manifests
  .filter((manifest) => manifest.capability !== undefined)
  .map((manifest) => manifest.name)
  .toSorted();
if (JSON.stringify(discoveredPackages) !== JSON.stringify(describedPackages)) {
  throw new Error(
    `capability package set does not match registry descriptor:\n` +
      `descriptor: ${describedPackages.join(", ")}\npackages: ${discoveredPackages.join(", ")}`,
  );
}

const plan: PlanEntry[] = [];

/**
 * `npm pack --pack-destination` writes `<scope>-<name>-<version>.tgz` and prints
 * the filename on stdout. `subdir` is relative to `OUT_DIR`, as is the returned
 * path, which the publish plan records.
 */
async function pack(name: string, dir: string, subdir = ""): Promise<string> {
  const destination = join(OUT_DIR, subdir);
  const res = await $`npm pack --pack-destination ${destination}`.cwd(dir).quiet().nothrow();
  const tarball = res.stdout.toString().trim().split("\n").pop()?.trim();
  if (res.exitCode !== 0 || !tarball || !existsSync(join(destination, tarball))) {
    const reason = res.stderr.toString().trim() || "npm pack produced no tarball";
    console.error(`FAILED ${name}: ${reason}`);
    process.exit(1);
  }
  return join(subdir, tarball);
}

// Every carrier variant is packed from an untracked copy of its complete root. No signal, OOM, or
// interrupted pack can leave projected registry state in the checkout.
const pinStageRoot = mkdtempSync(join(tmpdir(), "mistralai-registry-pin-package-"));
process.on("exit", () => rmSync(pinStageRoot, { recursive: true, force: true }));

for (const m of ordered) {
  const pinCarrier = pinCarriers.get(m.name);
  if (pinCarrier === undefined) {
    const tarball = await pack(m.name, m.dir);
    plan.push({
      name: m.name,
      version,
      tarball,
      requiredVariants: m.public ? [PUBLIC_PACKAGE_REGISTRY] : undefined,
      publishGroup: publishGroupByName.get(m.name),
    });
    if (m.public) {
      plan.push({
        name: m.name,
        version,
        tarball,
        registry: PUBLIC_PACKAGE_REGISTRY,
        publishGroup: publishGroupByName.get(m.name),
      });
    }
    console.log(`packed ${m.name}@${version} -> ${tarball}`);
    continue;
  }

  const stagedPinCarrierDir = join(pinStageRoot, relative(root, m.dir));
  mkdirSync(dirname(stagedPinCarrierDir), { recursive: true });
  // The stage sits outside the checkout, so npm's ignore-file walk no longer reaches the root
  // `.gitignore` and would otherwise pack build output such as `.turbo/`.
  cpSync(m.dir, stagedPinCarrierDir, {
    recursive: true,
    filter: (src) => basename(src) !== ".turbo",
  });
  const stagedCarrierPackageJson = join(stagedPinCarrierDir, "package.json");
  const internalCarrierPackageJson = readFileSync(stagedCarrierPackageJson, "utf8");
  // Expanded in place rather than appended, so the carrier keeps its topological slot: every
  // publish step walks the plan in order, and uploading a dependent first opens a 404 window.
  const pinRegistries = m.public
    ? [...INTERNAL_PACKAGE_REGISTRY_IDS, PUBLIC_PACKAGE_REGISTRY]
    : INTERNAL_PACKAGE_REGISTRY_IDS;
  for (const id of pinRegistries) {
    const stagedTemplate = join(stagedPinCarrierDir, "template");
    for (const { path, generate } of registryPins(id, pinCarrier.canonical, stagedTemplate)) {
      writeFileSync(path, generate());
    }
    // The package-root manifest gets exactly one write per variant, from the internal bytes read
    // above: only the public Core `files` allowlist ever needs anything else, so that is the only
    // condition that picks a different source before this single write, rather than restoring the
    // internal bytes first and then conditionally overwriting them again.
    const isPublicCorePackage =
      PACKAGE_REGISTRIES[id].audience === "public" &&
      pinCarrier.manifest.kind === "base" &&
      pinCarrier.manifest.id === "core";
    writeFileSync(
      stagedCarrierPackageJson,
      isPublicCorePackage
        ? publicCorePackageManifest(internalCarrierPackageJson)
        : internalCarrierPackageJson,
    );
    const subdir = join("pins", id);
    mkdirSync(join(OUT_DIR, subdir), { recursive: true });
    const tarball = await pack(m.name, stagedPinCarrierDir, subdir);
    plan.push({
      name: m.name,
      version,
      tarball,
      registry: id,
      requiredVariants: pinRegistries,
      publishGroup: publishGroupByName.get(m.name),
    });
    console.log(`packed ${m.name}@${version} for ${id} -> ${tarball}`);
  }
}
rmSync(pinStageRoot, { recursive: true, force: true });

// The descriptor package ships the repo-root `registry.json` as its only
// payload. It is inflated once per package index, because `sources` names the
// host the consumer installs from, a property of the index, not the release.
const descriptorDir = join(root, "packages", "registry");
if (!existsSync(descriptorDir)) {
  console.error(`${descriptorDir} is missing; there is no descriptor package to pack.`);
  process.exit(1);
}
const descriptorPackageJson = join(descriptorDir, "package.json");
const internalDescriptorReadmePath = join(descriptorDir, "README.md");
const publicDescriptorReadmePath = fileURLToPath(
  new URL("./public-registry-readme.md", import.meta.url),
);
for (const required of [
  descriptorPackageJson,
  internalDescriptorReadmePath,
  publicDescriptorReadmePath,
]) {
  if (!existsSync(required)) {
    console.error(`${required} is missing; the descriptor package cannot be staged.`);
    process.exit(1);
  }
}

// Pack from an untracked temporary directory. npm always includes a package-root README even when
// it is absent from the `files` allowlist, so each audience gets its own documentation without
// ever rewriting the committed internal README (even a SIGKILL cannot dirty the checkout).
const descriptorStage = mkdtempSync(join(tmpdir(), "mistralai-registry-package-"));
process.on("exit", () => rmSync(descriptorStage, { recursive: true, force: true }));
copyFileSync(descriptorPackageJson, join(descriptorStage, "package.json"));
// The stage is built file by file, so unlike every other package the descriptor does not inherit
// the LICENSE prepare-publish.ts drops into each package root.
copyFileSync(join(root, "LICENSE"), join(descriptorStage, "LICENSE"));
const internalDescriptorReadme = readFileSync(internalDescriptorReadmePath);
const publicDescriptorReadme = readFileSync(publicDescriptorReadmePath);
const descriptorReadme = join(descriptorStage, "README.md");

// Derive the descriptor from the capability manifests on disk rather than the
// committed registry.json. prepare-publish.ts has already stamped each
// capability.json to the release version by the time pack runs, and the
// descriptor is a projection of those manifests; reading the committed file
// would ship the pre-stamp 0.0.0 versions to every consumer that resolves a
// capability through the descriptor. build-registry keeps this byte-identical to
// the committed descriptor apart from the versions it now carries.
const payload = join(descriptorStage, "registry.json");
for (const id of PACKAGE_REGISTRY_IDS) {
  const isPublic = PACKAGE_REGISTRIES[id].audience === "public";
  writeFileSync(descriptorReadme, isPublic ? publicDescriptorReadme : internalDescriptorReadme);

  // The canonical builder remains the byte-for-byte CLI v3 projection. Audience filtering belongs
  // only to this release variant: public discovery retains strict opt-in capabilities and cannot
  // expose the private Git source, while internal variants preserve the canonical descriptor.
  // SAFETY: `source` is `buildDescriptor()` output — the repo-root registry.json schema.
  const descriptor = JSON.parse(source) as Descriptor;
  if (isPublic) {
    descriptor.capabilities = descriptor.capabilities.filter((capability) =>
      publicCapabilities.has(localCapabilityId(capability)),
    );
    // Compatibility maps are another capability-reference surface. Drop private/foreign targets
    // and empty keys before trimming kinds, so every retained key still names a represented kind.
    const publicCapabilityRefs = new Set(
      descriptor.capabilities.map((capability) => uniqueCapabilityId(REGISTRY_ID, capability)),
    );
    for (const capability of descriptor.capabilities) {
      if (capability.compatibility === undefined) continue;
      const compatibility = Object.fromEntries(
        Object.entries(capability.compatibility).flatMap(([kind, targets]) => {
          const publicTargets = targets.filter((target) => publicCapabilityRefs.has(target));
          return publicTargets.length === 0 ? [] : [[kind, publicTargets]];
        }),
      );
      capability.compatibility =
        Object.keys(compatibility).length === 0 ? undefined : compatibility;
    }
    const publicKindIds = new Set(descriptor.capabilities.map(({ kind }) => kind));
    descriptor.kinds = descriptor.kinds.filter(({ id: kind }) => publicKindIds.has(kind));
    delete descriptor.sources.git;
  }
  for (const lang of PACKAGE_REGISTRY_LANGUAGES) {
    // A new key would invent a source the CLI installs from. A missing key
    // means this is not what `mistral apps registry build` produces, which is a
    // bug to surface.
    if (!(lang in descriptor.sources)) {
      console.error(`registry.json has no \`sources.${lang}\` to point at ${id}`);
      process.exit(1);
    }
    descriptor.sources[lang] = PACKAGE_REGISTRIES[id][lang];
  }
  writeFileSync(payload, JSON.stringify(descriptor, null, 2) + "\n");
  const subdir = join("descriptor", id);
  mkdirSync(join(OUT_DIR, subdir), { recursive: true });
  const tarball = await pack(DESCRIPTOR_PACKAGE, descriptorStage, subdir);
  plan.push({
    name: DESCRIPTOR_PACKAGE,
    version,
    tarball,
    registry: id,
    requiredVariants: PACKAGE_REGISTRY_IDS,
    publishGroup: descriptorPublishGroup,
  });
  console.log(`packed ${DESCRIPTOR_PACKAGE}@${version} for ${id} -> ${tarball}`);
}
rmSync(descriptorStage, { recursive: true, force: true });

writeFileSync(PLAN_PATH, JSON.stringify(plan, null, 2) + "\n");
// Every publish step derives its upload set from this plan. A plan that leaves
// an index without its variant is caught here, in the build, not in whichever
// job runs first.
for (const id of PACKAGE_REGISTRY_IDS) planFor(id, plan);
console.log(`\nPacked ${plan.length} package(s) at ${version} into dist/npm.`);
