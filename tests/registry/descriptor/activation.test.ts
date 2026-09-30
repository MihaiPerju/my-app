/**
 * Derived-activation and visibility contract of the descriptor build model.
 *
 * These exercise `buildDescriptor` directly with synthetic manifests (the one
 * canonical projection the CLI's `mistral apps registry build` mirrors), so the
 * strict `activatedWhen.allOf` shape, reference qualification, the activation
 * invariants (non-empty, unique, no self-reference, no cycles, no dependency
 * targeting a derived capability, no prerequisite duplicated as a dependency),
 * and `visible` default/serialization are pinned WITHOUT a descriptor version
 * bump — the exact authoring surface a registry author gains.
 */
import { describe, expect, test } from "bun:test";

import { buildDescriptor } from "../../../scripts/registry/build-registry";
import type { CapabilityManifest } from "../../../scripts/shared/manifests";
import type { JsonValue } from "../../../scripts/shared/manifests";
import { REGISTRY_ID } from "../support/registry-fixtures";
import { REGISTRY_ROOT } from "../support/template-tree";

/** A synthetic manifest at the canonical `<kind>/<id>` location; `extra` overrides any field. */
const cap = (
  id: string,
  kind: string,
  extra: Partial<CapabilityManifest> = {},
): CapabilityManifest => ({
  id,
  kind,
  path: `${kind}/${id}`,
  version: "0.0.0",
  packages: [],
  ...extra,
});

interface CapRow {
  id: string;
  kind: string;
  visible?: boolean;
  activatedWhen?: { allOf: string[] };
}

/** Build a descriptor from synthetic manifests against the repo's real kinds/config. */
const build = (manifests: CapabilityManifest[]): CapRow[] => {
  // SAFETY: buildDescriptor emits the versioned descriptor envelope; this test owns and validates
  // the supplied manifests, so the parsed capabilities collection has the declared row shape.
  const descriptor = JSON.parse(buildDescriptor(REGISTRY_ROOT, manifests)) as {
    capabilities: CapRow[];
  };
  return descriptor.capabilities;
};

const rowFor = (rows: CapRow[], kind: string, id: string): CapRow => {
  const row = rows.find((r) => r.kind === kind && r.id === id);
  if (row === undefined) throw new Error(`no descriptor row for ${kind}/${id}`);
  return row;
};

// The ordinary capabilities every derived fixture is composed against.
const core = cap("core", "base", { required: true });
const dockerCompose = cap("docker-compose", "deployment");
const fastapi = cap("fastapi", "backend", { dependencies: ["core"] });

describe("descriptor activation + visibility", () => {
  test("qualifies, de-duplicates order-independently, and sorts activatedWhen.allOf", () => {
    const derived = cap("docker-compose-api", "deployment", {
      visible: false,
      // authored bare and out of order — the descriptor must qualify + sort
      activatedWhen: { allOf: ["fastapi", "docker-compose"] },
    });
    const rows = build([core, dockerCompose, fastapi, derived]);
    expect(rowFor(rows, "deployment", "docker-compose-api").activatedWhen).toEqual({
      allOf: [`${REGISTRY_ID}/backend/fastapi`, `${REGISTRY_ID}/deployment/docker-compose`],
    });
  });

  test("accepts a kind-qualified activation reference identical to a bare one", () => {
    const derived = cap("d", "deployment", {
      activatedWhen: { allOf: ["deployment/docker-compose"] },
    });
    expect(rowFor(build([core, dockerCompose, derived]), "deployment", "d").activatedWhen).toEqual({
      allOf: [`${REGISTRY_ID}/deployment/docker-compose`],
    });
  });

  test("emits visible:false only when authored false; omits the true default", () => {
    const hidden = cap("hidden", "deployment", {
      visible: false,
      activatedWhen: { allOf: ["docker-compose"] },
    });
    const explicitTrue = cap("shown", "deployment", { visible: true });
    const rows = build([core, dockerCompose, hidden, explicitTrue]);
    expect(rowFor(rows, "deployment", "hidden").visible).toBe(false);
    // default true (authored true OR absent) is dropped from the serialized row
    expect("visible" in rowFor(rows, "deployment", "shown")).toBe(false);
    expect("visible" in rowFor(rows, "deployment", "docker-compose")).toBe(false);
    expect("visible" in rowFor(rows, "base", "core")).toBe(false);
  });

  test("ordinary capabilities carry no activatedWhen", () => {
    const rows = build([core, dockerCompose, fastapi]);
    expect("activatedWhen" in rowFor(rows, "deployment", "docker-compose")).toBe(false);
    expect("activatedWhen" in rowFor(rows, "backend", "fastapi")).toBe(false);
  });

  test("carries derived activation within the current descriptor version (no bump)", () => {
    const derived = cap("derived", "deployment", {
      activatedWhen: { allOf: ["docker-compose"] },
    });
    // SAFETY: buildDescriptor emits the versioned descriptor envelope owned by this test.
    const descriptor = JSON.parse(
      buildDescriptor(REGISTRY_ROOT, [core, dockerCompose, derived]),
    ) as { descriptorVersion: number };
    expect(descriptor.descriptorVersion).toBe(3);
  });

  describe("rejects malformed activation rules", () => {
    const derived = (activatedWhen: JsonValue): CapabilityManifest => {
      // SAFETY: JSON round-tripping models an authored manifest crossing the repository parser;
      // malformed values intentionally exercise build-time validation.
      return JSON.parse(
        JSON.stringify({ ...cap("d", "deployment"), activatedWhen }),
      ) as CapabilityManifest;
    };
    const buildWith = (activatedWhen: JsonValue) => () =>
      build([core, dockerCompose, fastapi, derived(activatedWhen)]);
    test("empty allOf", () => expect(buildWith({ allOf: [] })).toThrow("activatedWhen"));
    test("a non-allOf key (no anyOf/negation)", () =>
      expect(buildWith({ anyOf: ["docker-compose"] })).toThrow("activatedWhen"));
    test("an extra key alongside allOf", () =>
      expect(buildWith({ allOf: ["docker-compose"], anyOf: ["core"] })).toThrow("activatedWhen"));
    test("a non-object activatedWhen", () =>
      expect(buildWith("docker-compose")).toThrow("activatedWhen"));
    test("a non-string reference", () =>
      expect(buildWith({ allOf: [1] })).toThrow("activatedWhen"));
  });

  describe("rejects invalid activation references", () => {
    const derived = (allOf: string[]): CapabilityManifest =>
      cap("d", "deployment", { activatedWhen: { allOf } });
    test("duplicate references (bare and qualified resolve to one identity)", () => {
      expect(() =>
        build([core, dockerCompose, derived(["docker-compose", "deployment/docker-compose"])]),
      ).toThrow("activation references must be unique");
    });
    test("a self-reference", () =>
      expect(() => build([core, dockerCompose, derived(["d", "docker-compose"])])).toThrow(
        "references itself",
      ));
    test("an ambiguous bare reference", () => {
      const dupA = cap("dup", "backend");
      const dupB = cap("dup", "database");
      expect(() =>
        build([core, dockerCompose, dupA, dupB, derived(["dup", "docker-compose"])]),
      ).toThrow("ambiguous capability reference");
    });
    test("an unknown reference", () =>
      expect(() => build([core, dockerCompose, derived(["nope", "docker-compose"])])).toThrow(
        "unknown capability reference",
      ));
  });

  describe("rejects activation/dependency conflation", () => {
    const integration = cap("integration", "deployment", {
      activatedWhen: { allOf: ["docker-compose", "fastapi"] },
    });
    test("an ordinary dependency targeting a derived capability", () => {
      const consumer = cap("consumer", "feature", { dependencies: ["integration"] });
      expect(() => build([core, dockerCompose, fastapi, integration, consumer])).toThrow(
        "ordinary dependency on derived capability",
      );
    });
    test("a prerequisite duplicated under dependencies", () => {
      const bad = cap("bad", "deployment", {
        activatedWhen: { allOf: ["docker-compose", "fastapi"] },
        dependencies: ["fastapi"],
      });
      expect(() => build([core, dockerCompose, fastapi, bad])).toThrow(
        "must not be duplicated as a dependency",
      );
    });
  });

  test("rejects an activation cycle across derived capabilities", () => {
    const a = cap("a", "deployment", { activatedWhen: { allOf: ["b", "docker-compose"] } });
    const b = cap("b", "deployment", { activatedWhen: { allOf: ["a", "docker-compose"] } });
    expect(() => build([core, dockerCompose, a, b])).toThrow("activation cycle detected");
  });

  test("rejects a non-boolean visible", () => {
    // SAFETY: JSON round-tripping models an authored manifest crossing the repository parser;
    // the malformed visibility value intentionally exercises build-time validation.
    const bad = JSON.parse(
      JSON.stringify({ ...cap("d", "deployment"), visible: "no" }),
    ) as CapabilityManifest;
    expect(() => build([core, dockerCompose, bad])).toThrow("expected boolean");
  });

  test("allows a chained derived capability whose prerequisite is itself derived", () => {
    // docker-compose + fastapi -> api integration; api integration + docker-compose -> a second stage.
    const api = cap("dc-api", "deployment", {
      activatedWhen: { allOf: ["docker-compose", "fastapi"] },
    });
    const stage2 = cap("dc-api-plus", "deployment", {
      activatedWhen: { allOf: ["dc-api", "docker-compose"] },
    });
    const rows = build([core, dockerCompose, fastapi, api, stage2]);
    expect(rowFor(rows, "deployment", "dc-api-plus").activatedWhen).toEqual({
      allOf: [`${REGISTRY_ID}/deployment/dc-api`, `${REGISTRY_ID}/deployment/docker-compose`],
    });
  });
});
