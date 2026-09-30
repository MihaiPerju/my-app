/** Pre-start declarations: what the CLI appends to a module's apps.json phases, and never to the descriptor. */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { PreStartDeclarationSchema } from "../../../scripts/registry/build-registry";
import { readManifests } from "../../../scripts/shared/manifests";
import { readJson, REGISTRY_ROOT } from "../support/template-tree";

const manifests = readManifests(REGISTRY_ROOT);

describe("capability preStart", () => {
  test("only deployment/apps-fastapi declares one", () => {
    expect(
      manifests
        .filter((manifest) => manifest.preStart !== undefined)
        .map((manifest) => manifest.path),
    ).toEqual(["deployment/apps-fastapi"]);
  });

  test.each([
    ["dev only", { dev: ["make seed"] }],
    ["deploy only", { deploy: ["make migrate"] }],
    ["both phases", { dev: ["a"], deploy: ["b", "c"] }],
  ])("accepts %s", (_, preStart) => {
    expect(PreStartDeclarationSchema.safeParse(preStart).success).toBe(true);
  });

  test.each([
    ["no phase", {}],
    ["an empty phase", { deploy: [] }],
    ["an empty command", { dev: [""] }],
    ["a string instead of a list", { deploy: "make migrate" }],
    ["an unknown phase", { build: ["make"] }],
  ])("rejects %s", (_, preStart) => {
    expect(PreStartDeclarationSchema.safeParse(preStart).success).toBe(false);
  });

  // Released CLIs parse descriptor rows strictly, so a `preStart` key there would fail every command.
  test("registry.json carries no preStart", () => {
    const descriptor = readJson<{ capabilities: { id: string }[] }>(
      join(REGISTRY_ROOT, "registry.json"),
    );
    expect(descriptor.capabilities.filter((cap) => "preStart" in cap).map((cap) => cap.id)).toEqual(
      [],
    );
  });
});
