#!/usr/bin/env bun
/**
 * Canonical release artifact build: apply every publication transform, then build both ecosystems.
 * Release CI runs this in its ephemeral checkout. Other callers that must preserve their checkout,
 * such as the public-artifact compliance check, run it in a temporary copy.
 *
 *   bun scripts/release/build-artifacts.ts <version>
 */

import { spawn } from "node:child_process";
import { join } from "node:path";

export async function buildArtifacts(root: string, version: string): Promise<void> {
  const stages: { label: string; script: string; args: string[] }[] = [
    {
      label: "prepare npm packages",
      script: "prepare-publish.ts",
      args: [version],
    },
    {
      label: "prepare Python packages",
      script: "prepare-publish-python.ts",
      args: [version],
    },
    { label: "pack npm packages", script: "pack-all.ts", args: [version] },
    {
      // Python always builds the complete internal set plus its manifest-filtered
      // public subset. A registry target must never turn the internal build into
      // a filtered one.
      label: "build Python packages",
      script: "build-python.ts",
      args: [version],
    },
  ];

  for (const stage of stages) {
    console.log(`\n==> ${stage.label}`);
    const child = spawn(
      process.execPath,
      [join("scripts", "release", stage.script), ...stage.args],
      {
        cwd: root,
        stdio: "inherit",
      },
    );
    const exitCode = await new Promise<number>((resolvePromise, reject) => {
      child.on("error", reject);
      child.on("close", (code) => resolvePromise(code ?? 1));
    });
    if (exitCode !== 0) {
      throw new Error(`${stage.script} failed with exit code ${exitCode}`);
    }
  }
}

if (import.meta.main) {
  const [version, extra] = process.argv.slice(2);
  if (!version || extra !== undefined) {
    console.error("usage: build-artifacts.ts <version>");
    process.exit(1);
  }
  try {
    await buildArtifacts(process.cwd(), version);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
