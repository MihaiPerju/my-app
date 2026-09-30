#!/usr/bin/env bun
/**
 * publish-plan.ts — the contract between `pack-all.ts` and every step that
 * uploads what it produces. `pack-all.ts` writes the plan; each publish step
 * reads its upload set through `planFor`. Routing is a field on the entry, so a
 * per-index variant built for one index cannot leak into another's upload.
 *
 * Prints one `<dist-tag>\t<absolute-path>` row per tarball, because an uploader
 * that has to spell the dist tag itself is one that can get it wrong.
 *
 *   bun scripts/release/publish-plan.ts <registry-id>
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  isPackageRegistryId,
  PACKAGE_REGISTRIES,
  PACKAGE_REGISTRY_IDS,
  type PackageRegistryId,
} from "./package-registries";

export interface PlanEntry {
  name: string;
  version: string;
  /** Path relative to `OUT_DIR`. */
  tarball: string;
  /** Per-index packages only: publish this tarball to that registry alone. */
  registry?: PackageRegistryId;
  /** Registry-specific variants that must exist elsewhere in this plan. */
  requiredVariants?: PackageRegistryId[];
  /** Dependency-safe concurrency wave; lower groups complete before higher groups start. */
  publishGroup?: number;
}

export const OUT_DIR = join(process.cwd(), "dist", "npm");
export const PLAN_PATH = join(OUT_DIR, "publish-plan.json");

export function readPlan(path = PLAN_PATH): PlanEntry[] {
  if (!existsSync(path)) {
    throw new Error(`no publish plan at ${path} — run pack-all.ts first`);
  }
  // SAFETY: the path is either `PLAN_PATH` or another checkout's corresponding file; both are
  // written only by `pack-all.ts`, which serialises a `PlanEntry[]` there.
  return JSON.parse(readFileSync(path, "utf8")) as PlanEntry[];
}

/**
 * The tarballs `registryId` uploads: every shared one, plus its own variant of each per-index
 * package and no other. Audience siblings and explicit `requiredVariants` are both completeness
 * contracts: the latter lets a shared internal artifact declare that a public route must also
 * exist, even though the public audience has only one registry to compare against.
 */
export function planFor(
  registryId: PackageRegistryId,
  plan: PlanEntry[] = readPlan(),
): PlanEntry[] {
  const audience = PACKAGE_REGISTRIES[registryId].audience;
  const targeted = plan.filter(
    (entry) =>
      entry.registry === registryId || (audience === "internal" && entry.registry === undefined),
  );
  const audienceRegistries = new Set(
    PACKAGE_REGISTRY_IDS.filter((id) => PACKAGE_REGISTRIES[id].audience === audience),
  );
  const perIndex = new Set(
    plan.flatMap((entry) =>
      entry.registry !== undefined && audienceRegistries.has(entry.registry) ? [entry.name] : [],
    ),
  );
  for (const entry of plan) {
    if (entry.requiredVariants?.includes(registryId)) perIndex.add(entry.name);
  }
  const missing = [...perIndex].filter(
    (name) => !targeted.some((entry) => entry.name === name && entry.registry === registryId),
  );
  if (missing.length > 0) {
    throw new Error(`publish plan has no '${registryId}' variant of ${missing.join(", ")}`);
  }
  if (!targeted.some((entry) => entry.registry === registryId)) {
    throw new Error(`publish plan has no per-index variants for '${registryId}'`);
  }
  return targeted;
}

/**
 * The npm dist-tag a version publishes under. `npm publish` defaults to
 * `latest`, and Cloudsmith assigns `latest` to the semantically highest upload,
 * so a release candidate left to either default would become what every
 * `bun add @mistralai-capabilities/<id>` in the world resolves to. Derived from
 * the version rather than passed in: the one caller that could get it wrong is
 * the one that must not.
 */
export function distTagFor(version: string): string {
  return version.includes("-") ? "rc" : "latest";
}

if (import.meta.main) {
  const registryId = process.argv[2];
  if (!registryId || !isPackageRegistryId(registryId)) {
    console.error("usage: publish-plan.ts <registry-id>");
    process.exit(1);
  }
  try {
    for (const { version, tarball } of planFor(registryId)) {
      console.log(`${distTagFor(version)}\t${join(OUT_DIR, tarball)}`);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
