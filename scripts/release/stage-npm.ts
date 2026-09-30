#!/usr/bin/env bun
/**
 * stage-npm.ts — stage the canonical public npm plan produced by `pack-all.ts`.
 *
 * npm trusted-publisher tokens are short-lived and cannot call `npm stage list`,
 * so retries classify only npm's explicit already-staged or immutable-version
 * errors. A duplicate is a skip, but not proof that the staged tarball is equal,
 * so the maintainer approving the stage on npmjs.com has to check the artifact.
 */

import { join } from "node:path";

import {
  type CommandRunner,
  executeNpmPlan,
  type NpmPlanLogger,
  type NpmPlanSummary,
} from "./execute-npm-plan";
import { PACKAGE_REGISTRIES, PUBLIC_PACKAGE_REGISTRY } from "./package-registries";
import { distTagFor, OUT_DIR, planFor, type PlanEntry } from "./publish-plan";

/**
 * npm errors that say this package version is already staged or is immutable.
 * Bare conflicts and generic "already exists" text are intentionally excluded.
 */
export function isNpmStageDuplicate(text: string): boolean {
  const alreadyStaged = /\b(?:package(?:\s+version)?|version)\b[^\r\n]*\bis already staged\b/i;
  const immutableVersion =
    /\b(?:you cannot publish over the previously published versions?:[^\r\n]*\d+\.\d+\.\d+|version\s+["']?\d+\.\d+\.\d+[0-9A-Za-z.+-]*["']?\s+is immutable)\b/i;
  return alreadyStaged.test(text) || immutableVersion.test(text);
}

export function stageNpmPackages(
  entries: readonly PlanEntry[],
  run?: CommandRunner,
  logger?: NpmPlanLogger,
): Promise<NpmPlanSummary> {
  return executeNpmPlan(
    entries,
    {
      operation: "stage",
      // Deliberately omit `--provenance`: npm provenance would expose the
      // source repository, which is private.
      command: ({ tarball, version }) => [
        "npm",
        "stage",
        "publish",
        join(OUT_DIR, tarball),
        "--registry",
        PACKAGE_REGISTRIES[PUBLIC_PACKAGE_REGISTRY].ts,
        "--access",
        "public",
        "--tag",
        distTagFor(version),
      ],
      isDuplicate: isNpmStageDuplicate,
      duplicateMessage: ({ name, version }) =>
        `::warning::SKIPPED duplicate npm stage for ${name}@${version}. npm reports that this version is already staged or immutable; artifact equality was NOT verified. Inspect the staged npm artifact before approving it on npmjs.com.`,
    },
    run,
    logger,
  );
}

async function main(): Promise<void> {
  await stageNpmPackages(planFor(PUBLIC_PACKAGE_REGISTRY));
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
