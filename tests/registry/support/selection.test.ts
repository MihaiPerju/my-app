import { describe, expect, test } from "bun:test";

import type { CapabilityManifest } from "../../../scripts/shared/manifests";
import { resolveSelection } from "./selection";

const capability = (
  kind: string,
  id: string,
  extra: Partial<CapabilityManifest> = {},
): CapabilityManifest => ({
  kind,
  id,
  path: `${kind}/${id}`,
  version: "0.0.0",
  packages: [],
  ...extra,
});

describe("static selection model", () => {
  test("recursively expands derived shorthand prerequisites without reverse-expanding activation", () => {
    const manifests = [
      capability("base", "core", { required: true }),
      capability("backend", "api", { dependencies: ["mistralai-capabilities/base/core"] }),
      capability("feature", "telemetry"),
      capability("deployment", "compose"),
      capability("deployment", "compose-api", {
        dependencies: ["feature/telemetry"],
        activatedWhen: { allOf: ["mistralai-capabilities/deployment/compose", "api"] },
      }),
      capability("deployment", "compose-api-plus", {
        activatedWhen: { allOf: ["compose-api"] },
      }),
    ];

    expect([...resolveSelection(["compose-api-plus"], manifests)].toSorted()).toEqual([
      "backend/api",
      "base/core",
      "deployment/compose",
      "deployment/compose-api",
      "deployment/compose-api-plus",
      "feature/telemetry",
    ]);
    expect([...resolveSelection(["compose-api"], manifests)].toSorted()).toEqual([
      "backend/api",
      "base/core",
      "deployment/compose",
      "deployment/compose-api",
      "deployment/compose-api-plus",
      "feature/telemetry",
    ]);
    expect([...resolveSelection(["compose", "api"], manifests)].toSorted()).toEqual([
      "backend/api",
      "base/core",
      "deployment/compose",
      "deployment/compose-api",
      "deployment/compose-api-plus",
      "feature/telemetry",
    ]);
    expect([...resolveSelection(["compose"], manifests)].toSorted()).toEqual([
      "base/core",
      "deployment/compose",
    ]);
  });
});
