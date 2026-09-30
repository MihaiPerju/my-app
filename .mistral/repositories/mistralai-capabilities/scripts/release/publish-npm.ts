#!/usr/bin/env bun
/**
 * publish-npm.ts — publish one internal registry's canonical tarball plan.
 * Auth is ambient: callers write `.npmrc` or export `NPM_CONFIG_*`; no credential
 * passes on the command line. Re-running first checks for the exact version and
 * also treats a publish race's immutable-version rejection as an idempotent skip.
 *
 *   bun scripts/release/publish-npm.ts <registry-id> <upload-url>
 */

import { join } from "node:path";

import {
  type CommandRunner,
  executeNpmPlan,
  type NpmPlanLogger,
  type NpmPlanSummary,
} from "./execute-npm-plan";
import {
  isPackageRegistryId,
  PACKAGE_REGISTRIES,
  type PackageRegistryId,
} from "./package-registries";
import { distTagFor, OUT_DIR, planFor, type PlanEntry } from "./publish-plan";

/** A rejection meaning this exact package version is already immutable. */
export function isNpmAlreadyPublished(text: string): boolean {
  return (
    /\b409 conflict\b/i.test(text) ||
    /version already exists/i.test(text) ||
    /EPUBLISHCONFLICT/i.test(text) ||
    /cannot publish over/i.test(text)
  );
}

export function publishNpmPackages(
  entries: readonly PlanEntry[],
  registry: string,
  run?: CommandRunner,
  logger?: NpmPlanLogger,
): Promise<NpmPlanSummary> {
  return executeNpmPlan(
    entries,
    {
      operation: "publish",
      command: ({ tarball, version }) => [
        "npm",
        "publish",
        join(OUT_DIR, tarball),
        "--registry",
        registry,
        "--tag",
        distTagFor(version),
      ],
      preflight: {
        command: ({ name, version }) => [
          "npm",
          "view",
          `${name}@${version}`,
          "version",
          "--registry",
          registry,
        ],
        isComplete: (result, { version }) =>
          result.exitCode === 0 && result.stdout.trim() === version,
        completeMessage: ({ name, version }) =>
          `SKIPPED ${name}@${version} (already published on ${registry})`,
      },
      isDuplicate: isNpmAlreadyPublished,
      duplicateMessage: ({ name, version }) =>
        `SKIPPED ${name}@${version} (already published and immutable on ${registry})`,
    },
    run,
    logger,
  );
}

function internalRegistryId(value: string): PackageRegistryId {
  if (!isPackageRegistryId(value) || PACKAGE_REGISTRIES[value].audience !== "internal") {
    throw new Error(`'${value}' is not an internal package registry id`);
  }
  return value;
}

async function main(): Promise<void> {
  const [rawRegistryId, registry, extra] = process.argv.slice(2);
  if (!rawRegistryId || !registry || extra !== undefined) {
    throw new Error("usage: publish-npm.ts <registry-id> <upload-url>");
  }
  const registryId = internalRegistryId(rawRegistryId);
  await publishNpmPackages(planFor(registryId), registry);
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
