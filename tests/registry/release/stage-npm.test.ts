import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { type CommandResult, type NpmPlanLogger } from "../../../scripts/release/execute-npm-plan";
import {
  PACKAGE_REGISTRIES,
  PUBLIC_PACKAGE_REGISTRY,
} from "../../../scripts/release/package-registries";
import { isNpmStageDuplicate, stageNpmPackages } from "../../../scripts/release/stage-npm";
import { OUT_DIR, type PlanEntry } from "../../../scripts/release/publish-plan";

const CAPABILITY_PACKAGE = "@mistralai-capabilities/feature-chat";
const SHARED_PACKAGE = "@mistralai-capabilities/registry";

function entry(name: string, version = "1.0.0"): PlanEntry {
  return { name, version, tarball: `${name.split("/").at(-1)}-${version}.tgz` };
}

function result(exitCode: number, stderr = "", stdout = ""): CommandResult {
  return { exitCode, stderr, stdout };
}

function recordingLogger() {
  const logs: string[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];
  const logger: NpmPlanLogger = {
    log: (message) => logs.push(message),
    warn: (message) => warnings.push(message),
    error: (message) => errors.push(message),
  };
  return { logger, logs, warnings, errors };
}

describe("npm staged publishing", () => {
  test("stages every planned artifact with the required public arguments", async () => {
    const commands: string[][] = [];
    // Capability names are kind-qualified; shared packages such as `registry`
    // remain unqualified by kind. Staging consumes both names without rebuilding
    // either one from a bare capability id.
    const first = entry(CAPABILITY_PACKAGE);
    const second = entry(SHARED_PACKAGE, "1.0.1-rc42");

    const summary = await stageNpmPackages([first, second], async (command) => {
      commands.push([...command]);
      return result(0);
    });

    expect(summary).toEqual({ succeeded: 2, skipped: 0 });
    expect(commands).toEqual([
      [
        "npm",
        "stage",
        "publish",
        join(OUT_DIR, first.tarball),
        "--registry",
        PACKAGE_REGISTRIES[PUBLIC_PACKAGE_REGISTRY].ts,
        "--access",
        "public",
        "--tag",
        "latest",
      ],
      [
        "npm",
        "stage",
        "publish",
        join(OUT_DIR, second.tarball),
        "--registry",
        PACKAGE_REGISTRIES[PUBLIC_PACKAGE_REGISTRY].ts,
        "--access",
        "public",
        "--tag",
        "rc",
      ],
    ]);
  });

  test("bounds concurrency within a wave and waits before the next group", async () => {
    const calls: string[] = [];
    const firstBatch = Promise.withResolvers<void>();
    const execution = stageNpmPackages(
      [
        { ...entry(CAPABILITY_PACKAGE), publishGroup: 0 },
        { ...entry(SHARED_PACKAGE), publishGroup: 0 },
        { ...entry("@mistralai-capabilities/feature-search"), publishGroup: 0 },
        { ...entry("@mistralai-capabilities/feature-speech"), publishGroup: 0 },
        { ...entry("@mistralai-capabilities/feature-agents"), publishGroup: 0 },
        { ...entry("@mistralai-capabilities/feature-evals"), publishGroup: 1 },
      ],
      async (command) => {
        calls.push(command[3]!);
        if (calls.length <= 3) await firstBatch.promise;
        return result(0);
      },
    );

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toHaveLength(3);
    firstBatch.resolve();
    await expect(execution).resolves.toEqual({ succeeded: 6, skipped: 0 });
    expect(calls).toHaveLength(6);
    expect(calls.at(-1)).toContain("feature-evals");
  });

  test("classifies only explicit already-staged or immutable-version errors as duplicates", () => {
    expect(
      isNpmStageDuplicate("npm error code E409\nnpm error Package version 1.2.3 is already staged"),
    ).toBe(true);
    expect(
      isNpmStageDuplicate(
        "npm error 403 You cannot publish over the previously published versions: 1.2.3.",
      ),
    ).toBe(true);
    expect(isNpmStageDuplicate("npm error Version 1.2.3 is immutable")).toBe(true);
    expect(isNpmStageDuplicate("npm error 409 Conflict")).toBe(false);
    expect(isNpmStageDuplicate("npm error package already exists")).toBe(false);
    expect(isNpmStageDuplicate("npm error credentials already staged for rotation")).toBe(false);
    expect(
      isNpmStageDuplicate("npm error package upload failed because credentials are already staged"),
    ).toBe(false);
    expect(isNpmStageDuplicate("npm error version metadata is immutable")).toBe(false);
    expect(isNpmStageDuplicate("npm error version lookup failed: permission denied")).toBe(false);
  });

  test("warns loudly for a duplicate and continues staging later artifacts", async () => {
    const calls: string[] = [];
    const { logger, warnings } = recordingLogger();
    const summary = await stageNpmPackages(
      [entry(CAPABILITY_PACKAGE), entry(SHARED_PACKAGE)],
      async (command) => {
        calls.push(command[3]!);
        return calls.length === 1
          ? result(1, "npm error Package version 1.0.0 is already staged")
          : result(0);
      },
      logger,
    );

    expect(summary).toEqual({ succeeded: 1, skipped: 1 });
    expect(calls).toHaveLength(2);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("artifact equality was NOT verified");
    expect(warnings[0]).toContain("before approving it on npmjs.com");
  });

  test("continues after failures and aggregates every failed package", async () => {
    const calls: string[] = [];
    const { logger, errors } = recordingLogger();
    const promise = stageNpmPackages(
      [
        entry("@mistralai-capabilities/base-core"),
        entry(SHARED_PACKAGE),
        entry("@mistralai-capabilities/backend-fastapi"),
      ],
      async (command) => {
        calls.push(command[3]!);
        if (calls.length === 2) return result(0);
        return result(1, `unrelated failure ${calls.length}`);
      },
      logger,
    );

    await expect(promise).rejects.toThrow(
      "2 package(s) failed to stage: @mistralai-capabilities/base-core@1.0.0, @mistralai-capabilities/backend-fastapi@1.0.0",
    );
    expect(calls).toHaveLength(3);
    expect(errors).toHaveLength(2);
  });

  test("rejects an empty plan before invoking npm", async () => {
    let called = false;
    await expect(
      stageNpmPackages([], async () => {
        called = true;
        return result(0);
      }),
    ).rejects.toThrow("npm stage plan is empty");
    expect(called).toBe(false);
  });
});
