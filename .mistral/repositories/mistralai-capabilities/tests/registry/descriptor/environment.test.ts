/** Environment-variable and lifecycle-command invariants. */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { capabilities, toLocalId } from "../support/selection";
import {
  capabilityDir,
  capabilityLocalIds,
  readJson,
  REGISTRY_ROOT,
} from "../support/template-tree";

const isString = (value: unknown): value is string => typeof value === "string";

describe("capability environment", () => {
  test("envVars is a flat map of strings", () => {
    for (const [id, capability] of capabilities) {
      for (const [name, value] of Object.entries(capability.envVars ?? {})) {
        expect(isString(value), `${id}.envVars.${name} is not a string`).toBe(true);
      }
    }
  });

  // Shared-system identifiers must be derived from the generated app name. One deliberate
  // exception: `INGESTION_COLLECTION_NAME` names a migration-owned table in the app's own database.
  test("no envVar default hardcodes the registry's name where the app's belongs", () => {
    const registryId = readJson<{ id: string }>(join(REGISTRY_ROOT, "registry.json")).id;
    // `mistralai_capabilities` is the same identity in snake_case, from the package namespace.
    const aliases = [registryId, registryId.replace(/-/g, "_"), "mistralai_capabilities"];
    // Frozen to the registry name by design (see above); a migration-owned table cannot be templated.
    const frozenToRegistry = { INGESTION_COLLECTION_NAME: true };
    const fromManifests = [...capabilities]
      .flatMap(([id, capability]) =>
        Object.entries(capability.envVars ?? {}).map(([n, v]) => [id, n, v] as const),
      )
      .filter(
        ([, name, value]) =>
          !Object.hasOwn(frozenToRegistry, name) && aliases.some((alias) => value.includes(alias)),
      )
      .map(([id, name, value]) => `${id}.envVars.${name} = "${value}"`);
    expect(
      fromManifests,
      "derive these from {{app_name}} so two generated apps cannot collide",
    ).toEqual([]);
  });

  // The CLI merges envVars across the selected set and the first declaration wins, so a name
  // declared twice with two different defaults makes the generated `.env` depend on install order.
  // `env/idp.py` already asks, in a comment, that its storage fields stay identical to
  // `env/ingestion.py`'s; this is that comment as a test.
  test("an envVar declared by several capabilities has one default", () => {
    const byName = new Map<string, Map<string, string[]>>();
    for (const [id, capability] of capabilities) {
      for (const [name, value] of Object.entries(capability.envVars ?? {})) {
        const values = byName.get(name) ?? new Map<string, string[]>();
        values.set(value, [...(values.get(value) ?? []), id]);
        byName.set(name, values);
      }
    }
    const conflicts = [...byName]
      .filter(([, values]) => values.size > 1)
      .map(
        ([name, values]) =>
          `${name}: ${[...values].map(([value, ids]) => `"${value}" (${ids.join(", ")})`).join(" vs ")}`,
      )
      .toSorted();
    expect(conflicts, "install order would decide these").toEqual([]);
  });

  // `uv run` performs an implicit sync before starting a Python module. Without `--all-packages`,
  // that sync keeps only the current workspace member's dependencies and removes the capability
  // toolkits that API and worker discovery import from the shared environment.
  test("Python dev commands preserve every workspace package", () => {
    for (const id of capabilityLocalIds) {
      const manifest = readJson<{
        metadata?: { lifecycle?: { dev?: { startCommand?: string } } };
      }>(join(capabilityDir(id), "capability.json"));
      const command = manifest.metadata?.lifecycle?.dev?.startCommand;
      if (!command?.startsWith("uv run ")) continue;
      expect(
        command.startsWith("uv run --all-packages "),
        `${id}: uv run would strip other workspace packages`,
      ).toBe(true);
    }
  });
  test("workflows names its deployment queue once, per user", () => {
    const envVars = capabilities.get(toLocalId("workflows"))?.envVars;

    expect(envVars?.DEPLOYMENT_NAME).toBe("deployment-{{app_name}}-{{env:USER}}");
    expect(envVars?.DEPLOYMENT_NAME_DEPLOY).toBeUndefined();
  });

  // Seeding the platform builtin `nuage-session` made /chat bypass the app's own orchestrator and
  // every tool it assembles, silently. Blank resolves to DEPLOYMENT_NAME in `env/vibe_agents.py`.
  test("chat fronts this deployment's own agent by default", () => {
    const envVars = capabilities.get(toLocalId("chat"))?.envVars;
    const settings = readFileSync(
      join(capabilityDir("chat"), "template/packages/py/env/src/env/vibe_agents.py"),
      "utf8",
    );

    expect(envVars?.VIBE_AGENTS_AGENT_NAME).toBe("");
    expect(settings).toMatch(/^ {4}vibe_agents_agent_name: str = ""$/m);
  });
});
