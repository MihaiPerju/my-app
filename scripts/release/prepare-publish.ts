#!/usr/bin/env bun
/**
 * prepare-publish.ts — mutate every publishable package.json for publication.
 * Per package: set version, drop `private`, resolve `workspace:*` to `^<version>`
 * and `catalog:` from the root catalog, bundle the repo-root `.templateignore`
 * into packages that ship a template/ zone, and bundle the repo-root `LICENSE`
 * into the package roots the Apache-2.0 grant covers. Build-only packages are
 * skipped.
 * Each capability's `capability.json` is stamped with the same version, so the
 * manifest a consumer reads matches the package it ships in instead of `0.0.0`.
 */

import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { readManifests } from "../shared/manifests";
import {
  PRIVATE_NPM_LICENSE,
  PUBLIC_LICENSE,
  publicCapabilityIds,
  publiclyLicensed,
} from "./licensing";
import { scanPackageManifests } from "./package-manifests";

const version = process.argv[2];
if (!version) {
  console.error("usage: prepare-publish.ts <version>");
  process.exit(1);
}

/** Any value a `capability.json` field can hold — arbitrary decoded JSON. */
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/**
 * The `capability.json` fields this script touches. build-registry.ts owns the
 * full schema; every other field is preserved verbatim on the round-trip.
 */
interface CapabilityManifest {
  id?: string;
  version?: string;
  [key: string]: JsonValue | undefined;
}

const root = process.cwd();
// SAFETY: this is the repo-root `package.json`, the bun workspace root. Bun owns
// the `workspaces.catalog` schema (a string-to-version map), so the only field
// read here is guaranteed by the tool that also consumes this file.
const rootPkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  workspaces?: { catalog?: Record<string, string> };
};
const catalog = rootPkg.workspaces?.catalog ?? {};
const rootTemplateIgnore = join(root, ".templateignore");
const hasRootTemplateIgnore = existsSync(rootTemplateIgnore);
// npm packs a package-root LICENSE regardless of the `files` allowlist, the same rule that puts
// README in the descriptor tarball. Copying at prepare time keeps one tracked copy at the root
// instead of one per package. Only the packages the grant covers get it; see licensing.ts.
const rootLicense = join(root, "LICENSE");
if (!existsSync(rootLicense)) {
  console.error(`${rootLicense} is missing; published packages would carry no licence text.`);
  process.exit(1);
}

// A pre-release version is only ever stamped by the release-candidate pipeline,
// which builds every capability from ONE commit. A caret would undo that: npm
// reads `^0.1.3-rc52309221` as ">=0.1.3-rc52309221 <0.2.0", which the RELEASED
// 0.1.3 satisfies and outranks, so installing an RC would resolve
// `@mistralai-capabilities/core` to the stable tree and hand the reviewer a mix
// of the two. Pin siblings exactly instead, and keep the caret for releases.
const isPrerelease = version.includes("-");

interface PlannedWrite {
  name: string;
  manifestPath: string;
  contents: string;
  /** Bundle the root `.templateignore` into this package's dir on write. */
  copyTemplateIgnore: boolean;
  /** Bundle the root `LICENSE` into this package's dir on write. */
  copyLicense: boolean;
  pkgDir: string;
}

interface PlannedManifest {
  id: string;
  path: string;
  contents: string;
}

// Two-phase, all-or-nothing: validate and render every manifest into an
// in-memory plan first, then apply the writes once the whole plan is good. A
// malformed dep or catalog entry found late aborts before any package.json is
// rewritten, so a failed run never leaves a half-stamped tree.
const planned: PlannedWrite[] = [];
const plannedManifests: PlannedManifest[] = [];
// Stamp EVERY capability's `capability.json` to the release version, whether or
// not it ships an npm package. A template-only capability (`packages: []`)
// carries no package.json and never appears in the npm scan below, but its
// `capability.json` still ships through the descriptor's git source and is
// projected into registry.json (build-registry.ts), so leaving it at 0.0.0 hands
// a consumer a manifest that disagrees with the release. scanPackageManifests
// (run below) enforces the explicit `packages` declaration for every root before
// any write lands, so this loop can read the manifests directly.
// The canonical capability traversal runs only when the `capabilities/` tier is
// present; a shared-only (`packages/`-only) release ships no capabilities to
// stamp. Mirrors the guard applied at every other capability traversal call
// site (Roots78), reading canonically when the tier exists rather than hiding a
// malformed capability behind a fallback.
const capabilityManifests = existsSync(join(root, "capabilities")) ? readManifests(root) : [];
const publicIds = publicCapabilityIds(capabilityManifests);
for (const { id, path } of capabilityManifests) {
  const capPath = join(root, "capabilities", path, "capability.json");
  // SAFETY: build-registry.ts owns this schema; `version` is a string field,
  // and every other field is preserved verbatim on the round-trip.
  const cap = JSON.parse(readFileSync(capPath, "utf8")) as CapabilityManifest;
  cap.version = version;
  plannedManifests.push({
    id: cap.id ?? id,
    path: capPath,
    contents: JSON.stringify(cap, null, 2) + "\n",
  });
}

// Stamp every npm package.json — the `packages/` tier plus every capability that
// declares the `ts` transport. Template-only capabilities are excluded by
// scanPackageManifests, so no package.json is required nor invented for them.
for (const manifest of scanPackageManifests(root, capabilityManifests)) {
  const { dir: pkgDir, json, manifestPath, name } = manifest;
  if (!manifest.publishable) {
    console.log(`skip ${name} (build-only)`);
    continue;
  }
  // The declared SPDX expression and the staged text have to agree, or the tarball either offers
  // terms the repository did not mean to offer or carries text no field points at.
  const copyLicense = publiclyLicensed(manifest, publicIds);
  const expectedLicense = copyLicense ? PUBLIC_LICENSE : PRIVATE_NPM_LICENSE;
  if (json.license !== expectedLicense) {
    throw new Error(
      `${manifestPath}: ${copyLicense ? "public" : "private"} package ${name} must declare "license": "${expectedLicense}", got ${JSON.stringify(json.license ?? null)}`,
    );
  }
  json.version = version;
  delete json.private;
  // No `publishConfig.registry`: the SAME tarball is published to both
  // Gemfury and Cloudsmith, and publishConfig.registry outranks
  // `npm publish --registry`, which would silently pin every release to one
  // of them. The target is chosen per publish step instead.
  json.publishConfig = { access: "restricted" };
  for (const key of ["dependencies", "devDependencies", "peerDependencies"] as const) {
    const deps = json[key];
    if (!deps) continue;
    for (const dep of Object.keys(deps)) {
      if (deps[dep] === "workspace:*") deps[dep] = isPrerelease ? version : `^${version}`;
      else if (deps[dep] === "catalog:") {
        const resolved = catalog[dep];
        if (!resolved) throw new Error(`${json.name}: no catalog entry for ${dep}`);
        deps[dep] = resolved;
      }
    }
  }
  planned.push({
    name,
    manifestPath,
    contents: JSON.stringify(json, null, 2) + "\n",
    copyTemplateIgnore: hasRootTemplateIgnore && existsSync(join(pkgDir, "template")),
    copyLicense,
    pkgDir,
  });
}

// Every manifest validated and rendered — apply the writes.
for (const w of planned) {
  writeFileSync(w.manifestPath, w.contents);
  if (w.copyTemplateIgnore) {
    copyFileSync(rootTemplateIgnore, join(w.pkgDir, ".templateignore"));
  }
  // Removing is as load-bearing as copying. npm packs a package-root LICENSE whatever `files` says,
  // so a copy left behind by an earlier run of this script, from before the capability went
  // private, would ship the Apache text inside a tarball declaring UNLICENSED.
  if (w.copyLicense) {
    copyFileSync(rootLicense, join(w.pkgDir, "LICENSE"));
  } else {
    rmSync(join(w.pkgDir, "LICENSE"), { force: true });
  }
  console.log(`prepared ${w.name}@${version}${w.copyLicense ? "" : " (proprietary)"}`);
}

// Every capability manifest rendered — apply those writes too.
for (const m of plannedManifests) {
  writeFileSync(m.path, m.contents);
  console.log(`stamped ${m.id} capability.json @ ${version}`);
}

console.log(
  `prepared ${planned.length} package(s) and ${plannedManifests.length} capability manifest(s) at version ${version}`,
);
