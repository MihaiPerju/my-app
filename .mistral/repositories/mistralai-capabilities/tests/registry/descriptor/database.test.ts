/** Database declarations: what the CLI turns into a managed module in apps.json, and never into the descriptor. */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { DatabaseDeclarationSchema } from "../../../scripts/registry/build-registry";
import { readManifests } from "../../../scripts/shared/manifests";
import { readJson, REGISTRY_ROOT } from "../support/template-tree";

const manifests = readManifests(REGISTRY_ROOT);

describe("capability database", () => {
  test("only database/postgres declares one", () => {
    expect(
      manifests
        .filter((manifest) => manifest.database !== undefined)
        .map((manifest) => [manifest.path, manifest.database]),
    ).toEqual([["database/postgres", { engine: "postgres" }]]);
  });

  test.each([
    ["postgres", { engine: "postgres" }],
    ["postgres with extensions", { engine: "postgres", extensions: ["vector"] }],
  ])("accepts %s", (_, database) => {
    expect(DatabaseDeclarationSchema.safeParse(database).success).toBe(true);
  });

  test.each([
    ["another engine", { engine: "mysql" }],
    ["no engine", {}],
    ["an empty extension", { engine: "postgres", extensions: [""] }],
    ["an unknown key", { engine: "postgres", version: "16" }],
  ])("rejects %s", (_, database) => {
    expect(DatabaseDeclarationSchema.safeParse(database).success).toBe(false);
  });

  // Released CLIs parse descriptor rows strictly, so a `database` key there would fail every command.
  test("registry.json carries no database", () => {
    const descriptor = readJson<{ capabilities: { id: string; database?: unknown }[] }>(
      join(REGISTRY_ROOT, "registry.json"),
    );
    expect(descriptor.capabilities.filter((cap) => "database" in cap).map((cap) => cap.id)).toEqual(
      [],
    );
  });
});
