#!/usr/bin/env bun
/**
 * npm-package-existence.ts — which packages in the public plan npmjs.org does not hold yet.
 *
 * npm attaches a trusted publisher to a package that already exists, and has no
 * equivalent of PyPI's pending publishers, so the first release of a capability
 * has nothing to stage against. This asks the public registry, unauthenticated,
 * before any credential is in play, so a release that would die partway through
 * the plan stops before it stages anything.
 */

import { appendFileSync } from "node:fs";

import { PACKAGE_REGISTRIES, PUBLIC_PACKAGE_REGISTRY } from "./package-registries";
import { planFor, type PlanEntry } from "./publish-plan";

/** Answers the registry's HTTP status for one package name. */
export type PackageProbe = (name: string) => Promise<number>;

/**
 * The packument URL for `name`. The scope separator is escaped because a bare
 * `/` in a scoped name reads as a path segment and returns the wrong document.
 */
export function packumentUrl(name: string): string {
  return new URL(name.replace("/", "%2F"), PACKAGE_REGISTRIES[PUBLIC_PACKAGE_REGISTRY].ts).href;
}

const probeNpm: PackageProbe = async (name) => (await fetch(packumentUrl(name))).status;

/**
 * The subset of `names` the registry answers `404` for, in the order given. Any
 * other status throws: a rate limit or an outage cannot be read as "this package
 * needs creating", which would send the run to a job that publishes.
 */
export async function missingPackages(
  names: readonly string[],
  probe: PackageProbe = probeNpm,
): Promise<string[]> {
  const missing: string[] = [];
  for (const name of names) {
    const status = await probe(name);
    if (status === 404) missing.push(name);
    else if (status !== 200) {
      throw new Error(
        `npmjs.org answered ${status} for ${name}; cannot tell whether the package exists`,
      );
    }
  }
  return missing;
}

/** Every distinct package name the public plan stages, sorted. */
export function publicPlanNames(entries: readonly PlanEntry[]): string[] {
  return [...new Set(entries.map(({ name }) => name))].toSorted((a, b) => a.localeCompare(b));
}

/**
 * The step output the bootstrap job keys off. A space-separated list, because the
 * consuming step splits it with `read -a`, and empty when nothing is missing, so
 * the job's `!= ''` reads as "no packages to create".
 */
export function missingOutputLine(missing: readonly string[]): string {
  return `missing=${missing.join(" ")}\n`;
}

export async function preflight(
  names: readonly string[],
  probe?: PackageProbe,
  githubOutput = process.env.GITHUB_OUTPUT,
): Promise<string[]> {
  const missing = await missingPackages(names, probe);

  for (const name of names) {
    console.log(`${missing.includes(name) ? "MISSING" : "present"} ${name}`);
  }
  if (missing.length > 0) {
    console.warn(
      `::warning::${missing.length} package(s) do not exist on npmjs.org and cannot be staged ` +
        `until they are created and given a trusted publisher: ${missing.join(", ")}`,
    );
  }

  if (githubOutput !== undefined) appendFileSync(githubOutput, missingOutputLine(missing));
  return missing;
}

if (import.meta.main) {
  try {
    await preflight(publicPlanNames(planFor(PUBLIC_PACKAGE_REGISTRY)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
